/** 交互托管 iwan-client-oidc --fetch；同一时刻仅允许一个活动认证。 */
import { spawn } from 'node:child_process'

const MAX_OUTPUT = 8192
const MAX_LINE = 16384
const STOP_GRACE_MS = 1000
const STOP_DEADLINE_MS = 1500
const retiring = new Set()
let active = null
let latest = null
let seq = 0

const duration = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback
const publicState = (session) => ({
  id: session.id, state: session.state, authorizeUrl: session.authorizeUrl, error: session.error,
})

function pickError(stdout, stderr, code) {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const explicit = lines.filter((line) => /^error\s*:/i.test(line))
  if (explicit.length) return explicit.at(-1).replace(/^error\s*:\s*/i, '')
  const rest = lines.filter((line) => !/^https?:\/\//.test(line) && !/^open in browser/i.test(line))
  return rest.at(-1) || stdout.trim() || ('认证进程以退出码 ' + code + ' 结束')
}

function extractAuthorizeUrl(line) {
  const match = line.match(/https:\/\/[^\s"'<>]+/)
  if (!match) return null
  const value = match[0].replace(/[),.]+$/, '')
  try { return new URL(value).protocol === 'https:' ? value : null } catch { return null }
}

function isRedirectUrl(value) {
  const text = String(value ?? '').trim()
  return text.length <= MAX_LINE && !/[\r\n\0]/.test(text) &&
    /^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !/^https?:\/\//i.test(text)
}

/**
 * 返回授权 URL 前可通过 authState().id + cancelAuth(id) 取消。
 * signal 覆盖 starting / awaiting / submitting，三个阶段均设独立期限。
 */
export function startAuth({
  exePath, configDir, log = () => {}, signal, onComplete,
  startTimeoutMs = 30_000, awaitTimeoutMs = 600_000, submitTimeoutMs = 30_000,
} = {}) {
  if (active) return Promise.reject(new Error('已有一个认证会话正在进行，请先完成或取消它'))
  if (retiring.size) return Promise.reject(new Error('上一次认证进程尚未退出，请等待清理完成后重试'))
  if (!exePath) return Promise.reject(new Error('尚未找到 iwan-client-oidc，请先下载客户端或填写「客户端路径」'))
  if (signal?.aborted) return Promise.reject(abortError())
  const args = ['--fetch']
  if (configDir) args.push('--config-dir', configDir)
  const report = (message) => { try { log(message) } catch {} }

  return new Promise((resolve, reject) => {
    const session = {
      id: 'auth-' + (++seq), state: 'starting', authorizeUrl: null, error: null,
      child: null, timer: null, terminal: false,
      buffer: { stdout: '', stderr: '' },
      pending: { stdout: '', stderr: '' }, overflow: { stdout: false, stderr: false },
    }
    active = session
    let forceTimer = null
    let cleanupTimer = null
    let processExited = false
    let terminationStarted = false
    let cleanupSettled = false
    let resolveCleanup
    let rejectCleanup
    session.cleanupPromise = new Promise((done, fail) => { resolveCleanup = done; rejectCleanup = fail })
    // 清理超时可能早于 runtime 调用 wait；预装处理器避免未处理拒绝。
    session.cleanupPromise.catch(() => {})
    let startSettled = false
    const clearPhase = () => { clearTimeout(session.timer); session.timer = null }
    const onAbort = () => session.fail(abortError(), true)
    const detachOutput = () => {
      session.child?.stdout?.removeListener('data', onStdout)
      session.child?.stderr?.removeListener('data', onStderr)
    }
    const releaseProcess = () => {
      processExited = true
      clearTimeout(forceTimer)
      clearTimeout(cleanupTimer)
      retiring.delete(session)
      detachOutput()
      session.child = null
      if (!cleanupSettled) { cleanupSettled = true; resolveCleanup() }
    }
    const terminate = () => {
      const child = session.child
      if (!child || processExited || child.exitCode != null || child.signalCode != null) { releaseProcess(); return }
      if (terminationStarted) return
      terminationStarted = true
      try { child.stdin?.destroy() } catch {}
      try { child.kill() } catch {}
      if (processExited || child.exitCode != null || child.signalCode != null) { releaseProcess(); return }
      forceTimer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch {}
        if (child.exitCode != null || child.signalCode != null) releaseProcess()
      }, STOP_GRACE_MS)
      cleanupTimer = setTimeout(() => {
        if (child.exitCode != null || child.signalCode != null) { releaseProcess(); return }
        // 不伪造退出：保留互斥直到真正 exit/close；数量因启动互斥而有界。
        cleanupSettled = true
        const error = new Error('认证进程终止超时，尚未确认退出，已阻止启动新认证')
        error.name = 'TimeoutError'
        rejectCleanup(error)
      }, STOP_DEADLINE_MS)
      forceTimer.unref?.()
    }
    session.terminate = terminate
    const finish = (state, error, kill = false) => {
      if (session.terminal) return
      session.terminal = true
      session.state = state
      session.error = error?.message ?? null
      clearPhase()
      signal?.removeEventListener('abort', onAbort)
      detachOutput()
      latest = publicState(session)
      if (session.child && !processExited) retiring.add(session)
      if (active === session) active = null
      if (!startSettled) {
        startSettled = true
        reject(error ?? new Error('认证进程未给出授权地址'))
      }
      session.buffer = { stdout: '', stderr: '' }
      session.pending = { stdout: '', stderr: '' }
      if (kill) terminate()
    }
    session.fail = (error, kill = true) => finish('failed', error, kill)
    session.arm = (ms, message) => {
      clearPhase()
      session.timer = setTimeout(() => session.fail(new Error(message)), ms)
      session.timer.unref?.()
    }
    session.submitTimeoutMs = duration(submitTimeoutMs, 30_000)
    const acceptLine = (line) => {
      if (session.state !== 'starting') return
      const url = extractAuthorizeUrl(line)
      if (!url) return
      session.authorizeUrl = url
      session.state = 'awaiting'
      session.arm(duration(awaitTimeoutMs, 600_000), '等待授权回调超时，已结束本次认证')
      report('已获取授权地址，等待粘贴回调 URL')
      if (session.terminal) return
      startSettled = true
      resolve({ id: session.id, authorizeUrl: url })
    }
    const collect = (stream, chunk) => {
      if (session.terminal) return
      const text = String(chunk)
      session.buffer[stream] = (session.buffer[stream] + text).slice(-MAX_OUTPUT)
      let offset = 0
      while (offset < text.length) {
        const newline = text.indexOf('\n', offset)
        const end = newline < 0 ? text.length : newline
        if (!session.overflow[stream]) {
          if (session.pending[stream].length + end - offset > MAX_LINE) {
            session.pending[stream] = ''
            session.overflow[stream] = true
          } else session.pending[stream] += text.slice(offset, end)
        }
        if (newline < 0) break
        if (!session.overflow[stream]) acceptLine(session.pending[stream])
        session.pending[stream] = ''
        session.overflow[stream] = false
        offset = newline + 1
      }
    }
    const onStdout = (chunk) => collect('stdout', chunk)
    const onStderr = (chunk) => collect('stderr', chunk)
    try {
      const child = spawn(exePath, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      session.child = child
      // error 是异步事件；stdin 的 EPIPE 也不能只用 try/catch 处理。
      child.on('error', (error) => session.fail(error))
      child.stdin?.on('error', (error) => session.fail(error))
      child.once('exit', (code, exitSignal) => {
        releaseProcess()
        if (session.terminal) return
        if (session.state === 'submitting' && code === 0 && !exitSignal) {
          finish('done', null)
          report('统一身份认证完成，线路配置已保存')
          try {
            Promise.resolve(onComplete?.()).catch(() => report('认证完成后的自动操作失败，请检查托管状态'))
          } catch { report('认证完成后的自动操作失败，请检查托管状态') }
        } else session.fail(new Error(pickError(session.buffer.stdout, session.buffer.stderr, code ?? exitSignal)), false)
      })
      child.once('close', () => {
        releaseProcess()
        if (!session.terminal) session.fail(new Error('认证进程已关闭'), false)
        detachOutput()
      })
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', onStdout)
      child.stderr?.on('data', onStderr)
      session.arm(duration(startTimeoutMs, 30_000), '认证进程没有给出授权地址（超时）')
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
      report('开始统一身份认证：' + exePath + ' ' + args.join(' '))
    } catch (error) { session.fail(error) }
  })
}

/** 提交后立即返回；最终结果通过 authState() 查询，stdin 异步错误会置 failed。 */
export function submitRedirect(id, redirectUrl) {
  const session = active
  if (!session || session.id !== String(id ?? '')) return { error: '认证会话不存在或已结束' }
  if (session.state !== 'awaiting') return { error: '认证会话当前不接受回调 URL（状态：' + session.state + '）' }
  if (!isRedirectUrl(redirectUrl)) return { error: '请粘贴浏览器跳转后的完整回调 URL（自定义协议且不可包含换行）' }
  session.state = 'submitting'
  session.arm(session.submitTimeoutMs, '提交授权回调超时，已结束本次认证')
  try {
    session.child.stdin.end(String(redirectUrl).trim() + '\n', (error) => {
      if (error) session.fail(error)
    })
  } catch (error) { session.fail(error) }
  return session.error ? { error: session.error } : { id: session.id }
}

/** starting / awaiting / submitting 都可取消；终态不会被迟到的 exit 覆盖。 */
export function cancelAuth(id) {
  const key = String(id ?? '')
  if (active?.id === key) {
    active.fail(abortError())
    return { cancelled: true }
  }
  if (latest?.id === key) return { cancelled: false, state: latest.state }
  return { error: '认证会话不存在或已结束' }
}

/** 插件 stop/dispose 同步发起清理，包括公开终态但尚未退出的进程。 */
export function cancelAllAuth() {
  const targets = new Set(retiring)
  if (active) targets.add(active)
  for (const session of targets) {
    if (!session.terminal) session.fail(abortError())
    else session.terminate()
  }
  return { cancelled: targets.size }
}

export const disposeAuth = cancelAllAuth

/**
 * cancelAllAuth() 后 await 本函数，等待已请求终止的认证进程。
 * 1s 升级 SIGKILL，1.5s 未确认退出则 reject TimeoutError，仍保留启动互斥。
 */
export async function waitForAuthCleanup() {
  await Promise.all([...retiring].map((session) => session.cleanupPromise))
}

export function authState() {
  return active ? publicState(active) : latest ? { ...latest } :
    { state: 'idle', id: null, authorizeUrl: null, error: null }
}

function abortError() {
  const error = new Error('认证已取消')
  error.name = 'AbortError'
  return error
}
