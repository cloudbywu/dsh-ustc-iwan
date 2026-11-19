/** 无认证 SOCKS5 CONNECT；成功返回暂停的 socket，由调用者接管读取。 */
import net from 'node:net'
import { domainToASCII } from 'node:url'

function connectRequest(host, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SOCKS5 目标端口无效')
  if (typeof host !== 'string' || !host) throw new Error('SOCKS5 目标主机无效')
  host = host.replace(/^\[|\]$/g, '')
  let atyp, addr
  if (net.isIPv4(host)) {
    atyp = 1
    addr = Buffer.from(host.split('.').map(Number))
  } else if (net.isIPv6(host)) {
    atyp = 4
    // URL 规范化 IPv4-mapped IPv6，随后展开 ::。
    const normalized = new URL(`http://[${host}]/`).hostname.slice(1, -1)
    const [left, right = ''] = normalized.split('::')
    const a = left ? left.split(':') : []
    const b = right ? right.split(':') : []
    const words = [...a, ...Array(8 - a.length - b.length).fill('0'), ...b]
    addr = Buffer.alloc(16)
    words.forEach((word, i) => addr.writeUInt16BE(parseInt(word, 16), i * 2))
  } else {
    atyp = 3
    const ascii = domainToASCII(host)
    if (!ascii || /[\s/:@\[\]]/.test(ascii)) throw new Error('SOCKS5 目标域名无效')
    const bytes = Buffer.from(ascii, 'ascii')
    if (!bytes.length || bytes.length > 255) throw new Error('SOCKS5 目标域名过长')
    addr = Buffer.concat([Buffer.from([bytes.length]), bytes])
  }
  const tail = Buffer.alloc(2)
  tail.writeUInt16BE(port)
  return Buffer.concat([Buffer.from([5, 1, 0, atyp]), addr, tail])
}

/** 只描述 SOCKS 建立期错误；成功交接后绝不用于重放业务流。 */
export class SocksConnectError extends Error {
  constructor(error, phase, retryable = false) {
    super(error.message, { cause: error })
    this.name = 'SocksConnectError'
    this.phase = phase
    this.retryable = retryable
    if (error.code) this.code = error.code
  }
}
const transportCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE'])

export function socksConnect({
  proxyHost = '127.0.0.1', proxyPort = 1080, targetHost, targetPort,
  timeoutMs = 15000, signal, unref = false,
} = {}) {
  return new Promise((resolve, reject) => {
    let request
    try { request = connectRequest(targetHost, targetPort) } catch (err) { reject(new SocksConnectError(err, 'validation')); return }
    if (signal?.aborted) { reject(new SocksConnectError(signal.reason instanceof Error ? signal.reason : new Error('SOCKS5 连接已取消'), 'abort')); return }
    let socket
    try { socket = net.connect({ host: proxyHost, port: proxyPort }) } catch (err) { reject(new SocksConnectError(err, 'connect')); return }
    let stage = 'connect', settled = false, buffer = Buffer.alloc(0)
    const timer = setTimeout(() => fail(new Error('SOCKS5 连接/握手超时')), timeoutMs)
    if (unref) {
      socket.unref()
      socket.on('connectionAttempt', socket.unref)
      timer.unref()
    }
    const cleanup = () => {
      clearTimeout(timer)
      if (unref) socket.removeListener('connectionAttempt', socket.unref)
      for (const [event, fn] of [['data', onData], ['error', onError], ['end', onEnd], ['close', onEnd], ['connect', onConnect]]) socket.removeListener(event, fn)
      signal?.removeEventListener('abort', onAbort)
    }
    const fail = (err, retryable = false, phase = stage) => {
      if (settled) return
      settled = true
      cleanup()
      // destroy 后排队的 error 不得成为未处理异常。
      socket.on('error', () => {})
      socket.destroy()
      reject(new SocksConnectError(err instanceof Error ? err : new Error(String(err)), phase, retryable))
    }
    const onError = (err) => fail(err, transportCodes.has(err.code))
    const onEnd = () => fail(new Error('SOCKS5 握手结束前连接已关闭'), true)
    const onAbort = () => fail(signal.reason ?? new Error('SOCKS5 连接已取消'), false, 'abort')
    const onConnect = () => {
      if (unref) socket.unref()
      stage = 'greeting'
      socket.write(Buffer.from([5, 1, 0]))
    }
    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk])
      if (stage === 'greeting') {
        if (buffer.length >= 1 && buffer[0] !== 5) return fail(new Error('SOCKS5 握手被拒绝：版本无效'))
        if (buffer.length < 2) return
        if (buffer[1] !== 0) return fail(new Error('SOCKS5 握手被拒绝'))
        buffer = buffer.subarray(2)
        stage = 'reply'
        socket.write(request)
      }
      if ((buffer.length >= 1 && buffer[0] !== 5) || (buffer.length >= 3 && buffer[2] !== 0)) return fail(new Error('SOCKS5 应答格式异常'))
      if (buffer.length >= 2 && buffer[1] !== 0) return fail(new Error(`SOCKS5 CONNECT 失败：错误码 ${buffer[1]}`))
      if (buffer.length < 4) return
      const atyp = buffer[3]
      let need
      if (atyp === 1) need = 10
      else if (atyp === 4) need = 22
      else if (atyp === 3) {
        if (buffer.length < 5) return
        if (!buffer[4]) return fail(new Error('SOCKS5 应答域名为空'))
        need = 7 + buffer[4]
      } else return fail(new Error('SOCKS5 应答地址类型未知'))
      if (buffer.length < need) return
      // 必须先暂停，再去除握手监听器和回塞业务尾数据。
      socket.pause()
      settled = true
      cleanup()
      const rest = buffer.subarray(need)
      if (rest.length) socket.unshift(rest)
      resolve(socket)
    }
    socket.on('data', onData)
    socket.once('connect', onConnect)
    socket.once('error', onError)
    socket.once('end', onEnd)
    socket.once('close', onEnd)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
