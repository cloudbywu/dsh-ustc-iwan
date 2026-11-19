/**
 * iwan-client-oidc 可执行文件的下载与解析（仿 Antigravity 线的 binary 设计）：
 *  - 有显式路径时只用该文件；留空才使用已校验的下载缓存；
 *  - 下载只走 HTTPS（GitHub Releases），设大小上限，半截文件按名删除，
 *    成功后记录 sha256 供下次校验；
 *  - 上游发的是 zip，这里负责解出那一个 exe；
 *  - 绝不装进 PATH、不做任何系统级安装。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { resolveDshHome } from './home.js'

/** 缓存目录：<DSH_HOME>/cache/ustc-iwan/。 */
export function cacheRoot() {
  return path.join(resolveDshHome(), 'cache', 'ustc-iwan')
}

export const BINARY_NAME = 'iwan-client-oidc-windows-x86_64.exe'
/**
 * 归档名。上游（yyy1mu/ustc-iwan）的 release 只发布 zip，不发布裸 exe：
 * 直接请求 `…/download/iwan-client-oidc-windows-x86_64.exe` 会得到 404，
 * 因此下载的是压缩包，再从中解出同名 exe。
 */
export const ARCHIVE_NAME = 'iwan-client-oidc-windows-x86_64.zip'
/** GitHub Releases 的 latest 跳转下载地址（302 → objects.githubusercontent.com，仍为 https）。 */
export const DOWNLOAD_URL = 'https://github.com/yyy1mu/ustc-iwan/releases/latest/download/' + ARCHIVE_NAME
/** 下载大小上限：压缩包约 2 MB、解出后约 4 MB，留足余量。 */
export const MAX_BINARY_BYTES = 96 * 1024 * 1024

export function cachedBinaryPath() {
  return path.join(cacheRoot(), BINARY_NAME)
}

// stat 指纹变更时才重新哈希，避免状态轮询反复同步读取整个 exe。
let verifiedCache = null
const fingerprint = (stat) => [stat.size, stat.mtimeNs, stat.ctimeNs, stat.ino].join(':')

/** 手动路径是用户显式信任的文件；自动缓存必须有匹配的元数据。 */
export function resolveBinary(configuredPath) {
  const manual = configuredPath?.trim()
  if (manual) {
    try {
      fs.accessSync(manual, fs.constants.X_OK)
      if (fs.statSync(manual).isFile()) return { path: manual, kind: 'configured' }
    } catch {}
    return { error: '配置的 iWAN 客户端路径不是可执行文件或不可访问；请修正路径，或清空后使用已下载的副本' }
  }
  const cached = cachedBinaryPath()
  let binaryStat
  try {
    fs.accessSync(cached, fs.constants.X_OK)
    binaryStat = fs.statSync(cached, { bigint: true })
    if (!binaryStat.isFile() || binaryStat.size <= 0n || binaryStat.size > BigInt(MAX_BINARY_BYTES)) throw new Error('缓存文件无效')
  } catch { return { error: '尚未配置，也没有可用的 iwan-client-oidc' } }
  try {
    const metaPath = cached + '.meta.json'
    const metaStat = fs.statSync(metaPath, { bigint: true })
    if (!metaStat.isFile() || metaStat.size > 16_384n) throw new Error('校验记录无效')
    const key = [cached, fingerprint(binaryStat), fingerprint(metaStat)].join('|')
    if (verifiedCache?.key === key) return { ...verifiedCache.value }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    if (!Number.isSafeInteger(meta.bytes) || BigInt(meta.bytes) !== binaryStat.size || !/^[a-f0-9]{64}$/i.test(meta.sha256)) throw new Error('校验记录无效')
    const hash = crypto.createHash('sha256').update(fs.readFileSync(cached)).digest('hex')
    if (hash !== meta.sha256.toLowerCase()) throw new Error('SHA-256 不匹配')
    const value = { path: cached, kind: 'downloaded' }
    verifiedCache = { key, value, meta }
    return { ...value }
  } catch (error) {
    verifiedCache = null
    return { error: 'iWAN 缓存校验失败（' + (error?.message ?? error) + '），请重新下载；可信的手动客户端可显式填写路径' }
  }
}

