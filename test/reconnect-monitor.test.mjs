import test from 'node:test'
import assert from 'node:assert/strict'
import { createReconnectMonitor } from '../lib/reconnect-monitor.js'

const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve() }
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fakeClock() {
  let time = 1_000, sequence = 0, unrefs = 0
  const tasks = new Map()
  const next = () => [...tasks.values()].sort((a, b) => a.at - b.at || a.id - b.id)[0]
  return {
    now: () => time,
    setTimer(fn, delay) {
      assert.ok(delay > 0, 'no zero-delay busy loop')
      const handle = { id: ++sequence, unref() { unrefs++ } }
      tasks.set(handle.id, { id: handle.id, handle, at: time + delay, fn })
      return handle
    },
    clearTimer(handle) { tasks.delete(handle.id) },
    get pending() { return tasks.size },
    get unrefs() { return unrefs },
    async advance(ms) {
      const until = time + ms
      let task, count = 0
      while ((task = next()) && task.at <= until) {
        assert.ok(++count < 10_000, 'bounded timers')
        time = task.at
        tasks.delete(task.id)
        task.fn()
        await flush()
      }
      time = until
      await flush()
    },
    async jump(ms) {
      time += ms
      for (const task of [...tasks.values()]) {
        if (task.at <= time && tasks.delete(task.id)) task.fn()
      }
      await flush()
    },
  }
}
function fixture(overrides = {}) {
  const clock = fakeClock()
  const h = { clock, mode: 'managed', owned: true, reachable: true, probes: [], recovers: [],
    wakes: 0, externals: 0, logs: [] }
  h.monitor = createReconnectMonitor({
    inspect: () => overrides.inspect ? overrides.inspect(h) :
      { mode: h.mode, owned: h.owned, reason: 'token=SECRET-CREDENTIAL' },
    probe: async args => {
      h.probes.push(args)
      return overrides.probe ? overrides.probe(args, h) : h.reachable
    },
    recover: async args => {
      h.recovers.push(args)
      if (overrides.recover) return overrides.recover(args, h)
      h.owned = true
      h.reachable = true
      return true
    },
    onWake: () => { h.wakes++; overrides.onWake?.(h) },
    onExternal: () => { h.externals++; overrides.onExternal?.(h) },
    log: message => h.logs.push(message),
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    timings: overrides.timings,
  })
  return h
}

test('start is idempotent, uses 10s ticks and optional unref; status is a copy', async () => {
  const h = fixture(), m = h.monitor
  assert.deepEqual(m.status(), { state: 'idle', attempts: 0, nextRetryAt: null,
    lastCheckedAt: null, lastResumeAt: null, lastError: null, reason: null })
  m.status().attempts = 99
  assert.equal(m.start(), m)
  assert.equal(m.start(), m)
  assert.equal(h.clock.pending, 1)
  assert.ok(h.clock.unrefs > 0)
  await h.clock.advance(9_999)
  assert.equal(h.probes.length, 0)
  await h.clock.advance(1)
  assert.equal(h.probes.length, 1)
  assert.equal(m.status().state, 'healthy')
  assert.equal(m.status().lastCheckedAt, h.clock.now())
  assert.equal(h.recovers.length, 0)
  await m.stop()
  assert.equal(h.clock.pending, 0)
})

test('owned listener needs two consecutive misses, and a healthy probe resets misses', async () => {
  const h = fixture(), m = h.monitor
  h.reachable = false
  await m.checkNow()
  assert.equal(m.status().state, 'waiting')
  assert.match(m.status().lastError, /不可达/)
  assert.equal(h.recovers.length, 0)
  h.reachable = true
  await m.checkNow()
  h.reachable = false
  await m.checkNow()
  assert.equal(h.recovers.length, 0)
  await m.checkNow()
  assert.equal(h.recovers.length, 1)
  assert.equal(h.recovers[0].reason, 'listener-unreachable')
  assert.equal(m.status().state, 'healthy')
})

test('unowned absent listener recovers immediately; unowned live listener is external', async () => {
  const h = fixture(), m = h.monitor
  h.owned = false
  await m.checkNow()
  await m.checkNow()
  assert.equal(m.status().state, 'external')
  assert.equal(h.externals, 1)
  assert.equal(h.recovers.length, 0)
  h.reachable = false
  await m.checkNow()
  assert.equal(h.recovers.length, 1)
  assert.equal(h.recovers[0].reason, 'managed-unavailable')
  assert.equal(m.status().state, 'healthy')
})

