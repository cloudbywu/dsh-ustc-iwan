import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import { parseCidr } from './cidr.js'
import { readCredentialRelayIps } from './credentials.js'
import { DEFAULT_CIDRS } from './defaults.js'

const APP = 'Clash Verge Rev'
const CONFIG = 'config.yaml'
const VERGE = 'verge.yaml'
const RUNTIME = 'clash-verge.yaml'
const PREFIX = '.ustc-iwan-clash-tun-'
const LOCK = PREFIX + 'lock'
const MAX_CONFIG = 1024 * 1024
const MAX_RUNTIME = 4 * MAX_CONFIG
const MAX_BACKUP = 2 * MAX_CONFIG
const CAMPUS = DEFAULT_CIDRS.split(',')
const statArgs = { bigint: true }
const parseFailure = 'Clash Verge Rev 的 GUI 配置 config.yaml 中存在不受支持的 YAML 或 TUN 排除项。'
const missingConfig = '未找到官方 Clash Verge Rev 的本地配置。'
const missingRelays = '未找到字面 iWAN 线路 IP；请先完成或刷新 iWAN 认证。若线路只有域名，则无法自动添加排除项。'
const processFailure = '无法确认 Clash Verge Rev 与 verge-mihomo 已完全退出。'
const runningReason = '请完全退出 Clash Verge Rev 与 verge-mihomo 后再操作。'
const blocked = (status, message) => Object.assign(new Error(message), { status })
const changed = () => blocked(409, '配置或线路已变化；请重新检测后再操作。')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const randomId = () => randomBytes(16).toString('hex')
const stamp = s => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':')
const identity = (a, b) => a.ino === b.ino && a.dev === b.dev
const comparablePath = p => process.platform === 'win32' ? p.toLowerCase() : p
const missingFile = err => err?.code === 'ENOENT'

function checkDirectory(dir) {
  if (!path.isAbsolute(dir)) throw new Error('unsafe-directory')
  const outer = path.dirname(dir)
  if (outer !== dir) checkDirectory(outer)
  const info = fs.lstatSync(dir, statArgs)
  if (!info.isDirectory() || info.isSymbolicLink() || comparablePath(fs.realpathSync.native(dir)) !== comparablePath(dir)) {
    throw new Error('unsafe-directory')
  }
  return info
}

function fileInfo(file) {
  const s = fs.lstatSync(file, statArgs)
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n || comparablePath(fs.realpathSync.native(file)) !== comparablePath(file)) {
    throw new Error('unsafe-file')
  }
  return s
}

function readBounded(dir, name, limit) {
  checkDirectory(dir)
  const file = path.join(dir, name)
  const before = fileInfo(file)
  if (before.size > BigInt(limit)) throw new Error('file-size')
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0))
  try {
    if (stamp(fs.fstatSync(fd, statArgs)) !== stamp(before)) throw changed()
    const bytes = Buffer.alloc(Number(before.size) + 1)
    let used = 0
    while (used < bytes.length) {
      const n = fs.readSync(fd, bytes, used, bytes.length - used, null)
      if (n === 0) break
      used += n
    }
    if (BigInt(used) !== before.size || stamp(fs.fstatSync(fd, statArgs)) !== stamp(before) || stamp(fileInfo(file)) !== stamp(before)) throw changed()
    const buffer = bytes.subarray(0, used)
    return { buffer, hash: sha(buffer), stat: before }
  } finally { fs.closeSync(fd) }
}

function writeExclusive(dir, name, bytes) {
  checkDirectory(dir)
  const file = path.join(dir, name)
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600)
  let origin
  try {
    origin = fs.fstatSync(fd, statArgs)
    fs.writeFileSync(fd, bytes)
    fs.fsyncSync(fd)
    return fs.fstatSync(fd, statArgs)
  } catch (error) {
    if (origin) removeOwned(dir, name, origin)
    throw error
  } finally { fs.closeSync(fd) }
}