/** 下载状态（进程内，卡片轮询 GET /status 读取）。 */
const progress = { state: 'idle', bytes: 0, total: 0, error: null, at: null }
let activeDownload = null
let activeUpdateCheck = null
let updateStatus = null

export const RELEASE_API_URL = 'https://api.github.com/repos/yyy1mu/ustc-iwan/releases/latest'
const MAX_RELEASE_BYTES = 512 * 1024
const validTag = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(value)
const safeLog = (log, message) => { try { log(message) } catch {} }

function updates() {
  const scope = cachedBinaryPath()
  if (updateStatus?.scope !== scope) updateStatus = { scope, checking: false, latestVersion: null, checkedAt: null, updateError: null, release: null }
  return updateStatus
}

// 比较可识别的版本，未知命名返回 null；不能把任意不同 tag 都当作升级。
function compareVersions(left, right) {
  if (left === right) return 0
  const parse = (value) => /^[vV]?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value)
  const a = parse(left), b = parse(right)
  if (!a || !b) return null
  for (let i = 1; i <= 3; i++) {
    const x = BigInt(a[i] || '0'), y = BigInt(b[i] || '0')
    if (x !== y) return x < y ? -1 : 1
  }
  if (!a[4] || !b[4]) return a[4] === b[4] ? 0 : a[4] ? -1 : 1
  const x = a[4].split('.'), y = b[4].split('.')
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === y[i]) continue
    if (x[i] === undefined || y[i] === undefined) return x[i] === undefined ? -1 : 1
    const nx = /^[0-9]+$/.test(x[i]), ny = /^[0-9]+$/.test(y[i])
    if (nx && ny) { if (BigInt(x[i]) !== BigInt(y[i])) return BigInt(x[i]) < BigInt(y[i]) ? -1 : 1; continue }
    if (nx !== ny) return nx ? -1 : 1
    return x[i] < y[i] ? -1 : 1
  }
  return 0
}

/** 仅检查文件与持久化记录；不联网，也不执行用户指定的客户端。 */
export function binaryState(configuredPath = '') {
  const resolved = resolveBinary(configuredPath)
  const downloaded = resolved.kind === 'downloaded'
  const meta = downloaded ? verifiedCache?.meta : null
  const version = validTag(meta?.version) ? meta.version : null
  const at = typeof meta?.at === 'number' ? meta.at : typeof meta?.at === 'string' ? Date.parse(meta.at) : NaN
  const status = updates()
  const comparison = version && status.latestVersion ? compareVersions(version, status.latestVersion) : null
  return {
    ...resolved, installed: Boolean(resolved.path), downloaded, version,
    installedAt: downloaded && Number.isFinite(at) && at > 0 ? at : null,
    checking: status.checking, latestVersion: status.latestVersion,
    updateAvailable: comparison === null ? null : comparison < 0, versionComparison: comparison,
    checkedAt: status.checkedAt, updateError: status.updateError,
  }
}

function trustedDownloadUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:') throw new Error('拒绝非 HTTPS 下载地址')
  if (url.username || url.password || url.port || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com'].includes(url.hostname)) throw new Error('拒绝不可信的 GitHub 下载地址')
  return url
}

function releaseTagFromUrl(value) {
  const url = trustedDownloadUrl(value)
  if (url.hostname !== 'github.com' || url.search || url.hash) return null
  const match = /^\/yyy1mu\/ustc-iwan\/releases\/download\/([^/]+)\/([^/]+)$/.exec(url.pathname)
  if (!match || decodeURIComponent(match[2]) !== ARCHIVE_NAME) return null
  const tag = decodeURIComponent(match[1])
  return validTag(tag) ? tag : null
}

