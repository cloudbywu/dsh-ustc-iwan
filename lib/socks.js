/**
 * 极简 SOCKS5 CONNECT 客户端（无认证），专门对接 ustc-iwan 的 --socks 模式。
 * 支持 IPv4 地址目标与域名目标（域名交给 iWAN 在校内解析，避开本机 DNS 被 TUN 接管的问题）。
 */
import net from 'node:net'

/** 把域名字符串转成 SOCKS5 的 ATYP=0x03 地址段（非 ASCII 时借 URL 做punycode）。 */
function encodeHost(host) {
  let ascii = host
  if (/[^\x21-\x7e]/.test(host)) {
    try {
      ascii = new URL('http://' + host).hostname
    } catch {
      ascii = host
    }
  }
  const bytes = Buffer.from(ascii, 'ascii')
  return Buffer.concat([Buffer.from([bytes.length]), bytes])
}

function buildConnectRequest(host, port) {
  const head = Buffer.from([0x05, 0x01, 0x00, net.isIPv4(host) ? 0x01 : 0x03])
  const addr = net.isIPv4(host)
    ? Buffer.from(host.split('.').map(Number))
    : encodeHost(host)
  const portBytes = Buffer.from([(port >> 8) & 0xff, port & 0xff])
  return Buffer.concat([head, addr, portBytes])
}

const SOCKS_ERRORS = {
  0x01: '一般性失败',
  0x02: '规则不允许',
  0x03: '网络不可达',
  0x04: '目标主机不可达',
  0x05: '连接被拒绝',
  0x06: 'TTL 过期',
  0x07: '不支持的命令',
  0x08: '不支持的地址类型',
}

/**
 * 通过 SOCKS5 代理建立到 targetHost:targetPort 的 CONNECT 隧道。
 * 成功 resolve 一个已就绪的 net.Socket；失败 reject（socket 已销毁）。
 */
export function socksConnect({
  proxyHost = '127.0.0.1',
  proxyPort = 1080,
  targetHost,
  targetPort,
  timeoutMs = 15000,
} = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxyHost, port: proxyPort })
    socket.setTimeout(timeoutMs)
    let stage = 'connecting'
    let settled = false
    let buffer = Buffer.alloc(0)

    const fail = (err) => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(err instanceof Error ? err : new Error(String(err)))
    }
    const succeed = () => {
      if (settled) return
      settled = true
      socket.setTimeout(0)
      socket.removeListener('data', onData)
      resolve(socket)
    }

    socket.on('timeout', () => fail(new Error(`连接 SOCKS5 ${proxyHost}:${proxyPort} 超时`)))
    socket.on('error', (err) => fail(stage === 'established' ? err : err))
    socket.once('connect', () => {
      stage = 'greeting'
      socket.write(Buffer.from([0x05, 0x01, 0x00]))
    })

    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk])
      if (stage === 'greeting') {
        if (buffer.length < 2) return
        if (buffer[0] !== 0x05 || buffer[1] !== 0x00) {
          return fail(new Error('SOCKS5 握手被拒绝（不支持无认证方式？）'))
        }
        buffer = buffer.subarray(2)
        stage = 'request'
        socket.write(buildConnectRequest(targetHost, targetPort))
        return
      }
      if (stage !== 'request') return
      if (buffer.length < 2) return
      if (buffer[0] !== 0x05) return fail(new Error('SOCKS5 应答版本异常'))
      if (buffer[1] !== 0x00) {
        const why = SOCKS_ERRORS[buffer[1]] ?? `错误码 ${buffer[1]}`
        return fail(new Error(`SOCKS5 CONNECT 失败：${why}`))
      }
      const atyp = buffer[3]
      let need = -1
      if (atyp === 0x01) need = 4 + 4 + 2
      else if (atyp === 0x03) {
        if (buffer.length < 5) return
        need = 4 + 1 + buffer[4] + 2
      } else if (atyp === 0x04) need = 4 + 16 + 2
      else return fail(new Error('SOCKS5 应答地址类型未知'))
      if (buffer.length < need) return
      stage = 'established'
      const rest = buffer.subarray(need)
      if (rest.length) socket.unshift(rest)
      succeed()
    }

    socket.on('data', onData)
  })
}