test('wake clears evidence first, grants 5s grace, then refreshes even an open owned listener', async () => {
  const h = fixture({ onWake: h => assert.equal(h.recovers.length, 0) }), m = h.monitor
  m.start()
  await h.clock.advance(10_000)
  await h.clock.jump(30_000)
  assert.equal(h.wakes, 1)
  assert.equal(m.status().lastResumeAt, h.clock.now())
  assert.equal(m.status().state, 'waiting')
  assert.equal(h.probes.length, 1)
  await m.checkNow()
  await h.clock.advance(4_999)
  assert.equal(h.recovers.length, 0)
  await h.clock.advance(1)
  assert.equal(h.recovers.length, 1)
  assert.equal(h.recovers[0].reason, 'wake')
  assert.equal(m.status().state, 'healthy')
  await h.clock.advance(20_000)
  assert.equal(h.recovers.length, 1)
  await m.stop()
})

test('failed recoveries back off 10/20/40/60s, block at five and reset only explicitly or on wake', async () => {
  const h = fixture({ recover: () => { throw new Error('token=SECRET-CREDENTIAL') } }), m = h.monitor
  h.owned = false
  h.reachable = false
  m.start()
  await m.checkNow()
  for (const [attempt, delay] of [[1, 10_000], [2, 20_000], [3, 40_000], [4, 60_000]]) {
    assert.equal(m.status().attempts, attempt)
    assert.equal(m.status().nextRetryAt, h.clock.now() + delay)
    await h.clock.advance(delay - 1)
    await m.checkNow()
    assert.equal(h.recovers.length, attempt)
    await h.clock.advance(1)
    assert.equal(h.recovers.length, attempt + 1)
  }
  assert.equal(m.status().state, 'blocked')
  assert.equal(m.status().attempts, 5)
  assert.equal(m.status().nextRetryAt, null)
  await h.clock.advance(300_000)
  await m.checkNow()
  assert.equal(h.recovers.length, 5)
  assert.equal(h.wakes, 0)
  assert.doesNotMatch(JSON.stringify([m.status(), h.logs]), /SECRET|token=/)
  m.reset()
  assert.equal(m.status().attempts, 0)
  assert.equal(m.status().lastError, null)
  await m.checkNow()
  assert.equal(h.recovers.length, 6)
  await h.clock.jump(30_000)
  assert.equal(h.wakes, 1)
  assert.equal(m.status().attempts, 0)
  await h.clock.advance(5_000)
  assert.equal(h.recovers.length, 7)
  assert.equal(m.status().attempts, 1)
  await m.stop()
})

test('paused, busy, blocked and external never probe or start recovery, including after wake', async () => {
  for (const [mode, expected] of [['paused', 'paused'], ['busy', 'paused'], ['blocked', 'blocked'], ['external', 'external']]) {
    const h = fixture(), m = h.monitor
    h.mode = mode
    h.reachable = false
    m.start()
    await m.checkNow()
    assert.equal(m.status().state, expected)
    await h.clock.jump(30_000)
    await h.clock.advance(5_000)
    assert.equal(h.wakes, 1)
    assert.equal(m.status().state, expected)
    assert.equal(h.probes.length, 0)
    assert.equal(h.recovers.length, 0)
    assert.doesNotMatch(JSON.stringify(m.status()), /SECRET|token=/)
    await m.stop()
  }
})

test('late probe rechecks all policy guards before recovery', async () => {
  for (const mode of ['paused', 'busy', 'blocked', 'external']) {
    const gate = deferred(), h = fixture({ probe: () => gate.promise }), m = h.monitor
    h.owned = false
    const checking = m.checkNow()
    await flush()
    h.mode = mode
    gate.resolve(false)
    await checking
    assert.equal(h.recovers.length, 0)
    assert.equal(m.status().state, mode === 'busy' ? 'paused' : mode)
  }
})

test('periodic and manual checks share one in-flight promise through probe and recovery', async () => {
  const probing = deferred(), recovering = deferred()
  const h = fixture({ probe: () => probing.promise, recover: () => recovering.promise }), m = h.monitor
  h.owned = false
  m.start()
  const one = m.checkNow(), two = m.checkNow()
  assert.equal(one, two)
  await h.clock.advance(20_000)
  assert.equal(h.probes.length, 1)
  probing.resolve(false)
  await flush()
  assert.equal(m.status().state, 'recovering')
  assert.equal(m.checkNow(), one)
  await h.clock.advance(120_000)
  assert.equal(h.wakes, 0, 'normal async I/O is not a system wake')
  assert.equal(h.recovers.length, 1)
  recovering.resolve(true)
  await one
  assert.equal(m.status().state, 'healthy')
  await m.stop()
})