// Abort races also bound mocks/streams that do not themselves honor AbortSignal.
function abortable(promise, signal) {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(promise).then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}

async function latestRelease(signal) {
  signal.throwIfAborted()
  const response = await abortable(fetch(RELEASE_API_URL, {
    method: 'GET', redirect: 'error', signal, headers: { Accept: 'application/vnd.github+json' },
  }), signal)
  let reader
  try {
    if (!response.ok || !response.body) throw new Error(`更新检查 HTTP ${response.status}`)
    if (response.url && response.url !== RELEASE_API_URL) throw new Error('更新检查响应地址不可信')
    const length = response.headers.get('content-length')
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RELEASE_BYTES)) throw new Error('Release JSON 大小超过上限或无效')
    reader = response.body.getReader()
    const chunks = []
    let bytes = 0
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal)
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_RELEASE_BYTES) throw new Error('Release JSON 大小超过上限')
      chunks.push(Buffer.from(value))
    }
    const release = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!validTag(release?.tag_name) || release.draft === true || release.prerelease === true || !Array.isArray(release.assets)) throw new Error('Release tag_name 或资产信息无效')
    const assets = release.assets.filter(asset => asset?.name === ARCHIVE_NAME)
    if (assets.length !== 1 || typeof assets[0].browser_download_url !== 'string') throw new Error(`Release 缺少唯一的 ${ARCHIVE_NAME}`)
    const url = assets[0].browser_download_url
    if (releaseTagFromUrl(url) !== release.tag_name) throw new Error('Release 资产地址与 tag_name 不匹配')
    // Construct our own canonical URL, never blindly download an external JSON value.
    return { version: release.tag_name, tag: release.tag_name, url: `https://github.com/yyy1mu/ustc-iwan/releases/download/${encodeURIComponent(release.tag_name)}/${ARCHIVE_NAME}`, source: RELEASE_API_URL }
  } finally {
    try {
      if (reader) {
        void reader.cancel().catch(() => {})
        reader.releaseLock()
      } else {
        void response.body?.cancel().catch(() => {})
      }
    } catch {}
  }
}

/** 显式调用才查询；并发调用复用同一任务，失败不改变已安装副本。 */
export function checkForUpdates(configuredPath = '', log = () => {}, { timeoutMs = 15_000 } = {}) {
  if (activeUpdateCheck) return activeUpdateCheck.promise
  if (activeDownload) return Promise.resolve({ started: false, reason: '已有下载在进行中', error: '已有下载在进行中' })
  const status = updates()
  const controller = new AbortController()
  const active = { controller, promise: null }
  activeUpdateCheck = active
  Object.assign(status, { checking: true, updateError: null })
  const timer = setTimeout(() => controller.abort(new Error('更新检查超时，已中止')), timeoutMs)
  active.promise = Promise.resolve().then(async () => {
    try {
      const release = await latestRelease(controller.signal)
      controller.signal.throwIfAborted()
      Object.assign(status, { release, latestVersion: release.version, checkedAt: Date.now(), updateError: null })
      safeLog(log, `最新 iWAN 客户端版本：${release.version}`)
    } catch (error) {
      status.updateError = error instanceof Error ? error.message : String(error)
      safeLog(log, `iWAN 更新检查失败：${status.updateError}`)
    } finally {
      clearTimeout(timer)
      status.checking = false
      if (activeUpdateCheck === active) activeUpdateCheck = null
    }
    return { started: true, ...binaryState(configuredPath) }
  })
  return active.promise
}

export function waitForUpdateCheck() {
  return activeUpdateCheck?.promise ?? Promise.resolve()
}

export function cancelUpdateCheck() {
  const active = activeUpdateCheck
  if (!active) return Promise.resolve()
  active.controller.abort(new Error('更新检查已取消'))
  return active.promise
}

