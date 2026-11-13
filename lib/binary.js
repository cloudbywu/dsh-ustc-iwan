/**
 * iwan-client-oidc 可执行文件的下载与解析（仿 Antigravity 线的 binary 设计）：
 *  - 已配置的路径优先，其次是缓存里已下载的副本；
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
  if (configuredPath) {
    try {
      fs.accessSync(configuredPath, fs.constants.X_OK)
      if (fs.statSync(configuredPath).isFile()) return { path: configuredPath, kind: 'configured' }
    } catch {}
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
    verifiedCache = { key, value }
    return { ...value }
  } catch (error) {
    verifiedCache = null
    return { error: 'iWAN 缓存校验失败（' + (error?.message ?? error) + '），请重新下载；可信的手动客户端可显式填写路径' }
  }
}

/** 下载状态（进程内，卡片轮询 GET /status 读取）。 */
const progress = { state: 'idle', bytes: 0, total: 0, error: null, at: null }
let activeDownload = null

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
export async function startDownload(log = () => {}, { timeoutMs = 300_000 } = {}) {
  if (activeDownload) return { started: false, reason: '已有下载在进行中' }
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
      report(`开始下载 iWAN 客户端：${DOWNLOAD_URL}`)
      let url = DOWNLOAD_URL
      let response
      for (let redirects = 0; ; redirects += 1) {
        controller.signal.throwIfAborted()
        if (new URL(url).protocol !== 'https:') throw new Error('拒绝非 HTTPS 下载地址')
        response = await fetch(url, { redirect: 'manual', signal: controller.signal })
        if (![301, 302, 303, 307, 308].includes(response.status)) break
        const location = response.headers.get('location')
        await response.body?.cancel()
        if (!location || redirects >= 5) throw new Error('下载重定向无效或次数过多')
        url = new URL(location, url).href
      }
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      if (response.url && new URL(response.url).protocol !== 'https:') throw new Error('拒绝非 HTTPS 下载响应')
      const declaredText = response.headers.get('content-length')
      const declared = declaredText === null ? 0 : Number(declaredText)
      if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_BINARY_BYTES) {
        await response.body.cancel()
        throw new Error('下载声明的文件大小无效或超过上限')
      }
      progress.total = declared
      const chunks = []
      reader = response.body.getReader()
      for (;;) {
        controller.signal.throwIfAborted()
        const { done, value } = await reader.read()
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
        url: DOWNLOAD_URL, archiveBytes: progress.bytes, bytes: binary.length,
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
      try { await reader?.cancel() } catch {}
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