test('stop aborts probe, waits for actual settlement, clears timers and ignores late success', async () => {
  const gate = deferred(), h = fixture({ probe: () => gate.promise }), m = h.monitor
  m.start()
  const checking = m.checkNow()
  await flush()
  const signal = h.probes[0].signal
  let settled = false
  const stopping = m.stop().then(() => { settled = true })
  assert.equal(signal.aborted, true)
  assert.equal(h.clock.pending, 0)
  await flush()
  assert.equal(settled, false)
  gate.resolve(false)
  await Promise.all([checking, stopping])
  assert.equal(h.recovers.length, 0)
  assert.equal(m.status().state, 'idle')
  await h.clock.advance(100_000)
  await m.checkNow()
  assert.equal(h.probes.length, 1)
  assert.equal(h.clock.pending, 0)
})

test('stop aborts recovery and waits for real cleanup without counting cancellation', async () => {
  const gate = deferred(), h = fixture({ recover: () => gate.promise }), m = h.monitor
  h.owned = false
  h.reachable = false
  m.start()
  const checking = m.checkNow()
  await flush()
  const stopping = m.stop()
  assert.equal(h.recovers[0].signal.aborted, true)
  gate.reject(new Error('cancelled SECRET-CREDENTIAL'))
  await Promise.all([checking, stopping])
  assert.equal(m.status().attempts, 0)
  assert.equal(m.status().state, 'idle')
  assert.equal(h.clock.pending, 0)
  assert.deepEqual(h.logs, [])
})

test('reset does not cancel active recovery; false means skipped, never healthy or failed', async () => {
  const gate = deferred(), h = fixture({ recover: () => gate.promise }), m = h.monitor
  h.owned = false
  h.reachable = false
  const checking = m.checkNow()
  await flush()
  m.reset()
  assert.equal(m.status().state, 'recovering')
  assert.equal(h.recovers[0].signal.aborted, false)
  assert.equal(m.checkNow(), checking)
  gate.resolve(false)
  await checking
  assert.equal(m.status().state, 'waiting')
  assert.equal(m.status().attempts, 0)
  assert.equal(m.status().nextRetryAt, h.clock.now() + 10_000)
  await m.checkNow()
  await m.checkNow()
  assert.equal(h.recovers.length, 1)
})

test('a probe pending across wake cannot recover before the new grace expires', async () => {
  const gate = deferred()
  const h = fixture({ probe: (_, h) => h.probes.length === 1 ? gate.promise : true }), m = h.monitor
  m.start()
  const checking = m.checkNow()
  await flush()
  await h.clock.jump(30_000)
  assert.equal(h.wakes, 1)
  gate.resolve(false)
  await checking
  assert.equal(h.recovers.length, 0)
  await h.clock.advance(4_999)
  assert.equal(h.recovers.length, 0)
  await h.clock.advance(1)
  assert.equal(h.recovers.length, 1)
  assert.equal(h.recovers[0].reason, 'wake')
  await m.stop()
})

test('open pre-wake listener does not conceal a failed wake refresh or reset its backoff', async () => {
  const h = fixture({ recover: (_, h) => {
    if (h.recovers.length < 2) throw new Error('SECRET-CREDENTIAL')
    return true
  } }), m = h.monitor
  m.start()
  await h.clock.jump(30_000)
  await h.clock.advance(5_000)
  assert.equal(m.status().attempts, 1)
  assert.equal(m.status().state, 'waiting')
  assert.match(m.status().lastError, /自动恢复失败/)
  await m.checkNow()
  assert.equal(h.recovers.length, 1)
  assert.equal(m.status().attempts, 1)
  await h.clock.advance(10_000)
  assert.equal(h.recovers.length, 2)
  assert.equal(h.recovers[1].reason, 'wake')
  assert.equal(m.status().state, 'healthy')
  assert.equal(m.status().attempts, 0)
  await m.stop()
})

test('long recovery failure retains failure budget while normal heartbeats keep running', async () => {
  const gate = deferred(), h = fixture({ recover: () => gate.promise }), m = h.monitor
  h.owned = false
  h.reachable = false
  m.start()
  const checking = m.checkNow()
  await h.clock.advance(90_000)
  assert.equal(h.wakes, 0)
  assert.equal(h.recovers.length, 1)
  gate.reject(new Error('SECRET-CREDENTIAL'))
  await checking
  assert.equal(m.status().attempts, 1)
  assert.equal(m.status().nextRetryAt, h.clock.now() + 10_000)
  await m.stop()
})

