/**
 * Single-flight local SOCKS health monitor. No credentials or callback errors
 * cross the status/log boundary. start() schedules the first check; checkNow()
 * also works before start(), but is inert after stop() until start() is called.
 * timings: intervalMs, wakeThresholdMs, wakeGraceMs, retryDelaysMs, maxAttempts
 * (at most five). recover reasons: wake / listener-unreachable / managed-unavailable / native-reconnect-timeout.
 * Only explicit manual requests should call reset(); unhealthy checks respect retries.
 * stop() requires callbacks to honor signal or eventually settle; it waits for
 * their actual settlement rather than permitting overlapping abandoned work.
 */
export function createReconnectMonitor(options) {
  const { inspect, probe, recover, onWake = () => {}, onExternal = () => {},
    log = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
    timings = {} } = options
  for (const fn of [inspect, probe, recover]) {
    if (typeof fn !== 'function') throw new TypeError('inspect, probe and recover are required')
  }
  const positive = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback
  const interval = positive(timings.intervalMs, 10_000)
  const wakeThreshold = positive(timings.wakeThresholdMs, 30_000)
  const grace = positive(timings.wakeGraceMs, 5_000)
  const retries = Array.isArray(timings.retryDelaysMs) && timings.retryDelaysMs.length
    ? timings.retryDelaysMs.map(value => positive(value, 10_000)) : [10_000, 20_000, 40_000, 60_000]
  const maxAttempts = Math.min(5, Math.floor(positive(timings.maxAttempts, 5)) || 5)
  const snapshot = { state: 'idle', attempts: 0, nextRetryAt: null, lastCheckedAt: null,
    lastResumeAt: null, lastError: null, reason: null }
  let running = false, stopped = false, timer = null, active = null, controller = null
  let stopping = null, lastTickAt = null, graceUntil = null, misses = 0
  let resumePending = false, resumeVersion = 0, externalRecorded = false

  function report(message) {
    try { log(message) } catch {}
  }
  function callback(fn, error) {
    try { fn() } catch { report(error) }
  }
  function state(value, reason) {
    snapshot.state = value
    snapshot.reason = reason
  }
  function resetBudget() {
    snapshot.attempts = 0
    snapshot.nextRetryAt = null
    snapshot.lastError = null
    misses = 0
  }
  function observeTick() {
    const time = now()
    if (lastTickAt !== null && time - lastTickAt >= wakeThreshold) {
      resetBudget()
      resumePending = true
      resumeVersion++
      snapshot.lastResumeAt = time
      graceUntil = time + grace
      callback(onWake, '唤醒后的认证状态清理失败')
      state('waiting', '系统刚刚唤醒，等待网络恢复')
    }
    lastTickAt = time
  }
  function clearScheduled() {
    if (timer !== null) clearTimer(timer)
    timer = null
  }
  function schedule() {
    clearScheduled()
    if (!running || stopped) return
    const time = now()
    let delay = interval
    for (const deadline of [graceUntil, snapshot.nextRetryAt]) {
      if (deadline !== null && deadline > time) delay = Math.min(delay, deadline - time)
    }
    timer = setTimer(() => {
      timer = null
      // Keep observing wall-clock ticks even during a long probe/recovery.
      checkNow()
      schedule()
    }, delay)
    timer?.unref?.()
  }
  function policy() {
    const current = inspect()
    if (!current || !['managed', 'external', 'paused', 'busy', 'blocked', 'native-reconnecting'].includes(current.mode)) {
      throw new Error('Invalid monitor policy')
    }
    return current
  }
  function external() {
    state('external', '外部客户端模式，连接由用户管理，不自动重启')
    resetBudget()
    if (!externalRecorded) callback(onExternal, '外部 SOCKS 监听记录失败')
    externalRecorded = true
  }
  function allowed(current) {
    if (current.mode === 'external') { external(); return false }
    if (current.mode === 'native-reconnecting') {
      misses = 0
      snapshot.nextRetryAt = null
      state('waiting', 'iWAN 客户端正在自行重连，暂不重启进程')
      return false
    }
    if (current.owned || current.mode !== 'managed') externalRecorded = false
    if (current.mode === 'paused' || current.mode === 'busy') {
      misses = 0
      state('paused', current.mode === 'paused' ? '自动重连已暂停' : '操作进行中，暂不自动重连')
      return false
    }
    if (current.mode === 'blocked') {
      misses = 0
      state('blocked', '自动托管暂不可用，请人工检查')
      return false
    }
    if (snapshot.attempts >= maxAttempts) {
      state('blocked', '自动恢复连续失败，请人工检查后重试')
      snapshot.nextRetryAt = null
      return false
    }
    return true
  }
  function inGrace() {
    if (graceUntil !== null && now() < graceUntil) {
      state('waiting', '系统刚刚唤醒，等待网络恢复')
      return true
    }
    graceUntil = null
    return false
  }

  async function check(signal) {
    if (signal.aborted) return
    let current = policy()
    if (signal.aborted || !allowed(current) || inGrace()) return
    state('checking', '正在检查本地 SOCKS 监听')
    let reachable = false
    try { reachable = await probe({ signal }) === true }
    catch (error) {
      if (signal.aborted) return
      // The runtime may discard a stale endpoint result without aborting this
      // monitor's signal (configuration/ownership changed during the probe).
      if (error?.name === 'AbortError') {
        if (allowed(policy())) state('waiting', '本次健康检查已取消或过期')
        return
      }
      snapshot.lastError = '本地 SOCKS 探测失败'
    }
    if (signal.aborted) return
    snapshot.lastCheckedAt = now()
    // A late probe must never override pause, authentication, installation or
    // ownership changes. Wake grace may also have started while it was pending.
    current = policy()
    if (signal.aborted || !allowed(current) || inGrace()) return
    const nativeExpired = !reachable && current.owned === true && current.nativeReconnectExpired === true
    const refresh = (resumePending && current.owned === true) || nativeExpired
    if (reachable && !current.owned) {
      external()
      return
    }
    if (reachable && !refresh) {
      resetBudget()
      resumePending = false
      state('healthy', '本地 SOCKS 监听正常')
      return
    }
    if (!reachable) {
      externalRecorded = false
      misses++
      snapshot.lastError = '本地 SOCKS 监听不可达'
    }
    if (snapshot.nextRetryAt !== null && now() < snapshot.nextRetryAt) {
      state('waiting', '等待自动恢复重试')
      return
    }
    if (current.owned && !refresh && misses < 2) {
      state('waiting', '本地 SOCKS 监听不可达，等待再次确认')
      return
    }
    const reason = nativeExpired ? 'native-reconnect-timeout' : refresh ? 'wake' : current.owned ? 'listener-unreachable' : 'managed-unavailable'
    const version = resumeVersion
    state('recovering', nativeExpired ? '客户端自行重连超时，正在恢复托管连接' : refresh ? '正在刷新唤醒后的托管连接' : '正在恢复托管连接')
    let restored
    try { restored = await recover({ signal, reason }) }
    catch {
      if (signal.aborted) return
      if (!allowed(policy())) return
      snapshot.attempts++
      snapshot.lastError = '自动恢复失败，请检查网络与认证'
      report(snapshot.lastError)
      if (snapshot.attempts >= maxAttempts) {
        snapshot.nextRetryAt = null
        state('blocked', '自动恢复连续失败，请人工检查后重试')
      } else {
        snapshot.nextRetryAt = now() + retries[Math.min(snapshot.attempts - 1, retries.length - 1)]
        state('waiting', '等待自动恢复重试')
      }
      return
    }
    if (signal.aborted || !allowed(policy())) return
    if (restored === true) {
      resetBudget()
      if (version === resumeVersion) resumePending = false
      if (resumePending) {
        state('waiting', '系统唤醒后仍需刷新托管连接')
      } else {
        state('healthy', '托管连接已恢复')
      }
    } else {
      // Cancellation/skipping is not a failure, but must not create a spawn loop.
      snapshot.nextRetryAt = now() + interval
      state('waiting', '本次自动恢复已取消或跳过')
    }
  }

  function status() { return { ...snapshot } }
  function checkNow() {
    if (stopped) return Promise.resolve(status())
    observeTick()
    if (active) return active
    const aborter = new AbortController()
    controller = aborter
    active = Promise.resolve().then(() => check(aborter.signal)).catch(() => {
      if (aborter.signal.aborted) return
      snapshot.lastError = '无法检查自动托管状态，请人工检查'
      state('blocked', snapshot.lastError)
      report(snapshot.lastError)
    }).then(status).finally(() => {
      active = null
      controller = null
      schedule()
    })
    return active
  }
  function start() {
    if (running || stopping) return monitor
    running = true
    stopped = false
    lastTickAt = now()
    schedule()
    return monitor
  }
  function stop() {
    if (stopping) return stopping
    running = false
    stopped = true
    clearScheduled()
    controller?.abort()
    state('idle', '后台健康监测已停止')
    stopping = Promise.resolve(active).then(() => {
      state('idle', '后台健康监测已停止')
      snapshot.nextRetryAt = null
      graceUntil = null
      lastTickAt = null
    }).finally(() => { stopping = null })
    return stopping
  }
  function reset() {
    resetBudget()
    // Explicit manual reset must not cancel an in-flight recovery or wake grace.
    if (!active && snapshot.state !== 'healthy' && snapshot.state !== 'external') {
      state('idle', '自动恢复预算已重置')
    }
    schedule()
    return status()
  }
  const monitor = { start, stop, status, checkNow, reset }
  return monitor
}
