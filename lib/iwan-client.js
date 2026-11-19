/** iWAN 客户端托管与可取消的 TCP 探测。 */
import { spawn } from 'node:child_process'
import net from 'node:net'
import { DEFAULT_IWAN_SOCKS_PORT } from './defaults.js'
import { trackOwnedProcess } from './owned-process.js'

const MAX_PORT_CANDIDATES = 4

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

// A connect probe cannot detect ports excluded by Windows or an exclusive wildcard bind.
function bindPort(host, port, signal) {
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy())
    let closing = false
    let settled = false
    const done = (error, boundPort) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      server.removeListener('listening', onListening)
      server.removeListener('error', onError)
      if (signal.aborted) reject(abortReason(signal))
      else if (error) reject(error)
      else resolve(boundPort)
    }
    const close = (boundPort) => {
      if (closing) return
      closing = true
      server.close((error) => done(error, boundPort))
    }
    const onAbort = () => close()
    const onListening = () => close(server.address().port)
    const onError = (error) => { if (!closing) done(error) }
    server.once('error', onError)
    server.once('listening', onListening)
    signal.addEventListener('abort', onAbort, { once: true })
    try { server.listen({ host, port, exclusive: true }) }
    catch (error) { done(error) }
  })
}

function unavailablePort(error) {
  return error?.code === 'EADDRINUSE' || error?.code === 'EACCES' ||
    [10013, 10048].includes(Math.abs(Number(error?.errno)))
}

function nativeBindCause(line) {
  return /^(?:EADDRINUSE|EACCES|Address already in use|Permission denied)$/i.test(line) ||
    /\(os error (?:13|48|98|10013|10048)\)$/.test(line)
}

/** 上游默认 DNS 在校内服务器侧可能不可达，使用校内 DNS。 */
export const DEFAULT_IWAN_DNS = '202.38.64.1'

/**
 * signal 覆盖初次探测、启动待就绪及就绪后的整个托管生命周期。
 * autoSwitchPort: true 仅接受自己启动的监听，端口无法绑定时换用操作系统分配的端口。
 * 托管句柄的 socksHost/socksPort 为只读的实际监听地址。
 * 原生重连状态仅暴露计时和次数；进程存活不等于监听或认证就绪。
 * stop 立即标记非活动，并有界等待退出；不向外部监听端口发送终止信号。
 */
