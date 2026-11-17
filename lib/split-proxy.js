/** 本地 HTTP 分流代理：CONNECT 隧道及 HTTP absolute/origin-form 请求。 */
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { socksConnect } from './socks.js'

const unbracket = (host) => host.replace(/^\[|\]$/g, '')
const authority = (host, port) => `${net.isIPv6(host) ? `[${host}]` : host}:${port}`

function parseTarget(raw, fallbackPort) {
  const m = /^(?:\[([^\]]+)\]|([^\s:/?#@]+))(?::(\d+))?$/.exec(String(raw ?? ''))
  if (!m || (m[1] && !net.isIPv6(m[1]))) return null
  const port = m[3] === undefined ? fallbackPort : Number(m[3])
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host: (m[1] ?? m[2]).toLowerCase(), port }
}

function waitFor(value, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort)
    const abort = () => { cleanup(); reject(signal.reason ?? new Error('连接已取消')) }
    if (signal.aborted) return abort()
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(value).then(result => { cleanup(); resolve(result) }, error => { cleanup(); reject(error) })
  })
}

const localSocks = (host = '127.0.0.1') => {
  const ip = unbracket(host)
  return (net.isIPv4(ip) && ip.startsWith('127.')) || ip === '::1'
}
const retryDelays = [100, 200, 400, 800, 800, 600]
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort) }
    const abort = () => { cleanup(); reject(signal.reason ?? new Error('连接已取消')) }
    const timer = setTimeout(() => { cleanup(); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

/** 一个总时限覆盖 TCP/TLS 连接及 CONNECT 握手，不能被碎片应答无限延长。 */
function connectSocket(host, port, { signal, proxyUrl, maxHeaderBytes, timeoutMs }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    let u, auth = ''
    try {
      if (proxyUrl) {
        u = new URL(proxyUrl)
        if (!['http:', 'https:'].includes(u.protocol)) throw new Error('上游代理仅支持 HTTP/HTTPS')
        if (u.username || u.password) auth = `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}\r\n`
      }
    } catch (err) { reject(err); return }
    const options = u ? { host: unbracket(u.hostname), port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80) } : { host, port }
    const secure = u?.protocol === 'https:'
    if (secure && !net.isIP(options.host)) options.servername = options.host
    const socket = secure ? tls.connect(options) : net.connect(options)
    let buffer = Buffer.alloc(0), settled = false
    const timer = setTimeout(() => fail(new Error('代理连接/握手超时')), timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      for (const [event, fn] of [['data', onData], ['error', fail], ['end', ended], ['close', ended], [secure ? 'secureConnect' : 'connect', ready]]) socket.removeListener(event, fn)
      signal.removeEventListener('abort', abort)
    }
    const fail = (err) => {
      if (settled) return
      settled = true
      cleanup()
      socket.destroy()
      reject(err)
    }
    const abort = () => fail(signal.reason ?? new Error('连接已取消'))
    const ended = () => fail(new Error('连接/握手完成前上游已关闭'))
    const success = (rest) => {
      socket.pause()
      settled = true
      cleanup()
      if (rest?.length) socket.unshift(rest)
      resolve(socket)
    }
    function ready() {
      if (!u) return success()
      const target = authority(host, port)
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`)
    }
    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf('\r\n\r\n')
      if ((end < 0 && buffer.length > maxHeaderBytes) || end + 4 > maxHeaderBytes) return fail(new Error('上游 CONNECT 应答头过大'))
      if (end < 0) return
      const status = /^HTTP\/1\.[01] ([0-9]{3})(?:[ \r]|$)/.exec(buffer.toString('latin1', 0, end))
      if (!status || Number(status[1]) < 200 || Number(status[1]) >= 300) return fail(new Error(`上游代理 CONNECT 返回 ${status?.[1] ?? '无效应答'}`))
      success(buffer.subarray(end + 4))
    }
    socket.once(secure ? 'secureConnect' : 'connect', ready)
    if (u) socket.on('data', onData)
    socket.once('error', fail)
    socket.once('end', ended)
    socket.once('close', ended)
    signal.addEventListener('abort', abort, { once: true })
  })
}

export function startSplitProxy({
  port = 18118, listenHost = '127.0.0.1', decide, iwan, log = () => {}, verbose = false,
  timeoutMs = 15000, maxHeaderBytes = 16384, socksRetryWindowMs = 3000,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(socksRetryWindowMs) || socksRetryWindowMs < 0 || socksRetryWindowMs > 3000) throw new RangeError('代理连接时限无效')
  const sockets = new Set(), pending = new Set()
  let closing = false, closePromise
  const track = (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    // 避免取消/交接的微任务间隙出现无人处理的 socket error。
    socket.on('error', () => {})
    if (closing) socket.destroy()
    return socket
  }
  const openTunnel = async (host, port, client) => {
    const controller = new AbortController()
    const { signal } = controller
    const deadline = performance.now() + timeoutMs
    const remaining = () => {
      signal.throwIfAborted()
      const ms = deadline - performance.now()
      if (ms <= 0) { controller.abort(new Error('代理连接/握手超时')); signal.throwIfAborted() }
      return ms
    }
    const cancel = () => controller.abort(new Error('客户端或代理已关闭'))
    const timer = setTimeout(() => controller.abort(new Error('代理连接/握手超时')), timeoutMs)
    pending.add(controller)
    client.once('close', cancel)
    client.once('end', cancel)
    // 暂停的 CONNECT 流仍需处理空缓冲 FIN，不能等到恢复业务读取才取消。
    const checkEnd = () => client.read?.(0)
    client.on('readable', checkEnd)
    checkEnd()
    if (closing || client.destroyed) cancel()
    try {
      let route
      try { route = await waitFor(Promise.resolve().then(() => {
        signal.throwIfAborted()
        return decide(host)
      }), signal) } catch (err) {
        signal.throwIfAborted()
        route = { kind: 'direct' }
        log(`路由决策失败，按直连处理：${err?.message ?? err}`)
      }
      remaining()
      const options = () => ({ signal, maxHeaderBytes, timeoutMs: remaining() })
      if (route?.kind === 'upstream' && (typeof route.url !== 'string' || !route.url)) throw new Error('上游代理 URL 为空')
      let socket
      try {
        if (route?.kind === 'iwan') {
          // 只有本地 SOCKS 建立期可重拨；此处尚未发 CONNECT 200 或任何 HTTP 业务字节。
          const started = performance.now()
          const socksDeadline = deadline - Math.min(3000, remaining() / 3)
          const retryDeadline = Math.min(socksDeadline, started + socksRetryWindowMs)
          const canRetry = localSocks(iwan?.proxyHost)
          for (let attempt = 0; ; attempt++) {
            remaining()
            const budget = (attempt ? retryDeadline : socksDeadline) - performance.now()
            if (budget <= 0) throw new Error('SOCKS5 建立预算已耗尽')
            try {
              socket = await socksConnect({ ...iwan, targetHost: host, targetPort: port, timeoutMs: budget, signal })
              break
            } catch (err) {
              signal.throwIfAborted()
              const pause = retryDelays[attempt]
              if (!canRetry || err?.retryable !== true || pause === undefined || performance.now() + pause >= retryDeadline) throw err
              if (verbose) log(`本地 SOCKS 建立暂时失败（${err.message}），${pause}ms 后重试 (${attempt + 2}/${retryDelays.length + 1})`)
              await delay(pause, signal)
            }
          }
        } else socket = await connectSocket(host, port, { ...options(), proxyUrl: route?.kind === 'upstream' ? route.url : undefined })
      } catch (err) {
        signal.throwIfAborted()
        if (route?.kind !== 'iwan') throw err
        log(`iWAN 出口失败（${err?.message ?? err}），${host}:${port} 本次回退直连`)
        socket = await connectSocket(host, port, options())
      }
      track(socket)
      if (performance.now() >= deadline) controller.abort(new Error('代理连接/握手超时'))
      if (signal.aborted || closing || client.destroyed || socket.destroyed) {
        socket.destroy()
        throw signal.reason ?? new Error('连接已关闭')
      }
      if (verbose) log(`→ ${route?.kind ?? 'direct'} ${authority(host, port)}`)
      return socket
    } finally {
      clearTimeout(timer)
      client.removeListener('close', cancel)
      client.removeListener('end', cancel)
      client.removeListener('readable', checkEnd)
      pending.delete(controller)
    }
  }

  const server = http.createServer({ maxHeaderSize: maxHeaderBytes })
  server.on('connection', track)
  server.on('request', (req, res) => { void handleRequest(req, res).catch(() => res.destroy()) })
  server.on('connect', (req, client, head) => { void handleConnect(req, client, head).catch(() => client.destroy()) })
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    else socket.destroy()
  })

  async function handleConnect(req, client, head) {
    const target = parseTarget(req.url, 443)
    if (!target) { client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return }
    client.pause()
    let upstream
    try { upstream = await openTunnel(target.host, target.port, client) } catch (err) {
      log(`隧道建立失败：${err?.message ?? err}`)
      if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
      return
    }
    const teardown = () => { client.destroy(); upstream.destroy() }
    client.once('error', teardown)
    upstream.once('error', teardown)
    client.once('close', teardown)
    upstream.once('close', teardown)
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length) upstream.write(head)
    client.pipe(upstream)
    upstream.pipe(client)
  }

  async function handleRequest(req, res) {
    let u, target
    try {
      if (req.url.startsWith('/')) {
        const host = parseTarget(req.headers.host, 80)
        if (!host) throw new Error('无效 Host')
        u = new URL(`http://${authority(host.host, host.port)}${req.url}`)
      } else u = new URL(req.url)
      if (u.protocol !== 'http:' || u.username || u.password || !u.hostname) throw new Error('仅支持 HTTP 请求；HTTPS 请使用 CONNECT')
      target = { host: unbracket(u.hostname).toLowerCase(), port: Number(u.port) || 80 }
    } catch { res.writeHead(400).end('bad request'); return }
    req.once('aborted', () => res.destroy())
    let socket
    try { socket = await openTunnel(target.host, target.port, res) } catch (err) {
      log(`HTTP 出口失败：${err?.message ?? err}`)
      if (!res.destroyed) res.writeHead(502).end('bad gateway')
      return
    }
    const headers = { ...req.headers, host: u.host, connection: 'close' }
    for (const token of String(req.headers.connection ?? '').split(',')) {
      const key = token.trim().toLowerCase()
      if (key && key !== 'host' && key !== 'content-length' && key !== 'transfer-encoding') delete headers[key]
    }
    delete headers['proxy-connection']
    delete headers['proxy-authorization']
    headers.connection = 'close'
    // agent:false 会创建自己的 Agent，忽略 options.createConnection。
    // 每个请求独占一个真正覆写 createConnection 的 Agent，不缓存隧道。
    const agent = new http.Agent({ keepAlive: false })
    agent.createConnection = () => socket
    let outgoing
    const cleanup = () => { outgoing?.destroy(); agent.destroy(); socket.destroy() }
    res.once('close', cleanup)
    res.once('finish', cleanup)
    try {
      outgoing = http.request({
        host: target.host, port: target.port, method: req.method,
        path: `${u.pathname}${u.search}`, headers, agent,
      })
      // Agent 接管时 HTTP 解析器已经安装，此时恢复握手返回的暂停流。
      outgoing.once('socket', assigned => assigned.resume())
      outgoing.setTimeout(timeoutMs, () => outgoing.destroy(new Error('HTTP 转发超时')))
      outgoing.on('response', (upRes) => {
        upRes.once('aborted', () => res.destroy())
        upRes.once('error', () => res.destroy())
        if (res.destroyed) { upRes.destroy(); return }
        res.writeHead(upRes.statusCode ?? 502, upRes.headers)
        upRes.pipe(res)
      })
      outgoing.on('error', (err) => {
        log(`HTTP 转发失败：${err?.message ?? err}`)
        if (!res.destroyed) {
          if (res.headersSent) res.destroy()
          else res.writeHead(502).end('bad gateway')
        }
        cleanup()
      })
      req.pipe(outgoing)
    } catch (err) {
      cleanup()
      if (!res.destroyed) res.writeHead(502).end('bad gateway')
    }
  }

  return new Promise((resolve, reject) => {
    const failed = (err) => { closing = true; reject(err) }
    server.once('error', failed)
    server.listen(port, listenHost, () => {
      server.removeListener('error', failed)
      log(`分流代理已监听 http://${listenHost}:${server.address().port}`)
      resolve({
        server,
        close() {
          if (closePromise) return closePromise
          closing = true
          for (const controller of pending) controller.abort(new Error('代理已关闭'))
          for (const socket of sockets) socket.destroy()
          closePromise = new Promise((done) => server.close(() => done()))
          return closePromise
        },
      })
    })
  })
}
