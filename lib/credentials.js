/**
 * Offline, redacted credential status; never a live authentication check.
 * Upstream audited at 60237d88f7f1f2df4a21c79e61af392cadad4944:
 * https://github.com/yyy1mu/ustc-iwan/blob/60237d88f7f1f2df4a21c79e61af392cadad4944/src/bin/oidc/config.rs
 * cli.rs: --config-dir defaults to ~/.config/iwan; config.rs resolves its home.
 * connect.rs: saves only domain + servers (name/host/port/username/passWord/salt/mtu).
 * https://github.com/yyy1mu/ustc-iwan/blob/60237d88f7f1f2df4a21c79e61af392cadad4944/src/core/gcm.rs
 * passWord is AES-GCM nonce/ciphertext/tag, not a JWT or certificate. No expiry.
 * oidc.rs decodes id_token ONLY to obtain a name and does not persist the token.
 * core/auth.rs receives an ephemeral u32 session token, not an expiry timestamp.
 * Consequently this schema cannot establish valid OR expired offline. Do not
 * invent expiry from mtime, authState, TCP listeners, JWT-like extras or certs.
 */
import fs from 'node:fs'
import path from 'node:path'
import { isIP } from 'node:net'
import { execFileSync } from 'node:child_process'

const MAX_BYTES = 1024 * 1024
const MAX_SERVERS = 4096
const LOCAL = 'servers.json:upstream-password-schema'
const result = (state, message, serverCount = 0, source = 'servers.json') =>
  ({ state, expiresAt: null, serverCount, message, source })
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const own = (value, key) => Object.hasOwn(value, key)
const statRevision = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')

// The sole child process is the same local NSS account lookup used by upstream
// on Linux under sudo. It does not execute iwan, log in, or contact a VPN.
function defaultHome() {
  const env = process.env
  if (process.platform === 'win32') {
    if (env.USERPROFILE) return env.USERPROFILE
    if (env.HOMEDRIVE && env.HOMEPATH) return env.HOMEDRIVE + env.HOMEPATH
  }
  if (process.platform === 'linux' && env.SUDO_USER && env.SUDO_USER !== 'root') {
    try {
      const line = execFileSync('getent', ['passwd', env.SUDO_USER], {
        encoding: 'utf8', timeout: 1000, maxBuffer: 64 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const home = line.split(':')[5]
      if (home !== undefined) return home
    } catch { /* Upstream also falls back when getent is unavailable. */ }
    return '/home/' + env.SUDO_USER
  }
  return env.HOME || process.cwd()
}

function configPath(configDir) {
  const dir = configDir === undefined ? '~/.config/iwan' : configDir
  if (typeof dir !== 'string' || dir.includes('\0')) throw new Error('options')
  // Only the exact ~/ prefix is expanded, just like Rust strip_prefix("~/").
  return path.join(dir.startsWith('~/') ? path.join(defaultHome(), dir.slice(2)) : dir, 'servers.json')
}

function readJson(file, onRevision = () => {}) {
  const before = fs.lstatSync(file)
  // Stat-only change marker: no path, username, ciphertext or credential hash.
  if (before.isFile()) onRevision(statRevision(before))
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('file-type')
  if (before.size > MAX_BYTES) throw new Error('file-size')
  let fd
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0))
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) throw new Error('file-type')
    if (stat.size > MAX_BYTES) throw new Error('file-size')
    if (statRevision(stat) !== statRevision(before)) throw new Error('file-changed')
    // Bound the actual read as well: a file can grow after stat.
    const buffer = Buffer.alloc(MAX_BYTES + 1)
    let length = 0, count
    while (length < buffer.length && (count = fs.readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += count
    if (length > MAX_BYTES) throw new Error('file-size')
    if (statRevision(fs.fstatSync(fd)) !== statRevision(stat)) throw new Error('file-changed')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))
    return JSON.parse(text, (key, value) => {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') throw new Error('unsafe-json')
      return value
    })
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/** Read only literal upstream relay addresses; never resolve a hostname through TUN. */
export function readCredentialRelayIps({ configDir } = {}) {
  try {
    const raw = readJson(configPath(configDir))
    if (!object(raw) || !Array.isArray(raw.servers) || raw.servers.length > MAX_SERVERS) return []
    const ips = new Set()
    for (const entry of raw.servers) {
      const ip = object(entry) && typeof entry.host === 'string' ? entry.host.trim() : ''
      if (ip && !ip.includes('%') && isIP(ip)) ips.add(ip.toLowerCase())
    }
    return [...ips]
  } catch { return [] }
}

