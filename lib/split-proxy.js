/**
 * 本地分流代理：标准 HTTP 代理协议（CONNECT 隧道 + 绝对形式明文请求）。
 * 每个请求先经 decide(host) 决策，再从三种出口择一：
 *   - iwan     ：经 iWAN 的 SOCKS5（域名原样交给 iWAN 解析）
 *   - upstream ：经用户原有 HTTP 代理（如 Clash 7890），保留原有代理行为
 *   - direct   ：直连
 * iWAN 出口失败时自动回退直连，保证 iWAN 掉线时不影响可用性。
 */
import http from 'node:http'
import net from 'node:net'
import { socksConnect } from './socks.js'

/** 解析 CONNECT 目标 "host:port"（兼容 [::1]:443）。 */
function parseTarget(raw, fallbackPort) {
  let host = String(raw ?? '').trim()
  let port = fallbackPort
  const m = /^(?:\[([^\]]+)\]|([^:]+))(?::(\d+))?$/.exec(host)
  if (m) {
    host = (m[1] ?? m[2] ?? '').toLowerCase()
    if (m[3]) port = Number(m[3])
  }
  if (!host) return null
  if (!Number.isInteger(port) || port <= 0 || port > 65535) port = fallbackPort
  return { host, port }
}

function directConnect(host, port, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      socket.setTimeout(0)
      resolve(socket)
    })
    socket.once('error', (err) => {
      socket.destroy()
      reject(err)
    })
    socket.once('timeout', () => {
      socket.destroy()
      reject(new Error(`直连 ${host}:${port} 超时`))
    })
  })
}

/** 通过上游 HTTP 代理发 CONNECT。 */
function upstreamConnect(proxyUrl, host, port, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const u = new URL(proxyUrl)
    const socket = net.connect({ host: u.hostname, port: Number(u.port) || 80 })
    socket.setTimeout(timeoutMs)
    let buffer = Buffer.alloc(0)
    socket.once('connect', () => {
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`)
    })
    socket.on('data', function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf('\r\n\r\n')
      if (end === -1) return
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(buffer.toString('ascii', 0, end))
      socket.removeListener('data', onData)
      socket.setTimeout(0)
      const rest = buffer.subarray(end + 4)
      if (rest.length) socket.unshift(rest)
      if (status && status[1] === '200') resolve(socket)
      else {
        socket.destroy()
        reject(new Error(`上游代理 CONNECT 返回 ${status ? status[1] : '??'}`))
      }
    })
    socket.once('error', (err) => {
      socket.destroy()
      reject(err)
    })
    socket.once('timeout', () => {
      socket.destroy()
      reject(new Error(`上游代理 ${u.host} 连接/应答超时`))
    })
  })
}

/**
 * @param {object} opts
 * @param {number} opts.port        监听端口（默认 18118）
 * @param {string} [opts.listenHost] 默认 127.0.0.1
 * @param {(host: string) => Promise<{kind:'iwan'}|{kind:'direct'}|{kind:'upstream', url:string}>} opts.decide
 * @param {object} opts.iwan        { proxyHost, proxyPort }
 * @param {(msg: string) => void} [opts.log]
 * @param {boolean} [opts.verbose]
 */
export function startSplitProxy({ port = 18118, listenHost = '127.0.0.1', decide, iwan, log = () => {}, verbose = false }) {
  const openTunnel = async (host, port) => {
    let route
    try {
      route = await decide(host)
    } catch (err) {
      route = { kind: 'direct' }
      log(`路由决策失败，按直连处理：${err?.message ?? err}`)
    }
    try {
      if (route.kind === 'iwan') {
        const socket = await socksConnect({
          proxyHost: iwan.proxyHost,
          proxyPort: iwan.proxyPort,
          targetHost: host,
          targetPort: port,
        })
        if (verbose) log(`→ iWAN ${host}:${port}`)
        return socket
      }
      if (route.kind === 'upstream') {
        const socket = await upstreamConnect(route.url, host, port)
        if (verbose) log(`→ 上游代理 ${host}:${port}`)
        return socket
      }
      const socket = await directConnect(host, port)
      if (verbose) log(`→ 直连 ${host}:${port}`)
      return socket
    } catch (err) {
      if (route.kind !== 'iwan') throw err
      log(`iWAN 出口失败（${err?.message ?? err}），${host}:${port} 本次回退直连`)
      return directConnect(host, port)
    }
  }

  const server = http.createServer()
  server.on('request', (req, res) => {
    void handleAbsolute(req, res).catch(() => {})
  })
  server.on('connect', (req, clientSocket, head) => {
    void handleConnect(req, clientSocket, head).catch(() => {})
  })
  server.on('clientError', (err, socket) => {
    try {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    } catch {}
  })

  async function handleConnect(req, clientSocket, head) {
    const target = parseTarget(req.url, 443)
    if (!target) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    let upstream
    try {
      upstream = await openTunnel(target.host, target.port)
    } catch (err) {
      log(`隧道建立失败 ${target.host}:${target.port}：${err?.message ?? err}`)
      try {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      } catch {}
      return
    }
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head?.length) upstream.write(head)
    clientSocket.pipe(upstream)
    upstream.pipe(clientSocket)
    const teardown = () => {
      clientSocket.destroy()
      upstream.destroy()
    }
    clientSocket.once('error', teardown)
    upstream.once('error', teardown)
    clientSocket.once('close', teardown)
    upstream.once('close', teardown)
  }

  async function handleAbsolute(req, res) {
    let target
    try {
      const u = new URL(req.url)
      target = { host: u.hostname.toLowerCase(), port: Number(u.port) || 80 }
    } catch {
      res.writeHead(400).end('bad request')
      return
    }
    let upstreamSocket
    try {
      upstreamSocket = await openTunnel(target.host, target.port)
    } catch (err) {
      log(`明文请求出口失败 ${target.host}: ${err?.message ?? err}`)
      try {
        res.writeHead(502).end('bad gateway')
      } catch {}
      return
    }
    const headers = { ...req.headers }
    delete headers['proxy-connection']
    delete headers['proxy-authorization']
    const outgoing = http.request({
      createConnection: () => upstreamSocket,
      host: target.host,
      port: target.port,
      method: req.method,
      path: req.url,
      headers,
      agent: false,
    })
    outgoing.on('response', (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers)
      upRes.pipe(res)
    })
    outgoing.on('error', (err) => {
      log(`明文转发失败 ${target.host}: ${err?.message ?? err}`)
      try {
        res.writeHead(502).end('bad gateway')
      } catch {}
      upstreamSocket.destroy()
    })
    req.pipe(outgoing)
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, listenHost, () => {
      server.removeAllListeners('error')
      log(`分流代理已监听 http://${listenHost}:${port}`)
      resolve({
        server,
        close() {
          try {
            server.close()
          } catch {}
          try {
            server.closeAllConnections?.()
          } catch {}
        },
      })
    })
  })
}
