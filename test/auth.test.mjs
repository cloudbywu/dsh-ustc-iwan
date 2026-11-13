import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, getEventListeners } from 'node:events'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

function clock() {
  let now = 0
  let seq = 0
  const tasks = new Map()
  return {
    tasks,
    setTimeout(fn, ms) { const id = { id: ++seq, unref() {} }; tasks.set(id, { at: now + ms, fn }); return id },
    clearTimeout(id) { tasks.delete(id) },
    tick(ms) {
      const end = now + ms
      for (;;) {
        const next = [...tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        now = next[1].at
        tasks.delete(next[0])
        next[1].fn()
      }
      now = end
    },
  }
}

function childProcess() {
  const child = new EventEmitter()
  child.exitCode = child.signalCode = null
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdout.setEncoding = child.stderr.setEncoding = () => {}
  child.stdin = new EventEmitter()
  child.writes = []
  child.stdin.end = (text, cb) => { child.writes.push(text); child.writeCallback = cb }
  child.stdin.destroy = () => { child.stdin.destroyed = true }
  child.kills = []
  child.kill = (signal = 'SIGTERM') => { child.kills.push(signal); return true }
  child.finish = (code = 0, signal = null) => {
    child.exitCode = code
    child.signalCode = signal
    child.emit('exit', code, signal)
    child.emit('close', code, signal)
  }
  return child
}

async function fixture({ spawnError } = {}) {
  const time = clock()
  const children = []
  const context = vm.createContext({ URL, AbortController, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout })
  const cp = new vm.SyntheticModule(['spawn'], function () {
    this.setExport('spawn', (exe, args, options) => {
      if (spawnError) throw spawnError
      const child = childProcess()
      child.command = { exe, args, options }
      children.push(child)
      return child
    })
  }, { context })
  const source = await readFile(new URL('../lib/auth.js', import.meta.url), 'utf8')
  const module = new vm.SourceTextModule(source + '\nexport const inspectForTest = () => ({ active, latest, retiring })', { context })
  await module.link((id) => { assert.equal(id, 'node:child_process'); return cp })
  await module.evaluate()
  const api = module.namespace
  return { api, children, time,
    start(options = {}) { const result = api.startAuth({ exePath: 'mock-client', ...options }); return { result, child: children.at(-1) } },
    authorize(child, url = 'https://login.example/authorize?state=complete') { child.stderr.emit('data', 'Open in browser:\n' + url + '\r\n') },
  }
}

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }

test('auth: idle, missing executable, pre-abort and synchronous spawn error', async () => {
  const f = await fixture()
  assert.equal(f.api.authState().state, 'idle')
  await assert.rejects(f.api.startAuth(), /尚未找到/)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(f.api.startAuth({ exePath: 'mock', signal: controller.signal }), { name: 'AbortError' })
  assert.equal(f.children.length, 0)
  const broken = await fixture({ spawnError: new Error('spawn throws') })
  await assert.rejects(broken.start().result, /spawn throws/)
  assert.equal(broken.api.authState().state, 'failed')
})

for (const stream of ['stdout', 'stderr']) test(`auth: ${stream} URL waits for complete line across chunks`, async () => {
  const f = await fixture()
  const { child, result } = f.start({ configDir: 'my config' })
  let settled = false
  result.then(() => { settled = true })
  child[stream].emit('data', 'Open in browser:\nhttps://login.example/auth?state=')
  await flush()
  assert.equal(settled, false)
  child[stream].emit('data', 'whole&code=123')
  await flush()
  assert.equal(settled, false)
  child[stream].emit('data', '\r\n')
  const auth = await result
  assert.equal(auth.authorizeUrl, 'https://login.example/auth?state=whole&code=123')
  assert.equal(child.command.args.join('|'), '--fetch|--config-dir|my config')
  assert.equal(f.api.authState().state, 'awaiting')
  f.api.disposeAuth()
  child.finish(null, 'SIGTERM')
  assert.equal(f.time.tasks.size, 0)
})

for (const phase of ['starting', 'awaiting', 'submitting']) test(`auth: exclusive and cancellable in ${phase}`, async () => {
  const f = await fixture()
  const { child, result } = f.start()
  let rejection
  if (phase === 'starting') rejection = assert.rejects(result, { name: 'AbortError' })
  else { f.authorize(child); await result }
  const id = f.api.authState().id
  if (phase === 'submitting') assert.equal(f.api.submitRedirect(id, 'com.panabit.mobile://callback?code=ok').id, id)
  assert.equal(f.api.authState().state, phase)
  await assert.rejects(f.start().result, /已有一个认证会话/)
  assert.equal(f.children.length, 1)
  assert.equal(f.api.cancelAuth(id).cancelled, true)
  if (rejection) await rejection
  assert.equal(f.api.authState().state, 'failed')
  assert.equal(child.kills.length, 1)
  child.finish(0)
  assert.equal(f.api.authState().state, 'failed')
  assert.equal(f.time.tasks.size, 0)
})