/** 取消并等待后台下载退出；卸载插件时必须等待临时文件清理。 */
export function cancelDownload() {
  const active = activeDownload
  if (!active) return Promise.resolve()
  active.controller.abort(new Error('下载已取消'))
  return active.promise
}

/** 等待当前下载结束，不发起新的网络操作。 */
export function waitForDownload() {
  return activeDownload?.promise ?? Promise.resolve()
}

export function downloadState() {
  return { ...progress }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * 从一个 zip 缓冲里取出目标条目。只做仓储型的单文件解包：
 * 支持 stored(0) 与 deflate(8) 两种压缩方式，并逐条校验 CRC32。
 * @param {Buffer} archive 完整 zip
 * @param {string} fileName 只按 basename 匹配，允许上游把文件放在子目录里
 * @returns {Buffer} 解出的文件内容
 */
export function extractFromZip(archive, fileName) {
  const END_SIGNATURE = 0x06054b50
  let eocd = -1
  for (let offset = archive.length - 22; offset >= 0 && offset >= archive.length - 22 - 0xffff; offset -= 1) {
    if (archive.readUInt32LE(offset) === END_SIGNATURE && offset + 22 + archive.readUInt16LE(offset + 20) === archive.length) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new Error('压缩包不是合法的 zip（找不到目录结尾记录）')

  if (eocd + 22 + archive.readUInt16LE(eocd + 20) !== archive.length) throw new Error('压缩包结尾记录损坏')
  const entries = archive.readUInt16LE(eocd + 10)
  if (archive.readUInt16LE(eocd + 4) !== 0 || archive.readUInt16LE(eocd + 6) !== 0 || archive.readUInt16LE(eocd + 8) !== entries || entries === 0xffff) throw new Error('不支持分卷或 ZIP64 压缩包')
  const directorySize = archive.readUInt32LE(eocd + 12)
  const directoryStart = archive.readUInt32LE(eocd + 16)
  const directoryEnd = directoryStart + directorySize
  if (directoryEnd > eocd || directorySize < entries * 46) throw new Error('压缩包目录越界')
  let cursor = directoryStart
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > directoryEnd || archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error('压缩包目录项损坏')
    const flags = archive.readUInt16LE(cursor + 8)
    const method = archive.readUInt16LE(cursor + 10)
    const expectedCrc = archive.readUInt32LE(cursor + 16)
    const compressedSize = archive.readUInt32LE(cursor + 20)
    const uncompressedSize = archive.readUInt32LE(cursor + 24)
    const nameLength = archive.readUInt16LE(cursor + 28)
    const extraLength = archive.readUInt16LE(cursor + 30)
    const commentLength = archive.readUInt16LE(cursor + 32)
    const localOffset = archive.readUInt32LE(cursor + 42)
    if (cursor + 46 + nameLength + extraLength + commentLength > directoryEnd) throw new Error('压缩包目录项越界')
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    cursor += 46 + nameLength + extraLength + commentLength

    if (path.posix.basename(name) !== fileName) continue
    if ((flags & 1) !== 0) throw new Error('不支持加密的压缩包')
    if (uncompressedSize === 0 || uncompressedSize > MAX_BINARY_BYTES) throw new Error('压缩包内的可执行文件大小无效或超过上限')
    if (compressedSize > MAX_BINARY_BYTES || localOffset + 30 > directoryStart || archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('压缩包本地文件头损坏')
    if (archive.readUInt16LE(localOffset + 8) !== method || archive.readUInt16LE(localOffset + 6) !== flags) throw new Error('压缩包文件头不一致')

    const localNameLength = archive.readUInt16LE(localOffset + 26)
    const localExtraLength = archive.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    if (dataStart + compressedSize > directoryStart || archive.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8') !== name) throw new Error('压缩包文件数据越界或名称不一致')
    const raw = archive.subarray(dataStart, dataStart + compressedSize)

    let content
    if (method === 0) content = Buffer.from(raw)
    else if (method === 8) content = zlib.inflateRawSync(raw, { maxOutputLength: Math.min(uncompressedSize, MAX_BINARY_BYTES) })
    else throw new Error(`压缩包使用了不支持的压缩方式：${method}`)

    if (content.length !== uncompressedSize) throw new Error('解出的文件大小与目录记录不符')
    if (crc32(content) !== expectedCrc) throw new Error('解出的文件校验和不符')
    return content
  }
  throw new Error(`压缩包里没有 ${fileName}`)
}

/** 保留旧 exe，直到新元数据也替换成功；捕获到的替换失败会回滚旧副本。 */
function installBinaryPair(target, part, metaPart) {
  const backup = target + '.backup-' + crypto.randomUUID()
  let hasBackup = false
  let switched = false
  let preserveBackup = false
  try {
    if (fs.existsSync(target)) {
      fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL)
      hasBackup = true
    }
    fs.renameSync(part, target)
    switched = true
    fs.renameSync(metaPart, target + '.meta.json')
    switched = false
  } catch (error) {
    if (switched) {
      try {
        if (hasBackup) fs.renameSync(backup, target)
        else fs.rmSync(target, { force: true })
      } catch (rollbackError) {
        preserveBackup = hasBackup
        throw new Error('缓存替换与回滚失败；旧副本保留于 ' + backup + '：' + rollbackError.message, { cause: error })
      }
    }
    throw error
  } finally {
    if (hasBackup && !preserveBackup) { try { fs.rmSync(backup, { force: true }) } catch {} }
  }
}

/**
 * 开始下载（幂等：进行中时直接返回）。完成后写 .meta.json（url/bytes/sha256）。
 * 失败时把半截文件与临时产物都删掉，状态记 error。
 */
export async function startDownload(log = () => {}, { timeoutMs = 300_000, mode = 'download' } = {}) {
  if (activeDownload) return { started: false, reason: '已有下载在进行中' }
  if (activeUpdateCheck) return { started: false, reason: '正在检查更新，请稍后重试', error: '正在检查更新，请稍后重试' }
  if (!['download', 'update', 'reinstall'].includes(mode)) return { started: false, reason: '下载模式无效', error: '下载模式无效' }
  const status = updates()
  const checkedRelease = mode === 'update' ? status.release : null
  if (mode === 'update' && !checkedRelease) return { started: false, reason: '请先检查更新', error: '请先检查更新' }
  if (mode === 'update' && binaryState().updateAvailable === false) return { started: false, reason: '当前缓存版本不低于最新发行版，无需更新' }
  const installed = mode === 'reinstall' ? binaryState() : null
  const reinstallRelease = installed?.downloaded && validTag(installed.version) ? {
    version: installed.version, tag: installed.version, source: 'installed-cache-version',
    url: `https://github.com/yyy1mu/ustc-iwan/releases/download/${encodeURIComponent(installed.version)}/${ARCHIVE_NAME}`,
  } : null
  const report = (message) => { try { log(message) } catch {} }
  Object.assign(progress, { state: 'downloading', bytes: 0, total: 0, error: null, at: Date.now() })
  const target = cachedBinaryPath()
  const part = target + '.part'
  const metaPart = target + '.meta.json.part'
  const controller = new AbortController()
  const active = { controller, promise: null }
  activeDownload = active
  const timer = setTimeout(() => controller.abort(new Error('下载超时，已中止')), timeoutMs)
  timer.unref?.()
  active.promise = Promise.resolve().then(async () => {
    let reader
    try {
      fs.mkdirSync(cacheRoot(), { recursive: true })
      const release = mode === 'reinstall' ? (reinstallRelease ?? await latestRelease(controller.signal)) : checkedRelease
      if (mode === 'reinstall' && !reinstallRelease) Object.assign(status, { release, latestVersion: release.version, checkedAt: Date.now(), updateError: null })
      const sourceUrl = release?.url ?? DOWNLOAD_URL
      report(`开始下载 iWAN 客户端：${sourceUrl}`)
      let url = sourceUrl
      let version = release?.version ?? null
      let response
      for (let redirects = 0; ; redirects += 1) {
        controller.signal.throwIfAborted()
        const requestedUrl = trustedDownloadUrl(url)
        const redirectedTag = releaseTagFromUrl(url)
        if (requestedUrl.hostname === 'github.com' && url !== DOWNLOAD_URL && !redirectedTag) throw new Error('拒绝不可信的 GitHub Release 资产路径')
        if (release && redirectedTag && redirectedTag !== release.tag) throw new Error('下载重定向版本与已选 Release 不匹配')
        if (redirectedTag) version = redirectedTag
        response = await abortable(fetch(url, { redirect: 'manual', signal: controller.signal }), controller.signal)
        if (![301, 302, 303, 307, 308].includes(response.status)) break
        const location = response.headers.get('location')
        if (response.body) await abortable(response.body.cancel(), controller.signal)
        if (!location || redirects >= 5) throw new Error('下载重定向无效或次数过多')
        url = new URL(location, url).href
      }
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      if (response.url) {
        const finalUrl = trustedDownloadUrl(response.url)
        const finalTag = releaseTagFromUrl(response.url)
        if (finalUrl.hostname === 'github.com' && response.url !== DOWNLOAD_URL && !finalTag) throw new Error('拒绝不可信的 GitHub Release 资产路径')
        if (release && finalTag && finalTag !== release.tag) throw new Error('下载响应版本与已选 Release 不匹配')
        if (finalTag) version = finalTag
      }
      const declaredText = response.headers.get('content-length')
      const declared = declaredText === null ? 0 : Number(declaredText)
      if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_BINARY_BYTES) {
        await abortable(response.body.cancel(), controller.signal)
        throw new Error('下载声明的文件大小无效或超过上限')
      }
      progress.total = declared
      const chunks = []
      reader = response.body.getReader()
      for (;;) {
        controller.signal.throwIfAborted()
        const { done, value } = await abortable(reader.read(), controller.signal)
        controller.signal.throwIfAborted()
        if (done) break
        progress.bytes += value.byteLength
        if (progress.bytes > MAX_BINARY_BYTES) throw new Error('文件超过大小上限，已中止')
        chunks.push(Buffer.from(value))
      }
      if (declaredText !== null && progress.bytes !== declared) throw new Error(`字节数不符：声明 ${declared}，实收 ${progress.bytes}`)
      report('下载完成，正在解出 iwan-client-oidc…')
      const binary = extractFromZip(Buffer.concat(chunks), BINARY_NAME)
      controller.signal.throwIfAborted()
      const meta = {
        url: sourceUrl, finalUrl: url, source: release?.source ?? DOWNLOAD_URL,
        version, releaseTag: version, mode, archiveBytes: progress.bytes, bytes: binary.length,
        sha256: crypto.createHash('sha256').update(binary).digest('hex'), at: new Date().toISOString(),
      }
      fs.writeFileSync(part, binary, { mode: 0o700 })
      fs.writeFileSync(metaPart, JSON.stringify(meta, null, 2))
      installBinaryPair(target, part, metaPart)
      verifiedCache = null
      progress.state = 'done'
      report(`iWAN 客户端下载完成：${target}（${meta.bytes} 字节，sha256 ${meta.sha256.slice(0, 12)}…）`)
    } catch (error) {
      controller.abort(error)
      progress.state = 'error'
      progress.error = error instanceof Error ? error.message : String(error)
      report(`iWAN 客户端下载失败：${progress.error}`)
    } finally {
      clearTimeout(timer)
      try { void reader?.cancel().catch(() => {}) } catch {}
      try { reader?.releaseLock() } catch {}
      for (const leftover of [part, metaPart]) {
        try { fs.rmSync(leftover, { force: true }) } catch {}
      }
      progress.at = Date.now()
      if (activeDownload === active) activeDownload = null
    }
  })
  return { started: true }
}