function removeOwned(dir, name, original) {
  try {
    checkDirectory(dir)
    const file = path.join(dir, name)
    if (identity(fileInfo(file), original)) fs.unlinkSync(file)
  } catch { /* Missing or replaced externally: leave it alone. */ }
}

function ip6(addr) {
  // net.isIP validated the shape, including the maximum number of groups.
  const normalized = addr.replace(/([\d.]+)$/, tail => {
    if (!tail.includes('.')) return tail
    const { lo } = parseCidr(tail)
    return (lo >>> 16).toString(16) + ':' + (lo & 0xffff).toString(16)
  })
  const [left, right] = normalized.split('::')
  const a = left ? left.split(':') : []
  const b = right ? right.split(':') : []
  if (right !== undefined) a.push(...Array(8 - a.length - b.length).fill('0'), ...b)
  return a.reduce((acc, n) => (acc << 16n) | BigInt('0x' + n), 0n)
}

function cidr(text, hostOnly = false) {
  if (typeof text !== 'string' || text.length > 64 || text.trim() !== text || !/^[a-fA-F0-9:.]+(?:\/(?:0|[1-9][0-9]{0,2}))?$/.test(text)) return null
  const [addr, prefix] = text.split('/')
  const family = isIP(addr)
  const size = family === 4 ? 32 : 128
  if (!family || (hostOnly ? prefix !== undefined : prefix === undefined) || (prefix && Number(prefix) > size)) return null
  const bits = Number(prefix ?? size)
  const value = family === 4 ? BigInt(parseCidr(addr).lo) : ip6(addr)
  const host = BigInt(size - bits)
  return { family, bits, shift: host, value: value >> host << host, raw: hostOnly ? addr + '/' + size : text }
}

const covers = (base, item) => base.family === item.family && base.bits <= item.bits &&
  base.value === (item.value >> base.shift << base.shift)

function cidrs(entries) {
  if (entries.length > 4096) throw new Error('exclusions-size')
  const items = entries.map(entry => cidr(entry))
  if (items.some(item => !item)) throw new Error('unsupported-exclusion')
  return items
}

function readRelays(reader) {
  try {
    const values = reader()
    if (!Array.isArray(values) || values.length > 4096) return []
    const seen = new Set()
    return values.map(value => cidr(value, true)).filter(item => {
      if (!item) return false
      const ip = item.family + ':' + item.value
      if (seen.has(ip)) return false
      seen.add(ip)
      return true
    }).sort((a, b) => a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : 0)
  } catch { return [] }
}

const campus = cidrs(CAMPUS)
const toText = items => items.map(item => item.raw)
function differences(relays, existing) {
  const modes = { relay: relays, campus: [...campus, ...relays.filter(relay => !campus.some(base => covers(base, relay)))] }
  return Object.fromEntries(Object.entries(modes).map(([mode, desired]) => [mode, {
    desired: toText(desired), missing: toText(desired.filter(item => !existing.some(base => covers(base, item)))),
  }]))
}

const same = (a, b) => a.hash === b.hash && stamp(a.stat) === stamp(b.stat)
const backupName = (hash, mtime) => PREFIX + 'backup-' + sha(hash + ':' + mtime)
const summarize = (state, reason, relays, existing, fields = {}) => ({
  state, app: '', running: false, enabled: null, reason, revision: null,
  rollbackAvailable: false, relayCount: relays.length, coverageKnown: existing !== null,
  modes: differences(relays, existing ?? []), existing: toText(existing ?? []), effective: null, ...fields,
})