for (const phase of ['starting', 'awaiting', 'submitting']) test(`auth: asynchronous process error in ${phase}`, async () => {
  const f = await fixture()
  const { child, result } = f.start()
  const rejection = phase === 'starting' ? assert.rejects(result, /ENOENT/) : null
  if (phase !== 'starting') { f.authorize(child); await result }
  if (phase === 'submitting') f.api.submitRedirect(f.api.authState().id, 'com.panabit.mobile://callback')
  child.emit('error', new Error('ENOENT: mock failure'))
  if (rejection) await rejection
  assert.match(f.api.authState().error, /ENOENT/)
  child.finish(1)
  assert.equal(f.time.tasks.size, 0)
})

for (const mode of ['event', 'callback', 'throw']) test(`auth: stdin EPIPE via ${mode} marks failed safely`, async () => {
  const f = await fixture()
  const { child, result } = f.start()
  f.authorize(child)
  const { id } = await result
  const error = new Error('write EPIPE')
  if (mode === 'throw') child.stdin.end = () => { throw error }
  f.api.submitRedirect(id, 'com.panabit.mobile://callback?code=x')
  if (mode === 'event') child.stdin.emit('error', error)
  if (mode === 'callback') child.writeCallback(error)
  assert.equal(f.api.authState().state, 'failed')
  assert.match(f.api.authState().error, /EPIPE/)
  child.finish(1)
  // A second late stream error is still consumed, never an unhandled event.
  child.stdin.emit('error', error)
  assert.equal(f.time.tasks.size, 0)
})

for (const phase of ['starting', 'awaiting', 'submitting']) test(`auth: ${phase} deadline terminates and releases timers`, async () => {
  const f = await fixture()
  const { child, result } = f.start({ startTimeoutMs: 5, awaitTimeoutMs: 7, submitTimeoutMs: 9 })
  const rejection = phase === 'starting' ? assert.rejects(result, /超时/) : null
  if (phase !== 'starting') { f.authorize(child); await result }
  if (phase === 'submitting') f.api.submitRedirect(f.api.authState().id, 'com.panabit.mobile://callback')
  f.time.tick(phase === 'starting' ? 5 : phase === 'awaiting' ? 7 : 9)
  if (rejection) await rejection
  assert.equal(f.api.authState().state, 'failed')
  assert.match(f.api.authState().error, /超时/)
  assert.equal(child.kills.length, 1)
  child.finish(0)
  assert.equal(f.time.tasks.size, 0)
})

for (const phase of ['starting', 'awaiting', 'submitting']) test(`auth: signal abort in ${phase} removes listener`, async () => {
  const f = await fixture()
  const controller = new AbortController()
  const { child, result } = f.start({ signal: controller.signal })
  const rejection = phase === 'starting' ? assert.rejects(result, { name: 'AbortError' }) : null
  if (phase !== 'starting') { f.authorize(child); await result }
  if (phase === 'submitting') f.api.submitRedirect(f.api.authState().id, 'com.panabit.mobile://callback')
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1)
  controller.abort()
  if (rejection) await rejection
  assert.equal(f.api.authState().state, 'failed')
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  child.finish(null, 'SIGTERM')
  assert.equal(f.time.tasks.size, 0)
})

test('auth: submit succeeds only on exit 0, validates redirect and resets phase timer', async () => {
  const f = await fixture()
  const { child, result } = f.start()
  f.authorize(child)
  const { id } = await result
  for (const invalid of ['https://not-a-callback', 'com.panabit.mobile://ok\ninjected', 'com.panabit.mobile://' + 'x'.repeat(17000)]) {
    assert.ok(f.api.submitRedirect(id, invalid).error)
  }
  assert.equal(child.writes.length, 0)
  f.api.submitRedirect(id, ' com.panabit.mobile://callback?code=secret ')
  assert.equal(child.writes[0], 'com.panabit.mobile://callback?code=secret\n')
  assert.ok(f.api.submitRedirect(id, 'com.panabit.mobile://again').error)
  child.finish(0)
  assert.equal(f.api.authState().state, 'done')
  assert.equal(f.api.inspectForTest().active, null)
  assert.equal(f.time.tasks.size, 0)
  assert.equal(f.api.cancelAuth(id).cancelled, false)
})