// Check only the public envelope, never decrypt or validate the password.
function passwordEnvelope(value) {
  if (!/^(?:[A-Za-z0-9_-]+={0,2}|[A-Za-z0-9+/]+={0,2})$/.test(value)) return false
  const bare = value.replace(/=+$/, '')
  if (bare.length % 4 === 1 || (value.includes('=') && value.length % 4 !== 0)) return false
  const decoded = Buffer.from(value, 'base64url')
  return decoded.length >= 28 && decoded.toString('base64url') === bare.replace(/\+/g, '-').replace(/\//g, '_')
}

function entryState(entry) {
  if (!object(entry)) return 'invalid'
  for (const field of ['name', 'host', 'username', 'passWord', 'salt']) {
    if (own(entry, field) && typeof entry[field] !== 'string') return 'invalid'
  }
  for (const field of ['port', 'mtu']) {
    if (!own(entry, field) || (field === 'mtu' && entry[field] === null)) continue
    if (!Number.isInteger(entry[field]) || entry[field] < 0 || entry[field] > 65535) return 'invalid'
  }
  if (!entry.host || !entry.username || !entry.passWord) return 'missing'
  if (!passwordEnvelope(entry.passWord)) return 'invalid'
  return 'unknown'
}

function select(servers, choice) {
  // CLI uses usize::from_str, then case-sensitive contains(), first match.
  if (/^\+?[0-9]+$/.test(choice)) {
    const index = BigInt(choice)
    if (index <= 18446744073709551615n) return index > 0n && index <= BigInt(servers.length) ? servers[Number(index - 1n)] : undefined
  }
  return servers.find(entry => object(entry) && typeof entry.name === 'string' && entry.name.includes(choice))
}

/**
 * @param {{configDir?: string, now?: number, server?: string}} [options]
 * now is Unix epoch MILLISECONDS (Date.now()), not seconds. Reserved for schemas
 * with a documented expiration; the current upstream schema has none. No cache
 * is used, and mtime never supplies evidence of lifetime.
 * server: ''/omitted = no explicit CLI selection, 'auto' = network choice unknown,
 * otherwise 1-based index or first case-sensitive name substring, as upstream.
 * serverCount always counts the entire local list, not only the selected entry.
 * revision is a best-effort stat fingerprint, NOT a content/integrity hash.
 * @returns {{state:'valid'|'expired'|'missing'|'invalid'|'unknown', expiresAt:number|null, serverCount:number, message:string, source:string, revision:string|null}}
 */
export function readCredentialStatus(options = {}) {
  let revision = null
  const status = (state, message, count = 0, source = 'servers.json') => ({ ...result(state, message, count, source), revision })
  if (!object(options)) return status('invalid', '凭据状态读取参数无效。')
  const { configDir, now = Date.now(), server = '' } = options
  if (typeof now !== 'number' || !Number.isFinite(now) || Math.abs(now) > 8640000000000000 || typeof server !== 'string') {
    return status('invalid', '状态读取参数无效；now 必须为 Unix 毫秒时间。')
  }
  let raw
  try { raw = readJson(configPath(configDir), value => { revision = value }) } catch (error) {
    if (error?.code === 'ENOENT') return status('missing', '未找到本地凭据配置；尚未进行在线验证。')
    if (error?.code === 'EACCES' || error?.code === 'EPERM') return status('unknown', '本地凭据配置读取被拒绝；无法判断认证状态。')
    if (error?.message === 'options') return status('invalid', '凭据目录参数无效。')
    if (error?.message === 'file-changed') {
      revision = null
      return status('unknown', '读取期间本地凭据配置已变化；请重新读取状态。')
    }
    if (error?.message === 'file-size') return status('invalid', '本地凭据配置超过 1 MiB 安全读取上限。')
    if (error?.message === 'file-type' || error?.code === 'ELOOP') return status('invalid', '本地凭据配置必须为普通文件，不接受符号链接。')
    if (error instanceof SyntaxError || error?.message === 'unsafe-json' || error?.code === 'ERR_ENCODING_INVALID_ENCODED_DATA' || error instanceof RangeError) {
      return status('invalid', '本地凭据配置不是安全、有效的 UTF-8 JSON。')
    }
    return status('unknown', '读取本地凭据配置失败；无法判断认证状态。')
  }
  if (!object(raw) || !own(raw, 'servers')) return status('unknown', '无法识别本地凭据格式；未进行在线验证。')
  if (!Array.isArray(raw.servers) || (own(raw, 'domain') && typeof raw.domain !== 'string')) {
    return status('invalid', '本地凭据配置字段类型不符合上游格式。')
  }
  const count = raw.servers.length
  if (count > MAX_SERVERS) return status('invalid', '本地凭据线路数量超过安全读取上限。', count)
  if (!count) return status('missing', '本地凭据配置没有线路；尚未进行在线验证。', count, LOCAL)
  if (server === 'auto') return status('unknown', '自动选路需要网络测速；离线无法确定选定线路及其认证有效期。', count, LOCAL)
  let entries = raw.servers
  if (server !== '') {
    const entry = select(entries, server)
    if (entry === undefined) return status('invalid', '选定线路不存在；请检查 CLI 序号或名称关键字。', count, LOCAL)
    entries = [entry]
  }
  const states = entries.map(entryState)
  if (states.every(state => state === 'missing')) return status('missing', '本地线路缺少连接所需凭据；尚未进行在线验证。', count, LOCAL)
  if (states.every(state => state === 'invalid')) return status('invalid', '本地线路凭据字段或加密密码封装不符合上游格式。', count, LOCAL)
  if (entries.length > 1 && states.some(state => state !== 'unknown')) {
    return status('unknown', '多个线路凭据状态不一致且未指定线路；无法判断认证有效期。', count, LOCAL)
  }
  return status('unknown', '已找到本地加密线路凭据，但上游未保存有效期；未解密密码、未进行在线认证验证。', count, LOCAL)
}