// Windows uses the same known folder as upstream's dirs::data_dir(), never a
// browser/client supplied path. The helper does no network or service action.
// Reparse attributes are checked natively because lstat on Windows does not
// expose all reparse tags. File.Replace is the same-volume atomic OS primitive;
// false means do not ignore failures to merge the destination's security data.
const windowsScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Reply($value) { ConvertTo-Json -Compress -InputObject $value }
function Attrs($p) {
    $a = [IO.File]::GetAttributes($p)
    if ($a -band [IO.FileAttributes]::ReparsePoint) { throw 'unsafe' }
    $a
}
function Ancestors($p) {
    $parent = [IO.Directory]::GetParent($p)
    if ($null -ne $parent) { Ancestors $parent.FullName }
    if (!((Attrs $p) -band [IO.FileAttributes]::Directory)) { throw 'unsafe' }
}
function Entry($name, [bool] $optional) {
    $p = [IO.Path]::Combine($root, $name)
    try { $a = Attrs $p } catch [IO.FileNotFoundException] { if ($optional) { return }; throw }
    if ($a -band [IO.FileAttributes]::Directory) { throw 'unsafe' }
    $p
}
function BackupEntry($name) {
    if ($name -cnotmatch '^\.ustc-iwan-clash-tun-backup-[a-f0-9]{64}$') { throw 'unsafe' }
    Entry $name $false
}
function IsRunning {
    $all = @(Get-Process -ErrorAction Stop)
    if (!$all.Count -or !($all | Where-Object Id -eq $PID)) { throw 'unknown-process' }
    @($all | Where-Object ProcessName -Match '^(?:clash[- ]verge(?:[- ]rev)?(?:[- ](?:dev|portable))?|verge-mihomo(?:[- ][a-z0-9-]+)?)$').Count -gt 0
}
function ModifiedNs($p) { (([IO.File]::GetLastWriteTimeUtc($p).Ticks - 621355968000000000L) * 100L).ToString() }
function Fingerprint($stream) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
    finally { $sha.Dispose() }
}
try {
    $req = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
    $homeRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
    if ($homeRoot -notmatch '^[A-Za-z]:\\') { throw 'unsafe' }
    Ancestors $homeRoot
    $root = [IO.Path]::Combine($homeRoot, 'io.github.clash-verge-rev.clash-verge-rev')
    if ($req.operation -eq 'inventory') {
        try { Ancestors $root } catch [IO.FileNotFoundException] { Reply @{ result = 'not-found' }; exit }
    } else {
        if (![string]::Equals($root, $req.root, [StringComparison]::OrdinalIgnoreCase)) { throw 'unsafe' }
        Ancestors $root
    }
    $null = Entry 'config.yaml' $true
    $null = Entry 'clash-verge.yaml' $true
    $null = Entry 'verge.yaml' $true
    switch ($req.operation) {
        'inventory' { Reply @{ result = 'ok'; root = $root; running = (IsRunning) } }
        'protect' { Reply @{ result = 'ok'; bytes = (EncryptBackup $req.bytes $true) } }
        'unprotect' {
            $backup = BackupEntry $req.name
            $guard = [IO.File]::Open($backup, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
            try {
                $null = BackupEntry $req.name
                if ($guard.Length -gt $req.limit -or $guard.Length -ne $req.size -or
                    (ModifiedNs $backup) -ne $req.modified) { Reply @{ result = 'changed' }; exit }
                $hash = Fingerprint $guard
                $guard.Position = 0
                $bytes = [IO.MemoryStream]::new()
                try {
                    $guard.CopyTo($bytes)
                    $value = [Convert]::ToBase64String($bytes.ToArray())
                    Reply @{ result = 'ok'; hash = $hash; bytes = (EncryptBackup $value $false) }
                } finally { $bytes.Dispose() }
            } finally { $guard.Dispose() }
        }
        'replace' {
            if ($req.temp -cnotmatch '^\.ustc-iwan-clash-tun-temp-[a-f0-9]{32}$') { throw 'unsafe' }
            $null = Entry '.ustc-iwan-clash-tun-lock' $false
            if ($req.backup) { $null = BackupEntry $req.backup }
            $target = Entry 'config.yaml' $false
            $temp = Entry $req.temp $false
            $share = [IO.FileShare]::Read -bor [IO.FileShare]::Delete
            $guard = [IO.File]::Open($target, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
            $staged = $null
            try {
                $staged = [IO.File]::Open($temp, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
                if ($staged.Length -ne $req.nextSize -or (ModifiedNs $temp) -ne $req.nextModified -or
                    (Fingerprint $staged) -ine $req.nextHash) { Reply @{ result = 'changed' }; exit }
                if ($guard.Length -ne $req.size -or (ModifiedNs $target) -ne $req.modified) { Reply @{ result = 'changed' }; exit }
                $hash = Fingerprint $guard
                if ($hash -ine $req.hash) { Reply @{ result = 'changed' }; exit }
                if (IsRunning) { Reply @{ result = 'running' }; exit }
                if ((ModifiedNs $target) -ne $req.modified -or (ModifiedNs $temp) -ne $req.nextModified) { Reply @{ result = 'changed' }; exit }
                $null = Entry 'config.yaml' $false
                $null = Entry $req.temp $false
                # ReplaceFile needs write access to copy security metadata onto
                # the staged source. Keep the destination deny-write guard.
                $staged.Dispose()
                $staged = $null
                [IO.File]::Replace($temp, $target, [NullString]::Value, $false)
                Reply @{ result = 'ok' }
            } finally {
                if ($null -ne $staged) { $staged.Dispose() }
                $guard.Dispose()
            }
        }
        default { throw 'unsafe' }
    }
} catch {
    Reply @{ result = $(if ($_.Exception.Message -eq 'unsafe') { 'unsafe' } else { 'unavailable' }) }
}
`
// Function is prepended so Windows PowerShell 5.1 can invoke it in the script.
const dpapiScript = String.raw`
function EncryptBackup($value, [bool] $protect) {
    Add-Type -AssemblyName System.Security
    $inputBytes = [Convert]::FromBase64String($value)
    $purpose = [Text.Encoding]::UTF8.GetBytes('ustc-iwan-clash-tun-backup-v1')
    $scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
    if ($protect) { $bytes = [Security.Cryptography.ProtectedData]::Protect($inputBytes, $purpose, $scope) }
    else { $bytes = [Security.Cryptography.ProtectedData]::Unprotect($inputBytes, $purpose, $scope) }
    [Convert]::ToBase64String($bytes)
}
`
const encodedWindowsScript = process.platform === 'win32' ?
  Buffer.from(dpapiScript + windowsScript, 'utf16le').toString('base64') : ''

async function native(operation, fields = {}) {
  try {
    const root = process.env.SystemRoot
    if (!/^[A-Za-z]:\\[^\0]+$/.test(root ?? '')) throw new Error()
    const exe = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const input = JSON.stringify({ operation, ...fields }).replace(/[^\x20-\x7E]/g, c =>
      String.fromCharCode(92) + 'u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
    const output = await new Promise((resolve, reject) => {
      const child = execFile(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedWindowsScript], {
        encoding: 'utf8', timeout: 8000, maxBuffer: 3 * MAX_CONFIG, windowsHide: true,
      }, (error, stdout) => error ? reject(error) : resolve(stdout))
      child.stdin.on('error', () => { /* report only a redacted native error */ })
      child.stdin.end(input)
    })
    return JSON.parse(output)
  } catch { return { result: 'unavailable' } }
}

// Test-only storage never touches APPDATA. Still conceal backup bytes at rest;
// the production path instead uses per-user Windows DPAPI across restarts.
let testKey
function testCrypt(bytes, protect) {
  testKey ??= randomBytes(32)
  if (protect) {
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', testKey, iv)
    const cipher = Buffer.concat([c.update(bytes), c.final()])
    return Buffer.concat([iv, c.getAuthTag(), cipher])
  }
  const c = createDecipheriv('aes-256-gcm', testKey, bytes.subarray(0, 12))
  c.setAuthTag(bytes.subarray(12, 28))
  return Buffer.concat([c.update(bytes.subarray(28)), c.final()])
}

async function protectBackup(dir, bytes, test) {
  if (test) return testCrypt(bytes, true)
  const response = await native('protect', { root: dir, bytes: bytes.toString('base64') })
  if (response.result !== 'ok' || typeof response.bytes !== 'string') throw new Error('backup-encryption')
  return Buffer.from(response.bytes, 'base64')
}

const backupFields = stat => ({ size: Number(stat.size), modified: String(stat.mtimeNs) })

async function findBackup(dir, config, test) {
  const name = backupName(config.hash, config.stat.mtimeNs)
  try {
    let decrypted, encrypted
    if (test) {
      encrypted = readBounded(dir, name, MAX_BACKUP)
      decrypted = testCrypt(encrypted.buffer, false)
    } else {
      const original = fileInfo(path.join(dir, name))
      if (original.size > BigInt(MAX_BACKUP)) return null
      const response = await native('unprotect', { root: dir, name, limit: MAX_BACKUP, ...backupFields(original) })
      if (response.result !== 'ok' || typeof response.bytes !== 'string') return null
      encrypted = readBounded(dir, name, MAX_BACKUP)
      if (stamp(encrypted.stat) !== stamp(original) || encrypted.hash !== response.hash?.toLowerCase()) return null
      decrypted = Buffer.from(response.bytes, 'base64')
    }
    const data = JSON.parse(decrypted.toString('utf8'))
    if (data.version !== 1 || data.after !== config.hash || data.modified !== String(config.stat.mtimeNs) || typeof data.before !== 'string') return null
    const before = Buffer.from(data.before, 'base64')
    if (!before.length || before.length > MAX_CONFIG || sha(before) !== data.beforeHash) return null
    return { before, name, encrypted: { hash: encrypted.hash, stat: encrypted.stat } }
  } catch { return null }
}

function consumeBackup(dir, { name, encrypted }) {
  try {
    // Under the transaction lock, verify both contents and metadata before
    // the same dev/ino ownership check used for the lock and staged file.
    verifyFile(dir, name, encrypted, MAX_BACKUP)
    removeOwned(dir, name, encrypted.stat)
  } catch { /* Only consume the verified backup; any cleanup failure is harmless. */ }
}

function verifyFile(dir, name, original, limit) {
  try { if (same(readBounded(dir, name, limit), original)) return } catch {}
  throw changed()
}

function filesRevision(config, runtime, verge, relays, running) {
  const marker = file => file ? [file.hash, stamp(file.stat)] : null
  return sha(JSON.stringify([marker(config), marker(runtime), marker(verge), toText(relays), running]))
}

// All caller-controlled mutation data is mode + a dry-run revision. Only
// Node tests can opt into the filesystem/process fixture under the temp root.
export function createClashTunManager(options = {}) {
  const test = options.testOnly
  const fixture = test ? path.resolve(test.dataDir) : null
  if (test) {
    // Windows temp paths can use an 8.3 alias. Use the canonical root for
    // fixtures without weakening the production no-alias/no-reparse checks.
    const tempRoot = fs.realpathSync.native(os.tmpdir())
    const relative = path.relative(tempRoot, fixture)
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) ||
      typeof test.getRunning !== 'function' || typeof test.readRelayIps !== 'function') throw new TypeError('Invalid Clash test fixture')
  }
  const relayReader = test ? test.readRelayIps : readCredentialRelayIps

  function processState() {
    let running
    try { running = test.getRunning() } catch { throw blocked(501, processFailure) }
    if (typeof running !== 'boolean') throw blocked(501, processFailure)
    return running
  }

  async function capture() {
    const relays = readRelays(relayReader)
    const fallback = (state, reason, fields) => ({ summary: summarize(state, reason, relays, null, fields) })
    if (!test && process.platform !== 'win32') return fallback('unsupported', '仅支持自动配置官方 Windows 版 Clash Verge Rev。')
    let dir, running
    try {
      if (test) {
        dir = fixture
        checkDirectory(dir)
        running = processState()
      } else {
        const found = await native('inventory')
        if (found.result === 'not-found') return fallback('not-found', missingConfig)
        if (found.result === 'unsafe') return fallback('unsupported', '不支持包含链接或重解析点的 Clash Verge Rev 配置。')
        if (found.result !== 'ok' || typeof found.running !== 'boolean' || typeof found.root !== 'string') throw blocked(501, processFailure)
        dir = found.root
        checkDirectory(dir)
        running = found.running
      }
    } catch (error) {
      if (missingFile(error)) return fallback('not-found', missingConfig)
      return fallback('unsupported', error.status === 501 ? processFailure : '无法安全读取 Clash Verge Rev 配置目录。')
    }
    const early = (state, reason) => fallback(running ? 'running' : state, running ? `${runningReason} ${reason}` : reason, { app: APP, running })
    let config
    try { config = readBounded(dir, CONFIG, MAX_CONFIG) } catch (error) {
      if (missingFile(error)) return early('not-found', missingConfig)
      return early('unsupported', '无法安全读取 Clash Verge Rev 的 GUI 配置 config.yaml。')
    }

    let yaml
    try { yaml = await import('./clash-yaml.js') } catch {
      return early('unsupported', '缺少读取 Clash YAML 所需的依赖。')
    }
    let tun, existing
    try {
      tun = yaml.readTunExclusions(config.buffer)
      existing = cidrs(tun.entries)
    } catch (error) {
      return early('unsupported', error.message === yaml.TUN_MAP_MISSING
        ? 'GUI 配置 config.yaml 尚未初始化 tun 映射；请先在 Clash Verge Rev 中设置 TUN。' : parseFailure)
    }

    let enabled = null, runtime = null, verge = null, effective = null, reason = ''
    try {
      verge = readBounded(dir, VERGE, MAX_CONFIG)
      enabled = yaml.readTunSwitch(verge.buffer)
      runtime = readBounded(dir, RUNTIME, MAX_RUNTIME)
      effective = cidrs(yaml.readTunExclusions(runtime.buffer, { generated: true }).entries)
      if (effective.some(item => !existing.some(local => covers(local, item)))) {
        reason = '当前生成配置包含未保存在 GUI 设置中的 TUN 排除项；为免覆盖，请手动配置。'
      }
    } catch (error) {
      if (enabled === null) {
        reason = missingFile(error) ? '未找到 GUI 设置 verge.yaml，无法确认 TUN 开关。'
          : verge ? 'GUI 设置 verge.yaml 中存在不受支持的 YAML 或 TUN 开关值。' : '无法安全读取 GUI 设置 verge.yaml。'
      } else {
        reason = missingFile(error) ? '未找到生成配置 clash-verge.yaml；请先用 Clash Verge Rev 生成配置。'
          : runtime ? '生成配置 clash-verge.yaml 中存在不受支持的 YAML（如语法错误或重复键）或 TUN 排除项。'
            : '无法安全读取生成配置 clash-verge.yaml。'
      }
    }
    const revision = filesRevision(config, runtime, verge, relays, running)
    const backup = await findBackup(dir, config, test)
    const warning = !relays.length ? missingRelays
      : !reason && tun.autoRoute === false ? '已保存的 TUN 自动路由已关闭；排除项只在启用自动路由时生效。' : ''
    const summary = summarize(running ? 'running' : reason ? 'unsupported' : 'ready',
      [running && runningReason, reason, warning].filter(Boolean).join(' '), relays, existing, {
        app: APP, running, enabled, revision, effective: effective && toText(effective), rollbackAvailable: Boolean(backup) && !running,
      })
    return { summary, dir, config, verge, runtime, relays, tun, yaml, backup }
  }

  function assertRequest(snapshot, revision, rollback) {
    if (snapshot.summary.running) throw blocked(423, runningReason)
    if (!snapshot.config || (snapshot.summary.state !== 'ready' && !rollback)) throw blocked(501, snapshot.summary.reason || parseFailure)
    if (revision !== snapshot.summary.revision) throw changed()
  }

  async function replace(snapshot, bytes, storeBackup) {
    const { dir, config, runtime, verge, relays } = snapshot
    let lock
    try { lock = writeExclusive(dir, LOCK, Buffer.alloc(0)) } catch (error) {
      if (error.code === 'EEXIST') throw blocked(409, '另一个 Clash 配置操作正在进行，或上次操作未正常退出。')
      throw blocked(409, '无法安全锁定 Clash 配置。')
    }
    let temp, tempStat, backup
    try {
      verifyFile(dir, CONFIG, config, MAX_CONFIG)
      temp = PREFIX + 'temp-' + randomId()
      tempStat = writeExclusive(dir, temp, bytes)
      const nextHash = sha(bytes)
      if (storeBackup) {
        backup = backupName(nextHash, tempStat.mtimeNs)
        const payload = Buffer.from(JSON.stringify({ version: 1, after: nextHash, modified: String(tempStat.mtimeNs),
          beforeHash: config.hash, before: config.buffer.toString('base64') }))
        const encrypted = await protectBackup(dir, payload, test)
        if (encrypted.length > MAX_BACKUP) throw new Error('backup-size')
        writeExclusive(dir, backup, encrypted)
        verifyFile(dir, VERGE, verge, MAX_CONFIG)
        verifyFile(dir, RUNTIME, runtime, MAX_RUNTIME)
        if (JSON.stringify(toText(readRelays(relayReader))) !== JSON.stringify(toText(relays))) throw changed()
      }
      if (test && processState()) throw blocked(423, runningReason)
      // Recheck after staging and backing up; don't replace a later edit.
      verifyFile(dir, CONFIG, config, MAX_CONFIG)
      if (test) {
        verifyFile(dir, temp, { hash: nextHash, stat: tempStat }, MAX_CONFIG)
        fs.renameSync(path.join(dir, temp), path.join(dir, CONFIG))
      } else {
        const result = await native('replace', { root: dir, temp, backup, size: Number(config.stat.size), modified: String(config.stat.mtimeNs), hash: config.hash,
          nextSize: bytes.length, nextModified: String(tempStat.mtimeNs), nextHash })
        if (result.result === 'changed') throw changed()
        if (result.result === 'running') throw blocked(423, runningReason)
        if (result.result !== 'ok') throw blocked(500, '未能确认 Clash 配置操作结果；请重新检测。')
      }
      if (!storeBackup) {
        const next = await capture()
        if (next.config?.hash !== nextHash) throw blocked(500, '未能确认 Clash 配置已恢复；请重新检测。')
        consumeBackup(dir, snapshot.backup)
        return next.summary
      }
    } catch (error) {
      if (error.status) throw error
      throw blocked(409, '无法安全备份或替换 Clash 配置；未尝试强制写入。')
    } finally {
      if (tempStat) removeOwned(dir, temp, tempStat)
      removeOwned(dir, LOCK, lock)
    }
  }

  return {
    async inspect() { return (await capture()).summary },
    async apply({ mode, revision } = {}) {
      if (mode !== 'relay' && mode !== 'campus') throw blocked(400, '无效的 Clash 排除模式。')
      const snapshot = await capture()
      assertRequest(snapshot, revision, false)
      if (!snapshot.relays.length) throw blocked(409, missingRelays)
      const { missing } = snapshot.summary.modes[mode]
      if (missing.length) {
        let next
        try {
          next = snapshot.tun.append(missing)
          const check = snapshot.yaml.readTunExclusions(next).entries
          if (next.length > MAX_CONFIG || JSON.stringify(check) !== JSON.stringify([...snapshot.tun.entries, ...missing])) throw new Error()
        } catch { throw blocked(501, parseFailure) }
        await replace(snapshot, next, true)
      }
      return (await capture()).summary
    },
    async rollback({ revision } = {}) {
      const snapshot = await capture()
      assertRequest(snapshot, revision, true)
      if (!snapshot.backup) throw blocked(409, '没有与当前配置匹配的安全备份；不会覆盖后续编辑。')
      const summary = await replace(snapshot, snapshot.backup.before, false)
      return { ...summary, result: 'rolled-back' }
    },
  }
}