test('auth: output/partial lines are bounded and overlong URLs are not truncated', async () => {
  const f = await fixture()
  const { child, result } = f.start()
  child.stderr.emit('data', 'https://login.example/' + 'x'.repeat(200000))
  const session = f.api.inspectForTest().active
  assert.ok(session.buffer.stderr.length <= 8192)
  assert.ok(session.pending.stderr.length <= 16384)
  child.stderr.emit('data', '\n')
  assert.equal(f.api.authState().state, 'starting')
  f.authorize(child)
  await result
  child.stderr.emit('data', 'Error: ' + 'z'.repeat(100000))
  child.finish(1)
  assert.ok(f.api.authState().error.length <= 8192)
  assert.equal(f.api.inspectForTest().active, null)
  assert.equal('child' in f.api.inspectForTest().latest, false)
})

test('auth: cancelAll/dispose release starting promise and do not retain ended sessions', async () => {
  const f = await fixture()
  let firstId
  for (let i = 0; i < 30; i++) {
    const { child, result } = f.start()
    const rejection = assert.rejects(result, { name: 'AbortError' })
    firstId ??= f.api.authState().id
    assert.equal(f.api.cancelAllAuth().cancelled, 1)
    await rejection
    child.finish(null, 'SIGTERM')
    assert.equal(f.api.inspectForTest().active, null)
    assert.equal(f.time.tasks.size, 0)
  }
  assert.ok(f.api.cancelAuth(firstId).error)
  assert.equal(f.api.disposeAuth().cancelled, 0)
})

test('auth: cancellation escalates termination and late exit cannot overwrite failure', async () => {
  const f = await fixture()
  const { child, result } = f.start()
  const rejection = assert.rejects(result, { name: 'AbortError' })
  f.api.cancelAllAuth()
  await rejection
  f.time.tick(1000)
  assert.equal(child.kills.join('|'), 'SIGTERM|SIGKILL')
  child.finish(0)
  assert.equal(f.api.authState().state, 'failed')
  assert.equal(f.time.tasks.size, 0)
})

test('auth: abort from authorization log rejects start instead of returning cancelled URL', async () => {
  const f = await fixture()
  const controller = new AbortController()
  const { child, result } = f.start({ signal: controller.signal, log(message) {
    if (message.startsWith('已获取授权地址')) controller.abort()
  } })
  const rejection = assert.rejects(result, { name: 'AbortError' })
  f.authorize(child)
  await rejection
  child.finish(null, 'SIGTERM')
  assert.equal(f.api.authState().state, 'failed')
  assert.equal(f.time.tasks.size, 0)
})

test('auth: each transition clears the previous phase deadline', async () => {
  const f = await fixture()
  const { child, result } = f.start({ startTimeoutMs: 5, awaitTimeoutMs: 10, submitTimeoutMs: 20 })
  f.time.tick(4)
  f.authorize(child)
  const { id } = await result
  f.time.tick(5)
  assert.equal(f.api.authState().state, 'awaiting')
  f.api.submitRedirect(id, 'com.panabit.mobile://callback')
  f.time.tick(10)
  assert.equal(f.api.authState().state, 'submitting')
  assert.equal(f.time.tasks.size, 1)
  child.finish(0)
  assert.equal(f.time.tasks.size, 0)
})

for (const phase of ['starting', 'awaiting']) test(`auth: clean exit without submitting fails in ${phase}`, async () => {
  const f = await fixture()
  const { child, result } = f.start()
  const rejection = phase === 'starting' ? assert.rejects(result, /退出码/) : null
  if (phase === 'awaiting') { f.authorize(child); await result }
  child.finish(0)
  if (rejection) await rejection
  assert.equal(f.api.authState().state, 'failed')
  assert.equal(f.time.tasks.size, 0)
})

for (const phase of ['starting', 'awaiting', 'submitting']) test(`auth: cancelled ${phase} process blocks new start until actual exit`, async () => {
  const f = await fixture()
  const { child, result } = f.start()
  const rejection = phase === 'starting' ? assert.rejects(result, { name: 'AbortError' }) : null
  if (phase !== 'starting') { f.authorize(child); await result }
  if (phase === 'submitting') f.api.submitRedirect(f.api.authState().id, 'com.panabit.mobile://callback')
  f.api.cancelAllAuth()
  if (rejection) await rejection
  assert.equal(f.api.inspectForTest().retiring.size, 1)
  assert.equal(f.api.inspectForTest().active, null)
  await assert.rejects(f.start().result, /尚未退出/)
  assert.equal(f.children.length, 1)
  let cleaned = false
  const cleanup = f.api.waitForAuthCleanup().then(() => { cleaned = true })
  await flush()
  assert.equal(cleaned, false)
  assert.equal(f.api.cancelAllAuth().cancelled, 1)
  assert.equal(child.kills.length, 1)
  f.time.tick(999)
  assert.equal(cleaned, false)
  child.finish(null, 'SIGTERM')
  await cleanup
  assert.equal(cleaned, true)
  assert.equal(f.api.inspectForTest().retiring.size, 0)
  assert.equal(f.time.tasks.size, 0)
  const next = f.start()
  const nextRejection = assert.rejects(next.result, { name: 'AbortError' })
  assert.equal(f.children.length, 2)
  f.api.cancelAllAuth()
  next.child.finish(null, 'SIGTERM')
  await nextRejection
  await f.api.waitForAuthCleanup()
})

