/**
 * IPv4 CIDR 工具：解析网段列表、判断地址归属、识别代理软件的 fake-ip 网段。
 * 全部纯函数，无外部依赖。
 */

/** 把点分 IPv4 解析为 32 位无符号整数，非法时返回 null。 */
export function ipv4ToInt(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip).trim())
  if (!m) return null
  let n = 0
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i])
    if (octet > 255) return null
    n = n * 256 + octet
  }
  return n >>> 0
}

/** 解析单个 CIDR（如 "202.38.64.0/19"），返回 { lo, hi, raw }，非法返回 null。 */
export function parseCidr(text) {
  const raw = String(text).trim()
  if (!raw) return null
  const slash = raw.indexOf('/')
  const addr = slash === -1 ? raw : raw.slice(0, slash)
  const lenRaw = slash === -1 ? undefined : raw.slice(slash + 1)
  const base = ipv4ToInt(addr)
  if (base === null) return null
  if (lenRaw !== undefined && !/^\d{1,2}$/.test(lenRaw)) return null
  const len = lenRaw === undefined ? 32 : Number(lenRaw)
  if (!Number.isInteger(len) || len < 0 || len > 32) return null
  const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0
  const lo = (base & mask) >>> 0
  const hi = (lo | (~mask >>> 0)) >>> 0
  return { lo, hi, raw }
}

/** 解析逗号/空白分隔的 CIDR 列表，跳过无法解析的条目。 */
export function parseCidrList(text) {
  return String(text ?? '')
    .split(/[\s,]+/)
    .map(parseCidr)
    .filter(Boolean)
}

/**
 * 生成一个匹配函数：传入 IPv4 字符串，命中时返回命中的网段原文，未命中返回 null。
 * IPv6 与非法输入一律返回 null。
 */
export function makeCidrMatcher(text) {
  const ranges = parseCidrList(text)
  return (ip) => {
    const n = ipv4ToInt(ip)
    if (n === null) return null
    for (const r of ranges) {
      if (n >= r.lo && n <= r.hi) return r.raw
    }
    return null
  }
}

/** Clash/mihomo TUN fake-ip 默认网段：命中说明本机 DNS 被代理接管，看到的不是真实地址。 */
export const FAKE_IP_CIDR_TEXT = '198.18.0.0/15, 198.51.100.0/24'

const FAKE_RANGES = parseCidrList(FAKE_IP_CIDR_TEXT)

/** 该 IPv4 是否疑似 fake-ip（TUN + fake-ip DNS 接管时的典型返回值）。 */
export function isFakeIPv4(ip) {
  const n = ipv4ToInt(ip)
  if (n === null) return false
  return FAKE_RANGES.some((r) => n >= r.lo && n <= r.hi)
}