test('new wake during recovery retains a pending post-wake refresh', async () => {
  const gate = deferred()
  const h = fixture({ recover: (_, h) => h.recovers.length === 1 ? gate.promise : true }), m = h.monitor
  h.reachable = false
  m.start()
  await m.checkNow()
  const checking = m.checkNow()
  await flush()
  await h.clock.jump(30_000)
  h.reachable = true
  gate.resolve(true)
  await checking
  assert.equal(m.status().state, 'waiting')
  await h.clock.advance(5_000)
  assert.equal(h.recovers.length, 2)
  assert.equal(h.recovers[1].reason, 'wake')
  await m.stop()
})

test('probe and inspect exceptions never expose raw errors or reasons', async () => {
  const h = fixture({ probe: () => { throw new Error('token=SECRET-CREDENTIAL') } }), m = h.monitor
  await m.checkNow()
  assert.equal(m.status().state, 'waiting')
  assert.equal(m.status().attempts, 0)
  assert.doesNotMatch(JSON.stringify([m.status(), h.logs]), /SECRET|token=/)
  const broken = fixture({ inspect: () => { throw new Error('token=SECRET-CREDENTIAL') } })
  await broken.monitor.checkNow()
  assert.equal(broken.monitor.status().state, 'blocked')
  assert.doesNotMatch(JSON.stringify([broken.monitor.status(), broken.logs]), /SECRET|token=/)
})

test('custom timings and numeric timer handles work without unref; stop may be restarted', async () => {
  let time = 1_000, task, calls = 0, cleared = 0
  const m = createReconnectMonitor({
    inspect: () => ({ mode: 'managed', owned: true }),
    probe: async () => { calls++; return true }, recover: async () => true,
    now: () => time, timings: { intervalMs: 12 },
    setTimer: (fn, delay) => { task = { fn, delay }; return 42 },
    clearTimer: id => { assert.equal(id, 42); cleared++ },
  })
  m.start()
  assert.equal(task.delay, 12)
  time += 12
  task.fn()
  await flush()
  assert.equal(calls, 1)
  await m.stop()
  assert.ok(cleared > 0)
  m.start()
  await m.checkNow()
  assert.equal(calls, 2)
  await m.stop()
})

test('probe AbortError without an aborted signal discards stale results without recovery', async () => {
  for (const owned of [false, true]) {
    const gate = deferred(), h = fixture({ probe: () => gate.promise }), m = h.monitor
    h.owned = owned
    const checking = m.checkNow()
    await flush()
    assert.equal(h.probes[0].signal.aborted, false)
    gate.reject(Object.assign(new Error('SECRET-CREDENTIAL'), { name: 'AbortError' }))
    await checking
    assert.equal(h.recovers.length, 0)
    assert.equal(m.status().state, 'waiting')
    assert.equal(m.status().attempts, 0)
    assert.equal(m.status().lastCheckedAt, null)
    assert.equal(m.status().lastError, null)
    assert.doesNotMatch(JSON.stringify([m.status(), h.logs]), /SECRET/)
  }
})

test('stale probe AbortError does not count as the second failed owned probe', async () => {
  const h = fixture({ probe: (_, h) => {
    if (h.probes.length === 2) throw Object.assign(new Error('stale'), { name: 'AbortError' })
    return false
  } }), m = h.monitor
  await m.checkNow()
  await m.checkNow()
  assert.equal(h.recovers.length, 0)
  assert.equal(m.status().attempts, 0)
  await m.checkNow()
  assert.equal(h.recovers.length, 1)
})

test('stop before the queued check starts never invokes probe', async () => {
  const h = fixture(), m = h.monitor
  const checking = m.checkNow()
  await m.stop()
  await checking
  assert.equal(h.probes.length, 0)
  assert.equal(h.recovers.length, 0)
  assert.equal(m.status().state, 'idle')
})

test('native client reconnect progress waits without probing or spending plugin retry budget',async()=>{
  const h=fixture();h.mode='native-reconnecting';h.reachable=false;h.monitor.start()
  await h.clock.advance(30000)
  assert.equal(h.monitor.status().state,'waiting');assert.equal(h.probes.length,0);assert.equal(h.recovers.length,0);assert.equal(h.monitor.status().attempts,0)
  h.mode='managed';h.reachable=true;await h.monitor.checkNow();assert.equal(h.monitor.status().state,'healthy');await h.monitor.stop()
})

test('expired native reconnect uses one bounded restart rather than waiting for two fresh misses',async()=>{
  const h=fixture({inspect:h=>({mode:'managed',owned:true,nativeReconnectExpired:true})});h.reachable=false
  await h.monitor.checkNow();assert.equal(h.recovers.length,1);assert.equal(h.recovers[0].reason,'native-reconnect-timeout');assert.equal(h.monitor.status().state,'healthy');await h.monitor.stop()
})
