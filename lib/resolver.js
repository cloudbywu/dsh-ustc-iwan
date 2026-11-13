/**
 * 带缓存的 IPv4 解析器。
 * - 支持指定 DNS 服务器（如 223.5.5.5），避免本机 DNS 被 TUN/fake-ip 接管时拿到假地址；
 * - 识别 fake-ip：全部解析结果都是 fake-ip 网段时标记 fake=true，调用方应改用域名规则判断。
 */
import dns from 'node:dns'
import { isIPv4 } from 'node:net'
import { isFakeIPv4 } from './cidr.js'

const NO_ERROR = () => {}

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' 超时')), ms)
  })
  promise.catch(NO_ERROR) // 超时后丢弃底层失败，避免 unhandledRejection
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * @param {object} opts
 * @param {string} [opts.dnsServer]  自定义 DNS（IP，可带端口 "223.5.5.5:53"），空则用系统解析。
 * @param {number} [opts.ttlMs]      结果缓存时长。
 * @param {number} [opts.timeoutMs]  单次解析超时。
 * @returns {(host: string) => Promise<{ ips: string[], fake: boolean, literal: boolean }>}
 */
export function createResolver({ dnsServer, ttlMs = 60_000, timeoutMs = 3_000 } = {}) {
  let resolver = null
  if (dnsServer) {
    resolver = new dns.promises.Resolver()
    resolver.setServers([dnsServer])
  }

  const cache = new Map()

  return async function resolve4(host) {
    const h = String(host ?? '').trim().toLowerCase()
    if (isIPv4(h)) return { ips: [h], fake: isFakeIPv4(h), literal: true }

    const now = Date.now()
    const hit = cache.get(h)
    if (hit && hit.expire > now) return hit.value

    let ips = []
    try {
      const pending = resolver ? resolver.resolve4(h) : dns.promises.resolve4(h)
      ips = (await withTimeout(pending, timeoutMs, `DNS 解析 ${h}`)) ?? []
    } catch {
      ips = []
    }
    ips = ips.filter((ip) => isIPv4(ip))
    const value = {
      ips,
      fake: ips.length > 0 && ips.every(isFakeIPv4),
      literal: false,
    }
    cache.set(h, { value, expire: now + ttlMs })
    return value
  }
}

/** 清空缓存（供 dispose 用，当前实现缓存随闭包销毁，保留接口便于扩展）。 */
export function createResolverHost(opts) {
  const resolve4 = createResolver(opts)
  return { resolve4 }
}
