/** In-process Node.js backend; implements the same managed handle as the executable backend. */
import { isIPv4 } from 'node:net'
import { readNodeIwanRelay } from '../credentials.js'
import { createTunnelDns } from './dns.js'
import { startNodeSocks } from './socks-server.js'
import { createTcpStack } from './tcp.js'
import { openIwanTunnel } from './wire.js'

const DEFAULT_DNS = '202.38.64.1'

function dnsEndpoint(value) {
  const [server, text, ...extra] = value.split(':')
  const port = text === undefined ? 53 : Number(text)
  if (extra.length || !isIPv4(server) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Node.js 后端仅支持 IPv4 校内 DNS（可带端口）')
  }
  return { server, port }
}

export function createNodeIwanBackend({ readRelay = readNodeIwanRelay, openTunnel = openIwanTunnel,
  makeStack = createTcpStack, makeDns = createTunnelDns, startSocks = startNodeSocks } = {}) {
  return async function ensureNodeIwan({ server, socksHost = '127.0.0.1', socksPort = 21080, dns,
    signal, timeoutMs = 30_000, log = () => {}, onSpawned } = {}) {
    signal?.throwIfAborted()
    const relay = readRelay({ server })
    const resolver = dnsEndpoint(dns || DEFAULT_DNS)
    const controller = new AbortController()
    const events = new Set()
    let tunnel, tcp, names, socks, removePacket, removeClose, closing, exit, verifiedAt
    const report = text => { try { log(text) } catch {} }
    const abort = () => { void finish(null, true) }
    function finish(error, stopped = false) {
      if (closing) return closing
      closing = Promise.resolve().then(async () => {
        signal?.removeEventListener('abort', abort)
        controller.abort(error ?? new Error('Node.js iWAN 已停止'))
        removePacket?.(); removeClose?.()
        names?.close(); tcp?.close(error ?? undefined)
        await Promise.allSettled([socks?.stop(), tunnel?.close()])
        exit = { code: null, signal: null, error, stopped }
        for (const listener of events) { try { listener(exit) } catch {} }
        events.clear()
      })
      return closing
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      tunnel = await openTunnel({ relay, signal: controller.signal, timeoutMs, log: report })
      controller.signal.throwIfAborted()
      if (closing) throw new Error('Node.js iWAN 启动已取消')
      const address = tunnel.ip, send = packet => tunnel.send(packet)
      tcp = makeStack({ address, mtu: tunnel.mtu, send })
      names = makeDns({ address, ...resolver, send, connectTcp: tcp.connect })
      removePacket = tunnel.onPacket(packet => { tcp.receive(packet); names.receive(packet) })
      removeClose = tunnel.onClose(error => { void finish(error ?? new Error('iWAN UDP 隧道已关闭')) })
      socks = await startSocks({ host:socksHost, port:socksPort, signal:controller.signal,
        onFailure: () => { void finish(new Error('Node.js iWAN SOCKS5 监听失效')) },
        connect: async (target, port, signal) => {
          const addresses = isIPv4(target) ? [target] : await names.resolve(target, signal)
          let lastError
          for (const ip of addresses.slice(0, 3)) {
            signal.throwIfAborted()
            try { return await tcp.connect(ip, port, { signal, timeoutMs: 5000 }) }
            catch (error) { lastError = error }
          }
          throw lastError ?? new Error('校内 DNS 未返回 IPv4 地址')
        },
      })
      controller.signal.throwIfAborted()
      if (closing) throw new Error('Node.js iWAN 启动已取消')
      verifiedAt = Date.now()
      const handle = {
        managed:true, backend:'node', socksHost:socks.host, socksPort:socks.port,
        isAlive:() => !closing, hasExited:() => Boolean(exit), isAuthenticated:() => !closing,
        authenticatedAt:verifiedAt,
        stop:() => finish(null, true),
        onExit(listener) {
          if (exit) { listener(exit); return () => {} }
          events.add(listener)
          return () => events.delete(listener)
        },
      }
      onSpawned?.(handle)
      report('Node.js iWAN SOCKS5 就绪（' + socks.host + ':' + socks.port + '）')
      return handle
    } catch (error) {
      await finish(error)
      // A startup hook may resolve after cancellation. It must not leak the resource.
      await Promise.allSettled([socks?.stop(), tunnel?.close()])
      throw error
    }
  }
}

export const ensureNodeIwan = createNodeIwanBackend()
