/** iWAN 客户端托管：已有 TCP 监听时不重复启动，也不停止外部进程。 */
import { spawn } from 'node:child_process'
import net from 'node:net'

function abortError() {
  const error = new Error('iWAN 客户端启动或连接已取消')
  error.name = 'AbortError'
  return error
}

function abortReason(signal) {
  return signal.reason?.name === 'TimeoutError' ? signal.reason : abortError()
}

/** 可取消的 TCP 探测；异常端口参数 reject，连接拒绝/探测超时为 false。 */
export function isPortOpen(port, host = '127.0.0.1', timeoutMs = 800, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(abortReason(signal))
  return new Promise((resolve, reject) => {
    let socket
    let timer
    let settled = false
    const done = (value, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      socket?.destroy()
      if (error) reject(error)
      else resolve(value)
    }
    const onAbort = () => done(false, abortReason(signal))
    try {
      socket = net.connect({ host, port })
      socket.once('connect', () => done(true))
      socket.on('error', () => done(false))
      timer = setTimeout(() => done(false), timeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    } catch (error) { done(false, error) }
  })
}

/** 上游默认 DNS 在校内服务器侧可能不可达，使用校内 DNS。 */
export const DEFAULT_IWAN_DNS = '202.38.64.1'

/**
 * signal 覆盖初次探测、启动待就绪及就绪后的整个托管生命周期。
 * 句柄：managed getter、isAlive()、onExit(listener)、stop(): Promise<void>。
 * stop 立即标记非活动，并有界等待退出；不向外部监听端口发送终止信号。
 */
export async function ensureIwanClient({
  exePath, server, socksHost = '127.0.0.1', socksPort = 1080,
  dns = DEFAULT_IWAN_DNS, extraArgs = [], log = () => {}, signal,
  timeoutMs = 30_000, pollIntervalMs = 200, stopGraceMs = 1000,
} = {}) {
  if (signal?.aborted) throw abortError()
  const report = (message) => { try { log(message) } catch {} }
  const controller = new AbortController()
  const onParentAbort = () => controller.abort(abortError())
  signal?.addEventListener('abort', onParentAbort, { once: true })
  const timeout = new Error('等待 iWAN SOCKS5 端口就绪超时')
  timeout.name = 'TimeoutError'
  const deadline = setTimeout(() => controller.abort(timeout),
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30_000)
  let handedOff = false
  try {
    if (await isPortOpen(socksPort, socksHost, 800, { signal: controller.signal })) {
      if (controller.signal.aborted) throw abortReason(controller.signal)
      report(`端口 ${socksHost}:${socksPort} 已有外部进程监听，插件不重复拉起客户端`)
      return { managed: false, isAlive: () => false, onExit: () => () => {}, stop: async () => {} }
    }
    if (controller.signal.aborted) throw abortReason(controller.signal)
    if (!exePath) throw new Error(`端口 ${socksPort} 没有监听，且未配置 iwanClientPath；请先启动或配置客户端。`)
    const args = ['--connect', '--socks', '--socks-listen', `${socksHost}:${socksPort}`, ...extraArgs]
    if (server) args.push('--server', server)
    if (dns) args.push('--dns', dns)
    report(`启动 iWAN 客户端：${exePath} ${args.join(' ')}`)
    if (controller.signal.aborted) throw abortReason(controller.signal)
    const child = spawn(exePath, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    return await new Promise((resolve, reject) => {
      let alive = true
      let ready = false
      let exited = false
      let exitInfo = null
      let pollTimer = null
      let forceTimer = null
      let stopTimer = null
      let lastStdout = ''
      let lastStderr = ''
      let answeredSelection = false
      const listeners = new Set()
      let resolveExit
      const exitPromise = new Promise((done) => { resolveExit = done })
      const markExited = () => {
        exited = true
        clearTimeout(forceTimer)
        clearTimeout(stopTimer)
        resolveExit()
      }
      const terminate = () => {
        if (exited) return exitPromise
        if (forceTimer || stopTimer) return exitPromise
        try { child.stdin?.destroy() } catch {}
        try { child.kill() } catch {}
        if (!exited) {
          forceTimer = setTimeout(() => {
            if (!exited) { try { child.kill('SIGKILL') } catch {} }
          }, Number.isFinite(stopGraceMs) && stopGraceMs >= 0 ? stopGraceMs : 1000)
          stopTimer = setTimeout(markExited, (Number.isFinite(stopGraceMs) && stopGraceMs >= 0 ? stopGraceMs : 1000) + 500)
          forceTimer.unref?.()
          // stop() 的等待保证有界，即使异常 child 不发送 exit/close。
        }
        return exitPromise
      }
      const finish = (error, code = null, exitSignal = null, stopped = false) => {
        if (!alive) return
        alive = false
        clearTimeout(deadline)
        clearTimeout(pollTimer)
        signal?.removeEventListener('abort', onParentAbort)
        controller.signal.removeEventListener('abort', onAbort)
        child.stdout?.removeListener('data', onStdout)
        child.stderr?.removeListener('data', onStderr)
        exitInfo = { code, signal: exitSignal, error: error ?? null, stopped }
        // 取消任何正在进行的探测，防止 socket/计时器留到超时。
        controller.abort(error ?? abortError())
        if (!ready) reject(error ?? new Error('iWAN 客户端在就绪前退出'))
        for (const listener of listeners) { try { listener(exitInfo) } catch {} }
        listeners.clear()
        lastStdout = lastStderr = ''
      }
      const fail = (error) => { finish(error); terminate() }
      const onAbort = () => fail(abortReason(controller.signal))
      const handle = {
        get managed() { return alive },
        isAlive: () => alive,
        onExit(listener) {
          if (typeof listener !== 'function') return () => {}
          if (exitInfo) {
            try { listener(exitInfo) } catch {}
            return () => {}
          }
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        stop() {
          finish(null, null, null, true)
          return terminate()
        },
      }
      const collect = (stream, chunk) => {
        if (!alive) return
        const text = String(chunk)
        if (stream === 'stdout') lastStdout = (lastStdout + text).slice(-2000)
        else lastStderr = (lastStderr + text).slice(-2000)
        const line = text.slice(-2000).trimEnd()
        if (line) report(line)
        if (stream !== 'stdout' || answeredSelection || server) return
        const match = /Select server \[(\d+)-\d+\]/.exec(lastStdout)
        if (!match) return
        answeredSelection = true
        report('客户端在等待选线，自动选择第 ' + match[1] + ' 条线路继续')
        try {
          child.stdin.write(match[1] + '\n', (error) => { if (error) fail(error) })
        } catch (error) { fail(error) }
      }
      const onStdout = (chunk) => collect('stdout', chunk)
      const onStderr = (chunk) => collect('stderr', chunk)
      child.on('error', fail)
      child.stdin?.on('error', fail)
      child.once('exit', (code, exitSignal) => {
        markExited()
        const tail = (lastStderr.trim() || lastStdout.trim()).slice(-400)
        const error = !ready || code !== 0 || exitSignal ?
          new Error(`iWAN 客户端进程已退出（code=${code ?? exitSignal}）` + (tail ? '：' + tail : '')) : null
        finish(error, code, exitSignal)
      })
      child.once('close', () => {
        markExited()
        finish(new Error('iWAN 客户端进程已关闭'))
      })
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', onStdout)
      child.stderr?.on('data', onStderr)
      controller.signal.addEventListener('abort', onAbort, { once: true })
      const probe = async () => {
        try {
          const open = await isPortOpen(socksPort, socksHost, 800, { signal: controller.signal })
          if (!alive) return
          if (controller.signal.aborted) { onAbort(); return }
          if (open) {
            report(`iWAN SOCKS5 就绪（${socksHost}:${socksPort}，pid=${child.pid}）`)
            if (!alive || controller.signal.aborted) return
            ready = true
            handedOff = true
            clearTimeout(deadline)
            resolve(handle)
          } else {
            pollTimer = setTimeout(probe, Number.isFinite(pollIntervalMs) && pollIntervalMs > 0 ? pollIntervalMs : 200)
          }
        } catch (error) { if (alive) fail(error) }
      }
      if (controller.signal.aborted) onAbort()
      else void probe()
    })
  } finally {
    clearTimeout(deadline)
    if (!handedOff) signal?.removeEventListener('abort', onParentAbort)
  }
}
