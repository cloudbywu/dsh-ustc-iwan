/**
 * iwan-client-oidc 可执行文件的下载与解析（仿 Antigravity 线的 binary 设计）：
 *  - 已配置的路径优先，其次是缓存里已下载的副本；
 *  - 下载只走 HTTPS（GitHub Releases），设大小上限，半截文件按名删除，
 *    成功后记录 sha256 供下次校验；
 *  - 绝不装进 PATH、不做任何系统级安装。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { resolveDshHome } from './home.js'

/** 缓存目录：<DSH_HOME>/cache/ustc-iwan/。 */
export function cacheRoot() {
  return path.join(resolveDshHome(), 'cache', 'ustc-iwan')
}

export const BINARY_NAME = 'iwan-client-oidc-windows-x86_64.exe'
/** GitHub Releases 的 latest 跳转下载地址（302 → objects.githubusercontent.com，仍为 https）。 */
export const DOWNLOAD_URL = 'https://github.com/yyy1mu/ustc-iwan/releases/latest/download/' + BINARY_NAME
/** 下载大小上限：Windows 产物约 10 MB，留足余量。 */
export const MAX_BINARY_BYTES = 96 * 1024 * 1024

export function cachedBinaryPath() {
  return path.join(cacheRoot(), BINARY_NAME)
}

/** 已配置路径 > 缓存副本。 */
export function resolveBinary(configuredPath) {
  if (configuredPath) {
    try {
      fs.accessSync(configuredPath, fs.constants.X_OK)
      return { path: configuredPath, kind: 'configured' }
    } catch {}
  }
  const cached = cachedBinaryPath()
  try {
    fs.accessSync(cached, fs.constants.X_OK)
    return { path: cached, kind: 'downloaded' }
  } catch {}
  return { error: '尚未配置，也没有已下载的 iwan-client-oidc' }
}

/** 下载状态（进程内，卡片轮询 GET /status 读取）。 */
const progress = { state: 'idle', bytes: 0, total: 0, error: null, at: null }

export function downloadState() {
  return { ...progress }
}

/**
 * 开始下载（幂等：进行中时直接返回）。完成后写 .meta.json（url/bytes/sha256）。
 * 失败时把半截文件删掉，状态记 error。
 */
export async function startDownload(log = () => {}) {
  if (progress.state === 'downloading') return { started: false, reason: '已有下载在进行中' }
  progress.state = 'downloading'
  progress.bytes = 0
  progress.total = 0
  progress.error = null
  progress.at = Date.now()
  const target = cachedBinaryPath()
  const part = target + '.part'
  void (async () => {
    try {
      fs.mkdirSync(cacheRoot(), { recursive: true })
      log(`开始下载 iWAN 客户端：${DOWNLOAD_URL}`)
      const response = await fetch(DOWNLOAD_URL, { redirect: 'follow' })
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`)
      }
      const declared = Number(response.headers.get('content-length')) || 0
      progress.total = declared
      const hash = crypto.createHash('sha256')
      const out = fs.createWriteStream(part)
      const reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        progress.bytes += value.byteLength
        if (progress.bytes > MAX_BINARY_BYTES) throw new Error('文件超过大小上限，已中止')
        hash.update(value)
        out.write(Buffer.from(value))
      }
      await new Promise((resolve, reject) => {
        out.end(resolve)
        out.on('error', reject)
      })
      if (progress.total && progress.bytes !== progress.total) {
        throw new Error(`字节数不符：声明 ${progress.total}，实收 ${progress.bytes}`)
      }
      fs.renameSync(part, target)
      const meta = {
        url: DOWNLOAD_URL,
        bytes: progress.bytes,
        sha256: hash.digest('hex'),
        at: new Date().toISOString(),
      }
      fs.writeFileSync(target + '.meta.json', JSON.stringify(meta, null, 2))
      progress.state = 'done'
      progress.at = Date.now()
      log(`iWAN 客户端下载完成：${target}（${meta.bytes} 字节，sha256 ${meta.sha256.slice(0, 12)}…）`)
    } catch (error) {
      progress.state = 'error'
      progress.error = error instanceof Error ? error.message : String(error)
      progress.at = Date.now()
      try {
        fs.rmSync(part, { force: true })
      } catch {}
      log(`iWAN 客户端下载失败：${progress.error}`)
    }
  })()
  return { started: true }
}
