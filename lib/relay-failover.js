/** One managed-client rotation at a time, before any application bytes are sent. */
import { SocksConnectError } from './socks.js'

export const isSocksHandshakeTimeout = error => error instanceof SocksConnectError &&
  error.code === 'SOCKS_TIMEOUT' && (error.phase === 'greeting' || error.phase === 'reply')

function waitForFlight(task, signal) {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => { cleanup(); reject(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    task.then(() => { cleanup(); resolve() }, error => { cleanup(); reject(error) })
  })
}

const exhaustedError = total => Object.assign(new Error('iWAN 出口均无法建立连接（已尝试 ' + total + ' 条线路）'), { noDirectFallback: true })

export function createRelayFailover({ enabled, endpoint, plan, switchTo, log, now = Date.now, cooldownMs = 20_000 }) {
  let flight = null
  let view = null, viewKey = null, unavailableSweep = 0
  // Concurrent callers and SDK retries for the same target must not immediately repeat a failed sweep.
  const exhausted = new Map()
  function recentFailure(key) {
    const last = exhausted.get(key)
    if (last && now() - last.at < cooldownMs && now() >= last.at) return last.total
    exhausted.delete(key)
    return 0
  }
  function reset() {
    flight?.controller.abort(new Error('iWAN 出口切换已取消'))
    exhausted.clear()
    unavailableSweep = 0
    view = viewKey = null
  }
  function rememberFailure(key, server, total) {
    viewKey = key
    view = { state: 'exhausted', server, attempt: total, total }
    if (!endpoint()) unavailableSweep = total
    exhausted.delete(key)
    exhausted.set(key, { at: now(), total })
    if (exhausted.size > 64) exhausted.delete(exhausted.keys().next().value)
    log('iWAN 候选出口均未能建立连接（' + total + ' 条线路），不回退直连')
  }
  function forTarget(host, port) {
    const key = JSON.stringify([host, port])
    if (!enabled()) return null
    // If a sweep stopped the original relay and none could start, keep all iWAN
    // targets off the direct route until the managed endpoint really returns.
    if (endpoint()) unavailableSweep = 0
    else if (!flight && !unavailableSweep && !recentFailure(key)) return null
    return async ({ signal, dial }) => {
      for (;;) {
        signal.throwIfAborted()
        if (!enabled()) throw Object.assign(new Error('iWAN 出口切换已取消'), { noDirectFallback: true })
        const pending = flight
        if (pending) {
          pending.waiters++
          try { await waitForFlight(pending.done, signal) }
          finally { pending.waiters--; pending.cancelUnobserved() }
          if (pending.key === key && pending.total) throw exhaustedError(pending.total)
          continue
        }
        const current = endpoint()
        if (!current) throw exhaustedError(recentFailure(key) || unavailableSweep || 1)
        unavailableSweep = 0
        let failure
        try {
          const socket = await dial(current, signal)
          if (!signal.aborted && endpoint()?.owner === current.owner) {
            exhausted.delete(key)
            if (viewKey === key && view?.state === 'exhausted') view = viewKey = null
            return socket
          }
          socket.destroy()
          continue
        } catch (error) { failure = error }
        signal.throwIfAborted()
        if (!enabled()) throw Object.assign(new Error('iWAN 出口切换已取消'), { noDirectFallback: true })
        // A different request may have stopped the exact process we just dialed.
        const latest = endpoint()
        if (flight || (latest && latest.owner !== current.owner)) continue
        if (!isSocksHandshakeTimeout(failure)) throw failure
        const recent = recentFailure(key)
        if (recent) throw exhaustedError(recent)
        const { selected, candidates } = plan(current)
        const at = candidates.indexOf(selected)
        const alternatives = at < 0 ? candidates : [...candidates.slice(at + 1), ...candidates.slice(0, at)]
        if (!alternatives.length) {
          rememberFailure(key, selected, 1)
          throw exhaustedError(1)
        }

        const controller = new AbortController()
        const sweepSignal = controller.signal
        const sweep = { key, controller, total: 0, done: null, waiters: 0, cancelUnobserved() {
          if (signal.aborted && this.waiters === 0) controller.abort(signal.reason)
        } }
        const onAbort = () => sweep.cancelUnobserved()
        signal.addEventListener('abort', onAbort, { once: true })
        flight = sweep
        // The preferred/current line has just failed. In auto-selection mode it may not have a known index.
        const total = alternatives.length + (at < 0 ? 0 : 1)
        let resolveDone
        sweep.done = new Promise(resolve => { resolveDone = resolve })
        try {
          let active = selected
          let attempt = at < 0 ? 0 : 1
          for (const server of alternatives) {
            sweepSignal.throwIfAborted()
            viewKey = key
            view = { state: 'switching', server, attempt: ++attempt, total }
            log('iWAN SOCKS5 握手超时，尝试切换到线路 #' + server + '（' + attempt + '/' + total + '）')
            try {
              const next = await switchTo(server, sweepSignal)
              active = server
              const socket = await dial(next, sweepSignal)
              if (sweepSignal.aborted) { socket.destroy(); sweepSignal.throwIfAborted() }
              exhausted.delete(key)
              view = { state: 'switched', server, attempt, total }
              log('iWAN 已切换到可用线路 #' + server)
              if (signal.aborted) socket.destroy()
              return socket
            } catch (error) {
              sweepSignal.throwIfAborted()
              if (error?.stopFailover) throw error
              log('iWAN 线路 #' + server + ' 未能建立连接')
            }
          }
          sweep.total = total
          rememberFailure(key, endpoint() ? active : null, total)
          throw exhaustedError(total)
        } catch (error) {
          if (view?.state === 'switching') view = viewKey = null
          throw Object.assign(new Error(error?.message ?? 'iWAN 出口切换失败', { cause: error }), { noDirectFallback: true })
        } finally {
          signal.removeEventListener('abort', onAbort)
          flight = null
          resolveDone()
        }
      }
    }
  }
  return { forTarget, reset, busy: () => flight !== null, status: () => view }
}