test('auth: cleanup timeout is bounded, rejects honestly and keeps exclusivity until late exit', async () => {
  const f = await fixture()
  const { child, result } = f.start()
  const rejection = assert.rejects(result, { name: 'AbortError' })
  f.api.cancelAllAuth()
  await rejection
  let settled = false
  const cleanup = f.api.waitForAuthCleanup()
  const cleanupRejection = assert.rejects(cleanup, { name: 'TimeoutError' }).then(() => { settled = true })
  f.time.tick(500)
  assert.equal(f.api.cancelAllAuth().cancelled, 1)
  f.time.tick(500)
  assert.equal(child.kills.join('|'), 'SIGTERM|SIGKILL')
  f.time.tick(499)
  await flush()
  assert.equal(settled, false)
  f.time.tick(1)
  await cleanupRejection
  assert.equal(f.time.tasks.size, 0)
  assert.equal(f.api.inspectForTest().retiring.size, 1)
  await assert.rejects(f.start().result, /尚未退出/)
  assert.equal(f.children.length, 1)
  await assert.rejects(f.api.waitForAuthCleanup(), { name: 'TimeoutError' })
  assert.equal(f.api.cancelAllAuth().cancelled, 1)
  assert.equal(child.kills.length, 2)
  child.finish(null, 'SIGKILL')
  assert.equal(f.api.inspectForTest().retiring.size, 0)
  await f.api.waitForAuthCleanup()
  const next = f.start()
  const nextRejection = assert.rejects(next.result, { name: 'AbortError' })
  f.api.cancelAllAuth()
  next.child.finish(null, 'SIGTERM')
  await nextRejection
  assert.equal(f.time.tasks.size, 0)
})

test('auth: close without exit releases retirement and cleanup wait', async () => {
  const f = await fixture()
  const { child, result } = f.start()
  const rejection = assert.rejects(result, { name: 'AbortError' })
  f.api.cancelAllAuth()
  await rejection
  const cleanup = f.api.waitForAuthCleanup()
  child.emit('close')
  await cleanup
  assert.equal(f.api.inspectForTest().retiring.size, 0)
  assert.equal(f.time.tasks.size, 0)
  assert.equal(f.api.cancelAllAuth().cancelled, 0)
})

test('auth: SIGKILL-confirmed exit resolves cleanup before the final deadline', async () => {
  const f = await fixture()
  const { child, result } = f.start()
  child.kill = (signal = 'SIGTERM') => {
    child.kills.push(signal)
    if (signal === 'SIGKILL') child.finish(null, signal)
    return true
  }
  const rejection = assert.rejects(result, { name: 'AbortError' })
  f.api.cancelAllAuth()
  await rejection
  const cleanup = f.api.waitForAuthCleanup()
  f.time.tick(1000)
  await cleanup
  assert.equal(f.api.inspectForTest().retiring.size, 0)
  assert.equal(f.time.tasks.size, 0)
})

test('auth: failed process is retired, natural exits and synchronous spawn failures need no cleanup', async () => {
  const f = await fixture()
  await f.api.waitForAuthCleanup()
  const { child, result } = f.start()
  const rejection = assert.rejects(result, /process failure/)
  child.emit('error', new Error('process failure'))
  await rejection
  await assert.rejects(f.start().result, /尚未退出/)
  child.finish(1)
  await f.api.waitForAuthCleanup()
  assert.equal(f.api.inspectForTest().retiring.size, 0)
  const next = f.start()
  f.authorize(next.child)
  const { id } = await next.result
  f.api.submitRedirect(id, 'com.panabit.mobile://callback')
  next.child.finish(0)
  await f.api.waitForAuthCleanup()
  assert.equal(f.time.tasks.size, 0)
  const broken = await fixture({ spawnError: new Error('spawn throws') })
  await assert.rejects(broken.start().result, /spawn throws/)
  await broken.api.waitForAuthCleanup()
  assert.equal(broken.api.inspectForTest().retiring.size, 0)
  assert.equal(broken.time.tasks.size, 0)
})

test('auth: close without exit rejects rather than hanging', async () => {
  const f = await fixture()
  const { child, result } = f.start()
  const rejection = assert.rejects(result, /已关闭/)
  child.emit('close')
  await rejection
  assert.equal(f.time.tasks.size, 0)
})