export async function ensureIwanClient({
  exePath, server, socksHost = '127.0.0.1', socksPort = DEFAULT_IWAN_SOCKS_PORT, autoSwitchPort = false,
  dns = DEFAULT_IWAN_DNS, extraArgs = [], log = () => {}, signal,
  timeoutMs = 30_000, pollIntervalMs = 200, stopGraceMs = 1000, onSpawned, now = Date.now,
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
  deadline.unref?.()
  let handedOff = false
  const checkAbort = () => { if (controller.signal.aborted) throw abortReason(controller.signal) }

  function startClient(socksPort) {
    const listenHost = socksHost.includes(':') && !socksHost.startsWith('[') ? '[' + socksHost + ']' : socksHost
    const listenAddress = `${listenHost}:${socksPort}`
    const listenerProtocol = autoSwitchPort === true ? 'tcp://' : 'http://'
    const expectedListener = new URL(listenerProtocol + listenAddress).host
    const matchesListener = (value) => {
      try {
        const address = new URL(listenerProtocol + value)
        return address.host === expectedListener && address.pathname === (autoSwitchPort === true ? '' : '/') &&
          !address.search && !address.hash && !address.username && !address.password
      } catch { return false }
    }
    const args = ['--connect', '--socks', '--socks-listen', listenAddress, ...extraArgs]
    if (server) args.push('--server', server)
    else if (!extraArgs.some(arg => arg === '--server' || arg.startsWith('--server=') || arg === '--auto' || arg.startsWith('--auto='))) {
      // The native retry loop selects again on every attempt: never wait on stdin.
      args.push('--server', '1')
    }
    if (dns) args.push('--dns', dns)
    report(`启动 iWAN 客户端：${exePath} ${args.join(' ')}`)
    checkAbort()
    const child = spawn(exePath, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    trackOwnedProcess(child)
    return new Promise((resolve, reject) => {
      const probeController = new AbortController()
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
      let listenerVerifiedAt = null
      let listenerGeneration = 0
      let sawListener = false
      let nativeReconnect = null
      let startupBindRace = false
      let bindCausePending = false
      let terminalBindRace = false
      // Consume fresh complete lines only; never replay the bounded diagnostic tails.
      const lineBuffers = { stdout: { text: '', dropping: false }, stderr: { text: '', dropping: false } }
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
          stopTimer = setTimeout(() => resolveExit(), (Number.isFinite(stopGraceMs) && stopGraceMs >= 0 ? stopGraceMs : 1000) + 500)
          forceTimer.unref?.()
          // stop() 的等待保证有界，即使异常 child 不发送 exit/close。
        }
        return exitPromise
      }
      const finish = (error, code = null, exitSignal = null, stopped = false, retry = false) => {
        if (!alive) return
        alive = false
        clearTimeout(pollTimer)
        if (ready) signal?.removeEventListener('abort', onParentAbort)
        controller.signal.removeEventListener('abort', onAbort)
        child.stdout?.removeListener('data', onStdout)
        child.stderr?.removeListener('data', onStderr)
        exitInfo = { code, signal: exitSignal, error: error ?? null, stopped }
        // 取消任何正在进行的探测，防止 socket/计时器留到超时。
        probeController.abort()
        if (retry) resolve({ bindError: error })
        else if (!ready) reject(error ?? new Error('iWAN 客户端在就绪前退出'))
        for (const listener of listeners) { try { listener(exitInfo) } catch {} }
        listeners.clear()
        lastStdout = lastStderr = ''
        listenerVerifiedAt = nativeReconnect = null
        for (const buffer of Object.values(lineBuffers)) {
          if (!stopped && !buffer.dropping) reportLine(buffer.text)
          buffer.text = ''
          buffer.dropping = false
        }
      }
      const fail = (error) => { finish(error); terminate() }
      const onAbort = () => fail(abortReason(controller.signal))
      const handle = {
        get managed() { return alive },
        isAlive: () => alive,
        isAuthenticated: () => alive && ready && !nativeReconnect && listenerVerifiedAt !== null,
        isReconnecting: () => alive && nativeReconnect !== null,
        reconnectState: () => alive && nativeReconnect ? { ...nativeReconnect } : null,
        hasExited: () => exited,
        get authenticatedAt() { return alive && ready ? listenerVerifiedAt : null },
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
      Object.defineProperties(handle, {
        socksHost: { value: socksHost, enumerable: true },
        socksPort: { value: socksPort, enumerable: true },
      })
      const processBindLine = (line) => {
        // Upstream's retry log prints the TcpListener::bind context without its OS cause.
        const reconnect = /^connection ended: bind SOCKS5 listener (\S+); reconnecting \(([1-4])\/5\)\.\.\.$/.exec(line)
        if (reconnect && matchesListener(reconnect[1])) return true
        const context = /^(?:Error: )?bind SOCKS5 listener (\S+?)(?:: (.+))?$/.exec(line)
        if (context && matchesListener(context[1])) {
          bindCausePending = !context[2]
          terminalBindRace ||= !!context[2] && nativeBindCause(context[2])
        } else if (bindCausePending && line.trim() && line !== 'Caused by:') {
          terminalBindRace ||= nativeBindCause(line.trim())
          bindCausePending = false
        }
        return false
      }
      const processLine = (stream, raw) => {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
        const match = /^connection ended: .+; reconnecting \(([1-9]\d*)\/([1-9]\d*)\)\.\.\.$/.exec(line)
        if (autoSwitchPort === true && !ready && !sawListener && stream === 'stderr') {
          if (!startupBindRace && processBindLine(line)) {
            startupBindRace = true
            clearTimeout(pollTimer)
            probeController.abort()
            terminate() // The upstream native loop would otherwise reconnect on the same port.
          }
          if (startupBindRace) return
        }
        if (match) {
          const attempt = Number(match[1]), maxAttempts = Number(match[2])
          if (!Number.isSafeInteger(attempt) || !Number.isSafeInteger(maxAttempts) || attempt >= maxAttempts) return
          listenerVerifiedAt = null
          listenerGeneration++
          if (!nativeReconnect) {
            const time = now()
            nativeReconnect = { since: time, lastAttemptAt: time, attempt, maxAttempts }
          } else if (maxAttempts === nativeReconnect.maxAttempts && attempt > nativeReconnect.attempt) {
            nativeReconnect = { ...nativeReconnect, lastAttemptAt: now(), attempt }
          }
          return
        }
        // Fresh owned stdout only: the listener line proves a new authenticated session.
        if (stream !== 'stdout' || !line.startsWith('SOCKS5 listening on ')) return
        if (matchesListener(line.slice('SOCKS5 listening on '.length).trim())) {
          sawListener = true
          listenerGeneration++
          listenerVerifiedAt = now()
          nativeReconnect = null
        }
      }
      const reportLine = (raw) => {
        // 上游 tracing 已带时间；界面使用日志入队时间，保留级别与正文即可。
        const line = raw.trim().replace(/^(\[)?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})(?=\s|\])(?:(\])\s*|\s*)/i,
          (_prefix, open, close) => open && !close ? '[' : '')
        if (line) report(line.slice(0, 2000))
      }
      const consumeLines = (stream, text) => {
        const buffer = lineBuffers[stream]
        let start = 0
        while (start < text.length) {
          const end = text.indexOf('\n', start)
          const stop = end === -1 ? text.length : end
          if (!buffer.dropping) {
            if (buffer.text.length + stop - start > 4096) {
              buffer.text = ''
              buffer.dropping = true
            } else buffer.text += text.slice(start, stop)
          }
          if (end === -1) break
          if (!buffer.dropping) {
            reportLine(buffer.text)
            processLine(stream, buffer.text)
          } else if (stream === 'stderr') bindCausePending = false
          buffer.text = ''
          buffer.dropping = false
          start = end + 1
        }
      }
      const collect = (stream, chunk) => {
        if (!alive) return
        const text = String(chunk)
        if (stream === 'stdout') lastStdout = (lastStdout + text).slice(-2000)
        else lastStderr = (lastStderr + text).slice(-2000)
        consumeLines(stream, text)
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
      const exitError = (code, exitSignal) => {
        const tail = (lastStderr.trim() || lastStdout.trim()).slice(-400)
        return new Error(`iWAN 客户端进程已退出（code=${code ?? exitSignal}）` + (tail ? '：' + tail : ''))
      }
      child.once('exit', (code, exitSignal) => {
        markExited()
        if (autoSwitchPort === true && !ready) {
          // 'exit' may precede the final stderr chunk; 'close' follows stream drain.
          clearTimeout(pollTimer)
          probeController.abort()
          return
        }
        finish(!ready || code !== 0 || exitSignal ? exitError(code, exitSignal) : null, code, exitSignal)
      })
      child.once('close', (code, exitSignal) => {
        markExited()
        if (!alive) return
        if (autoSwitchPort === true && !ready) {
          const buffer = lineBuffers.stderr
          if (buffer.text && !buffer.dropping) processLine('stderr', buffer.text)
          const retry = !sawListener && (startupBindRace || (terminalBindRace && code > 0 && !exitSignal))
          finish(exitError(code, exitSignal), code, exitSignal, false, retry)
        } else {
          finish(new Error('iWAN 客户端进程已关闭'))
        }
      })
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', onStdout)
      child.stderr?.on('data', onStderr)
      controller.signal.addEventListener('abort', onAbort, { once: true })
      const probe = async () => {
        try {
          const generation = listenerGeneration
          const freshProof = () => autoSwitchPort !== true || (listenerVerifiedAt !== null && listenerGeneration === generation)
          const open = freshProof() && await isPortOpen(socksPort, socksHost, 800, { signal: probeController.signal })
          if (!alive || exited || startupBindRace) return
          if (controller.signal.aborted) { onAbort(); return }
          if (open && freshProof()) {
            report(`iWAN SOCKS5 就绪（${socksHost}:${socksPort}，pid=${child.pid}）`)
            if (!alive || exited || startupBindRace || controller.signal.aborted) return
            if (freshProof()) {
              ready = true
              handedOff = true
              clearTimeout(deadline)
              resolve({ handle })
              return
            }
          }
          pollTimer = setTimeout(probe, Number.isFinite(pollIntervalMs) && pollIntervalMs > 0 ? pollIntervalMs : 200)
          pollTimer.unref?.()
        } catch (error) { if (alive && !exited && !startupBindRace) fail(error) }
      }
      try { onSpawned?.(handle) } catch (error) { fail(error); return }
      if (controller.signal.aborted) onAbort()
      else void probe()
    })
  }

  try {
    if (autoSwitchPort !== true && await isPortOpen(socksPort, socksHost, 800, { signal: controller.signal })) {
      checkAbort()
      report(`端口 ${socksHost}:${socksPort} 已有外部进程监听，插件不重复拉起客户端`)
      return { managed: false, isAlive: () => false, isAuthenticated: () => false, isReconnecting: () => false, reconnectState: () => null, onExit: () => () => {}, stop: async () => {} }
    }
    checkAbort()
    if (!exePath) throw new Error(`端口 ${socksPort} 没有监听，且未配置 iwanClientPath；请先启动或配置客户端。`)
    if (autoSwitchPort !== true) return (await startClient(socksPort)).handle
    if (socksHost.startsWith('[') && socksHost.endsWith(']')) socksHost = socksHost.slice(1, -1)

    const usedPorts = new Set()
    let lastBindError
    for (let candidate = 0; candidate < MAX_PORT_CANDIDATES; candidate++) {
      checkAbort()
      let port
      try {
        port = await bindPort(socksHost, candidate === 0 ? socksPort : 0, controller.signal)
      } catch (error) {
        if (candidate !== 0 || !unavailablePort(error)) throw error
        usedPorts.add(Number(socksPort))
        lastBindError = error
        continue
      }
      checkAbort()
      if (candidate !== 0 && (port < 1024 || usedPorts.has(port))) continue
      usedPorts.add(port)
      if (candidate !== 0) report(`iWAN SOCKS5 端口不可用，改用 ${socksHost}:${port}`)
      const result = await startClient(port)
      if (result.handle) return result.handle
      // A retryable result is only produced after the old child closes.
      lastBindError = result.bindError
    }
    checkAbort()
    throw lastBindError ?? new Error('无法分配 iWAN SOCKS5 端口')
  } finally {
    clearTimeout(deadline)
    if (!handedOff) signal?.removeEventListener('abort', onParentAbort)
  }
}
