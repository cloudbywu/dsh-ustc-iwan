/**
 * 插件自身设置的持久化：一个小 JSON 文档，原子写入。
 *
 * 这是设置卡片能改的字段的唯一事实来源；cordis 的 Config 只提供首次启动的默认值，
 * 环境变量（USTC_IWAN_*）仍拥有最高优先级。
 */
import fs from 'node:fs'
import path from 'node:path'
import { resolveDshHome } from './home.js'
import { DEFAULT_IWAN_SOCKS_PORT } from './defaults.js'
import { isValidCidrList } from './cidr.js'
import { parseDnsServer } from './resolver.js'
import { isIP, isIPv4 } from 'node:net'

/** 设置文档当前版本；未来字段语义变化时升级。 */
export const SETTINGS_VERSION = 1

/** 设置文档位置：<DSH_HOME>/storages/ustc-iwan-settings.json。 */
export function settingsPath() {
  return path.join(resolveDshHome(), 'storages', 'ustc-iwan-settings.json')
}

export function defaultSettings() {
  return {
    version: SETTINGS_VERSION,
    enabled: true,
    listenPort: 18118,
    iwanSocksHost: '127.0.0.1',
    iwanSocksPort: DEFAULT_IWAN_SOCKS_PORT,
    manageClient: true,
    iwanBackend: 'native',
    autoFailover: false,
    iwanClientPath: '',
    iwanServer: '',
    upstreamProxy: '',
    cidrs: '',
    domainSuffixes: 'ustc.edu.cn,ustclug.org,ustc.life',
    dnsServer: '',
    iwanTunnelDns: '',
    verbose: false,
  }
}

/** 允许写盘的字段与其类型（其余一律拒绝，半套用的补丁宁可整个不收）。 */
const FIELD_TYPES = {
  enabled: 'boolean',
  listenPort: 'number',
  iwanSocksHost: 'string',
  iwanSocksPort: 'number',
  manageClient: 'boolean',
  iwanBackend: 'string',
  autoFailover: 'boolean',
  iwanClientPath: 'string',
  iwanServer: 'string',
  upstreamProxy: 'string',
  cidrs: 'string',
  domainSuffixes: 'string',
  dnsServer: 'string',
  iwanTunnelDns: 'string',
  verbose: 'boolean',
}

function tunnelDns(value) {
  const address = parseDnsServer(value)
  return address !== null && (!address || isIPv4(address.split(':')[0]))
}

function isSocksHost(value) {
  const host = value.trim()
  return Boolean(isIP(host) || (host.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.?$/i.test(host)))
}

function isUpstreamProxy(value) {
  const text = value.trim()
  if (!text) return true
  if (!/^https?:\/\/[^\\/?#\s\x00-\x1f\x7f]+\/?$/i.test(text)) return false
  try {
    const url = new URL(text)
    if (!url.hostname || url.pathname !== '/') return false
    // The connector decodes these fields before constructing Proxy-Authorization.
    decodeURIComponent(url.username)
    decodeURIComponent(url.password)
    return true
  } catch { return false }
}

/** 读盘；坏文件退回默认值，绝不让一个损坏的文档挡住启动。 */
export function readSettings(fallback = {}) {
  const merged = { ...defaultSettings(), ...fallback }
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      for (const [key, type] of Object.entries(FIELD_TYPES)) {
        if (key in raw && typeof raw[key] === type && (key !== 'iwanBackend' || ['native','node'].includes(raw[key])) &&
            (key !== 'iwanTunnelDns' || tunnelDns(raw[key]))) merged[key] = raw[key]
      }
    }
  } catch {}
  return merged
}

/** 原子写入（临时文件 + rename）。 */
export function writeSettings(settings) {
  const file = settingsPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2))
  fs.renameSync(tmp, file)
}

/** 校验一个设置补丁；返回 { patch, error? }。任何字段非法都拒绝整个补丁。 */
export function readSettingsUpdate(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: '设置补丁必须是 JSON 对象' }
  }
  const patch = {}
  for (const [key, value] of Object.entries(body)) {
    if (!Object.hasOwn(FIELD_TYPES, key)) continue // 未知字段忽略，不报错
    const type = FIELD_TYPES[key]
    if (type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 65535) {
        return { error: `${key} 必须是 1-65535 的端口号` }
      }
      if (!Number.isInteger(value)) return { error: `${key} 必须是整数` }
    } else if (typeof value !== type) {
      return { error: `${key} 的类型必须是 ${type}` }
    }
    if (key === 'iwanBackend' && !['native','node'].includes(value)) return { error: 'iwanBackend 必须为 native 或 node' }
    if (key === 'dnsServer' && parseDnsServer(value) === null) {
      return { error: 'dnsServer 必须为 IPv4 或 IPv6 地址；可选端口须为 1-65535，IPv6 带端口时请使用方括号' }
    }
    if (key === 'iwanTunnelDns' && !tunnelDns(value)) return { error: 'iwanTunnelDns 必须为校内 IPv4 DNS 地址（可带 1-65535 端口）或留空' }
    if (key === 'iwanSocksHost' && !isSocksHost(value)) return { error: 'iwanSocksHost 必须为 IPv4、IPv6 或主机名，不含端口' }
    if (key === 'upstreamProxy' && !isUpstreamProxy(value)) return { error: 'upstreamProxy 必须为 HTTP(S) 代理地址（不含路径、查询或片段）或留空' }
    if (key === 'cidrs' && !isValidCidrList(value)) return { error: 'cidrs 含有无效的 IPv4 网段' }
    patch[key] = ['iwanSocksHost', 'upstreamProxy', 'iwanTunnelDns'].includes(key) ? value.trim() : value
  }
  return { patch }
}
