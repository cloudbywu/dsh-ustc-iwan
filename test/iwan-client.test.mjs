import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, getEventListeners } from 'node:events'
import { readFile } from 'node:fs/promises'
import net from 'node:net'
import vm from 'node:vm'
import { isPortOpen, ensureIwanClient } from '../lib/iwan-client.js'
import { DEFAULT_IWAN_SOCKS_PORT } from '../lib/defaults.js'

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

function childProcess(autoExit) {
  const child = new EventEmitter()
  child.exitCode = child.signalCode = null
  child.pid = 123
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdout.setEncoding = child.stderr.setEncoding = () => {}
  child.stdin = new EventEmitter()
  child.writes = []
  child.stdin.write = (text, cb) => { child.writes.push(text); child.writeCallback = cb }
  child.stdin.destroy = () => { child.stdin.destroyed = true }
  child.kills = []
  child.finish = (code = 0, signal = null) => {
    child.exitCode = code
    child.signalCode = signal
    child.emit('exit', code, signal)
    child.emit('close', code, signal)
  }
  child.kill = (signal = 'SIGTERM') => {
    child.kills.push(signal)
    if (autoExit) queueMicrotask(() => child.finish(null, signal))
    return true
  }
  return child
}

async function fixture({ ports = [false, true], fallback = false, spawnError, autoExit = true, binds = [], realBinds = false } = {}) {
  const time = clock()
  const children = []
  const sockets = []
  const servers = []
  const context = vm.createContext({ URL, AbortController, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout })
  const cp = new vm.SyntheticModule(['spawn'], function () {
    this.setExport('spawn', (exe, args, options) => {
      if (spawnError) throw spawnError
      const child = childProcess(autoExit)
      child.command = { exe, args, options }
      children.push(child)
      return child
    })
  }, { context })
  const network = new vm.SyntheticModule(['default'], function () {
    this.setExport('default', { createServer(handler) {
      if (realBinds) return net.createServer(handler)
      const server = new EventEmitter()
      servers.push(server)
      server.listen = (options) => {
        server.options = options
        const outcome = binds.shift() ?? (options.port || 50000 + servers.length)
        if (outcome !== 'hang') queueMicrotask(() => {
          if (server.closed) return
          if (outcome instanceof Error) server.emit('error', outcome)
          else {
            server.address = () => ({ port: outcome })
            server.emit('listening')
          }
        })
      }
      server.close = (done) => { server.closed = true; queueMicrotask(done) }
      return server
    }, connect(options) {
      const outcome = ports.length ? ports.shift() : fallback
      if (outcome instanceof Error) throw outcome
      const socket = new EventEmitter()
      socket.options = options
      socket.destroy = () => { socket.destroyed = true }
      sockets.push(socket)
      if (outcome !== 'hang') queueMicrotask(() => {
        if (!socket.destroyed) socket.emit(outcome ? 'connect' : 'error', new Error('ECONNREFUSED'))
      })
      return socket
    } })
  }, { context })
  const source = await readFile(new URL('../lib/iwan-client.js', import.meta.url), 'utf8')
  const module = new vm.SourceTextModule(source, { context })
  const defaults = new vm.SyntheticModule(['DEFAULT_IWAN_SOCKS_PORT'], function () {
    this.setExport('DEFAULT_IWAN_SOCKS_PORT', DEFAULT_IWAN_SOCKS_PORT)
  }, { context })
  const owned = new vm.SyntheticModule(['trackOwnedProcess'], function () { this.setExport('trackOwnedProcess', () => {}) }, { context })
  await module.link((id) => ({ 'node:child_process': cp, 'node:net': network, './defaults.js': defaults, './owned-process.js': owned })[id])
  await module.evaluate()
  return { api: module.namespace, children, sockets, servers, time,
    start(options = {}) { return module.namespace.ensureIwanClient({ exePath: 'mock-client', ...options }) },
  }
}

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

test('client: real loopback TCP detection and existing port never launches executable', async () => {
  const server = net.createServer((socket) => socket.destroy())
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  try {
    assert.equal(await isPortOpen(port), true)
    const handle = await ensureIwanClient({ exePath: 'must-not-execute', socksPort: port })
    assert.equal(handle.managed, false)
    assert.equal(handle.isAlive(), false)
    await handle.stop()
  } finally { await new Promise((resolve) => server.close(resolve)) }
  assert.equal(await isPortOpen(port), false)
})

test('client: existing external listener has no child and no lifecycle listeners', async () => {
  const f = await fixture({ ports: [true] })
  const controller = new AbortController()
  const handle = await f.start({ signal: controller.signal })
  assert.equal(f.children.length, 0)
  assert.equal(handle.managed, false)
  assert.equal(handle.isAlive(), false)
  await handle.stop()
  controller.abort()
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  assert.equal(f.time.tasks.size, 0)
})

test('client: pre-aborted signal does not probe or spawn', async () => {
  const f = await fixture()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(f.start({ signal: controller.signal }), { name: 'AbortError' })
  assert.equal(f.sockets.length, 0)
  assert.equal(f.children.length, 0)
})

test('client: abort during initial TCP probe destroys socket and prevents spawn', async () => {
  const f = await fixture({ ports: ['hang'] })
  const controller = new AbortController()
  const result = f.start({ signal: controller.signal })
  const rejection = assert.rejects(result, { name: 'AbortError' })
  controller.abort()
  await rejection
  assert.equal(f.sockets[0].destroyed, true)
  assert.equal(f.children.length, 0)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  assert.equal(f.time.tasks.size, 0)
})

test('client: overall deadline includes initial TCP probe', async () => {
  const f = await fixture({ ports: ['hang'] })
  const rejection = assert.rejects(f.start({ timeoutMs: 5 }), { name: 'TimeoutError' })
  f.time.tick(5)
  await rejection
  assert.equal(f.children.length, 0)
  assert.equal(f.sockets[0].destroyed, true)
  assert.equal(f.time.tasks.size, 0)
})

test('client: invalid port and synchronous spawn failures reject and clean up', async () => {
  const invalid = await fixture({ ports: [new RangeError('invalid port')] })
  await assert.rejects(invalid.start(), /invalid port/)
  assert.equal(invalid.children.length, 0)
  assert.equal(invalid.time.tasks.size, 0)
  const f = await fixture({ spawnError: new Error('spawn throws') })
  await assert.rejects(f.start(), /spawn throws/)
  assert.equal(f.time.tasks.size, 0)
  const missing = await fixture({ ports: [false] })
  await assert.rejects(missing.api.ensureIwanClient(), /未配置/)
  assert.equal(missing.time.tasks.size, 0)
})

test('client: async child error rejects immediately instead of waiting for readiness', async () => {
  const f = await fixture({ ports: [false, 'hang'] })
  const rejection = assert.rejects(f.start(), /ENOENT/)
  await flush()
  f.children[0].emit('error', new Error('ENOENT asynchronous spawn failure'))
  await rejection
  await flush()
  assert.equal(f.children[0].kills.length, 1)
  assert.equal(f.sockets.every((socket) => socket.destroyed), true)
  assert.equal(f.time.tasks.size, 0)
})

test('client: process exit before readiness rejects with bounded diagnostics', async () => {
  const f = await fixture({ ports: [false, 'hang'] })
  const rejection = assert.rejects(f.start(), (error) => {
    assert.match(error.message, /code=3/)
    assert.ok(error.message.length < 500)
    return true
  })
  await flush()
  f.children[0].stderr.emit('data', 'x'.repeat(100000))
  f.children[0].finish(3)
  await rejection
  assert.equal(f.time.tasks.size, 0)
})

test('client: startup timeout kills child and clears polling and sockets', async () => {
  const f = await fixture({ ports: [false, 'hang'] })
  const rejection = assert.rejects(f.start({ timeoutMs: 10 }), { name: 'TimeoutError' })
  await flush()
  f.time.tick(10)
  await rejection
  await flush()
  assert.equal(f.children[0].kills.length, 1)
  assert.equal(f.sockets.every((socket) => socket.destroyed), true)
  assert.equal(f.time.tasks.size, 0)
})

test('client: abort while waiting for ready rejects without 30-second polling delay', async () => {
  const f = await fixture({ ports: [false, 'hang'] })
  const controller = new AbortController()
  const rejection = assert.rejects(f.start({ signal: controller.signal }), { name: 'AbortError' })
  await flush()
  assert.equal(f.children.length, 1)
  controller.abort()
  await rejection
  await flush()
  assert.equal(f.children[0].kills.length, 1)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  assert.equal(f.time.tasks.size, 0)
})

test('client: ready handle tracks exit, notifies once, supports unsubscribe and late observers', async () => {
  const f = await fixture()
  const controller = new AbortController()
  const handle = await f.start({ signal: controller.signal, server: 'line-a', extraArgs: ['--example'] })
  assert.equal(handle.managed, true)
  assert.equal(handle.isAlive(), true)
  const child = f.children[0]
  assert.ok(child.command.args.includes('202.38.64.1'))
  assert.ok(child.command.args.includes('line-a'))
  assert.ok(child.command.args.includes('--example'))
  let notifications = 0
  let removed = 0
  handle.onExit((info) => { notifications++; assert.equal(info.code, 2) })
  const unsubscribe = handle.onExit(() => { removed++ })
  unsubscribe()
  child.finish(2)
  assert.equal(handle.managed, false)
  assert.equal(handle.isAlive(), false)
  assert.equal(notifications, 1)
  assert.equal(removed, 0)
  let late = false
  handle.onExit((info) => { late = info.code === 2 })
  assert.equal(late, true)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  await handle.stop()
  assert.equal(child.kills.length, 0)
  assert.equal(f.time.tasks.size, 0)
})

test('client: external abort after readiness stops managed child and updates handle', async () => {
  const f = await fixture()
  const controller = new AbortController()
  const handle = await f.start({ signal: controller.signal })
  controller.abort()
  assert.equal(handle.isAlive(), false)
  await handle.stop()
  assert.equal(f.children[0].kills.length, 1)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  assert.equal(f.time.tasks.size, 0)
})

test('client: stop is idempotent, awaitable, escalates kill and detaches data/signal listeners', async () => {
  const f = await fixture({ autoExit: false })
  const controller = new AbortController()
  const handle = await f.start({ signal: controller.signal, stopGraceMs: 10 })
  let stopped = 0
  handle.onExit((info) => { if (info.stopped) stopped++ })
  let resolved = false
  const stopping = handle.stop().then(() => { resolved = true })
  const again = handle.stop()
  assert.equal(handle.managed, false)
  assert.equal(f.children[0].stdout.listenerCount('data'), 0)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  await flush()
  assert.equal(resolved, false)
  f.time.tick(10)
  assert.equal(f.children[0].kills.join('|'), 'SIGTERM|SIGKILL')
  f.children[0].finish(null, 'SIGKILL')
  await Promise.all([stopping, again])
  assert.equal(resolved, true)
  assert.equal(stopped, 1)
  assert.equal(f.time.tasks.size, 0)
})

test('client: stop resolves within bounded grace even if broken child never emits exit', async () => {
  const f = await fixture({ autoExit: false })
  const handle = await f.start({ stopGraceMs: 5 })
  const stopping = handle.stop()
  f.time.tick(505)
  await stopping
  assert.equal(handle.isAlive(), false)
  assert.equal(f.children[0].kills.join('|'), 'SIGTERM|SIGKILL')
  assert.equal(f.time.tasks.size, 0)
})

for (const mode of ['event', 'callback', 'throw']) test(`client: selection stdin EPIPE via ${mode} rejects safely`, async () => {
  const f = await fixture({ ports: [false, 'hang'] })
  const rejection = assert.rejects(f.start(), /EPIPE/)
  await flush()
  const child = f.children[0]
  const error = new Error('write EPIPE')
  if (mode === 'throw') child.stdin.write = () => { throw error }
  child.stdout.emit('data', 'Select server [1-4]:')
  if (mode === 'event') child.stdin.emit('error', error)
  if (mode === 'callback') child.writeCallback(error)
  await rejection
  await flush()
  child.stdin.emit('error', error)
  assert.equal(child.kills.length, 1)
  assert.equal(f.time.tasks.size, 0)
})

test('client: split selection prompt is answered only once, keeping defaults and extra arguments', async () => {
  const f = await fixture({ ports: [false, 'hang'] })
  const result = f.start({ extraArgs: ['--verbose'], dns: 'custom-dns' })
  await flush()
  const child = f.children[0]
  child.stdout.emit('data', 'Select ser')
  assert.equal(child.writes.length, 0)
  child.stdout.emit('data', 'ver [1-3]:')
  child.stdout.emit('data', 'Select server [1-3]:')
  assert.equal(child.writes.join('|'), '1\n')
  assert.ok(child.command.args.includes('custom-dns'))
  assert.ok(child.command.args.includes('--verbose'))
  f.sockets.at(-1).emit('connect')
  const handle = await result
  await handle.stop()
  assert.equal(f.time.tasks.size, 0)
})

test('client: explicit server does not answer selection prompt and logs are bounded', async () => {
  const f = await fixture()
  const logs = []
  const handle = await f.start({ server: 'fixed-line', log: (text) => logs.push(text) })
  const child = f.children[0]
  child.stdout.emit('data', 'x'.repeat(100000) + 'Select server [1-3]:')
  assert.equal(child.writes.length, 0)
  assert.ok(logs.at(-1).length <= 2000)
  await handle.stop()
  assert.equal(f.time.tasks.size, 0)
})

test('client: assembles fragmented output into bounded timestamp-free log entries', async () => {
  const f = await fixture(), logs = []
  await f.start({ log: text => logs.push(text) })
  const child = f.children[0]
  const base = logs.length
  child.stdout.emit('data', '[2026-11-19T00:07:16.456Z IN')
  assert.equal(logs.length, base)
  child.stdout.emit('data', 'FO started]\r\nordinary output\n' + 'x'.repeat(5000))
  child.stdout.emit('data', '\nnext line\n')
  child.stderr.emit('data', '[2026-11-19T00:07:17+08:00] WARN last line')
  child.finish(1)
  assert.deepEqual(logs.slice(base), ['[INFO started]', 'ordinary output', 'next line', 'WARN last line'])
})

test('client: error after readiness updates handle, and logging errors cannot break cleanup', async () => {
  const f = await fixture()
  const handle = await f.start({ log() { throw new Error('logger failure') } })
  let notified = false
  handle.onExit((info) => { notified = /runtime failure/.test(info.error.message) })
  f.children[0].emit('error', new Error('runtime failure'))
  assert.equal(handle.managed, false)
  assert.equal(notified, true)
  await handle.stop()
  assert.equal(f.time.tasks.size, 0)
})

test('client: close without exit rejects pending readiness and clears probes', async () => {
  const f = await fixture({ ports: [false, 'hang'] })
  const rejection = assert.rejects(f.start(), /已关闭/)
  await flush()
  f.children[0].emit('close')
  await rejection
  assert.equal(f.time.tasks.size, 0)
})

test('client: ready state clears startup deadline and abort during ready log still rejects', async () => {
  const f = await fixture()
  const handle = await f.start({ timeoutMs: 5 })
  f.time.tick(100)
  assert.equal(handle.isAlive(), true)
  assert.equal(f.children[0].kills.length, 0)
  await handle.stop()
  assert.equal(f.time.tasks.size, 0)
  const reentrant = await fixture()
  const controller = new AbortController()
  await assert.rejects(reentrant.start({ signal: controller.signal, log(message) {
    if (message.startsWith('iWAN SOCKS5 就绪')) controller.abort()
  } }), { name: 'AbortError' })
  await flush()
  assert.equal(reentrant.children[0].kills.length, 1)
  assert.equal(reentrant.time.tasks.size, 0)
})

test('client: individual TCP probe has deadline and abort cancellation', async () => {
  const f = await fixture({ ports: ['hang', 'hang'] })
  const timed = f.api.isPortOpen(1080, '127.0.0.1', 7)
  f.time.tick(7)
  assert.equal(await timed, false)
  const controller = new AbortController()
  const rejection = assert.rejects(f.api.isPortOpen(1080, '127.0.0.1', 800, { signal: controller.signal }), { name: 'AbortError' })
  controller.abort()
  await rejection
  assert.equal(f.sockets.every((socket) => socket.destroyed), true)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  assert.equal(f.time.tasks.size, 0)
})

test('client: authentication proof requires complete owned stdout listener evidence',async()=>{
  const f=await fixture();let spawned
  const handle=await f.start({onSpawned:value=>{spawned=value}});const child=f.children[0]
  assert.equal(spawned,handle);assert.equal(handle.isAuthenticated(),false)
  child.stderr.emit('data','SOCKS5 listening on 127.0.0.1:21080\n');assert.equal(handle.isAuthenticated(),false)
  child.stdout.emit('data','SOCKS5 listening on 127.0.0.1:21081\n');assert.equal(handle.isAuthenticated(),false)
  child.stdout.emit('data','SOCKS5 listening on 127.0.0.1:2108');assert.equal(handle.isAuthenticated(),false)
  child.stdout.emit('data','0');assert.equal(handle.isAuthenticated(),false)
  child.stdout.emit('data','\n');assert.equal(handle.isAuthenticated(),true);assert.ok(handle.authenticatedAt>0)
  child.finish();assert.equal(handle.isAuthenticated(),false);assert.equal(handle.hasExited(),true)
})

test('client: bounded stopping never pretends an unresponsive process exited',async()=>{
  const f=await fixture({autoExit:false});const handle=await f.start()
  const stopping=handle.stop();f.time.tick(1501);await stopping
  assert.equal(handle.isAlive(),false);assert.equal(handle.hasExited(),false)
  f.children[0].finish();assert.equal(handle.hasExited(),true)
})

test('client: spawned pending handle remains awaitable after connection abort',async()=>{
  const f=await fixture({ports:[false,'hang'],autoExit:false});let spawned
  const controller=new AbortController();const starting=f.start({signal:controller.signal,onSpawned:handle=>{spawned=handle}})
  await flush();assert.ok(spawned);const rejected=assert.rejects(starting,{name:'AbortError'});controller.abort();await rejected
  const stopping=spawned.stop();f.time.tick(1501);await stopping;assert.equal(spawned.hasExited(),false)
  f.children[0].finish();assert.equal(spawned.hasExited(),true)
})

test('client: IPv6 listener argument and authentication evidence use bracketed authority',async()=>{
  const f=await fixture();const handle=await f.start({socksHost:'::1'})
  assert.ok(f.children[0].command.args.includes('[::1]:21080'))
  f.children[0].stdout.emit('data','SOCKS5 listening on [::1]:21080\n');assert.equal(handle.isAuthenticated(),true)
  await handle.stop()
})

const reconnectLine = (n = 1, m = 5) => 'connection ended: send VPN packet; reconnecting (' + n + '/' + m + ')...\n'
const listenerLine = 'SOCKS5 listening on 127.0.0.1:21080\n'

test('client: native attempts preserve first deadline and ignore repeated progress', async () => {
  let time = 0
  const f = await fixture()
  const handle = await f.start({ now: () => time })
  const child = f.children[0]
  child.stdout.emit('data', reconnectLine())
  time = 1000
  child.stderr.emit('data', reconnectLine(2))
  assert.equal(handle.reconnectState().since, 0)
  assert.equal(handle.reconnectState().lastAttemptAt, 1000)
  time = 2000
  child.stderr.emit('data', 'unrelated\n')
  child.stdout.emit('data', reconnectLine(2) + reconnectLine(1))
  assert.equal(handle.reconnectState().lastAttemptAt, 1000)
  assert.equal(handle.reconnectState().attempt, 2)
  time = 3000
  child.stdout.emit('data', reconnectLine(3))
  assert.equal(handle.reconnectState().since, 0)
  assert.equal(handle.reconnectState().lastAttemptAt, 3000)
  child.stdout.emit('data', listenerLine)
  time = 4000
  child.stderr.emit('data', reconnectLine(4))
  assert.equal(handle.reconnectState().since, 4000)
  child.finish(1)
  assert.equal(handle.isReconnecting(), false)
  assert.equal(handle.reconnectState(), null)
  assert.equal(handle.authenticatedAt, null)
  child.stdout.emit('data', listenerLine + reconnectLine())
  assert.equal(handle.isAuthenticated(), false)
  assert.equal(handle.reconnectState(), null)
})

test('client: giant complete and fragmented lines cannot fabricate state evidence', async () => {
  const f = await fixture()
  const handle = await f.start()
  const child = f.children[0]
  child.stderr.emit('data', 'x'.repeat(100000) + reconnectLine())
  child.stdout.emit('data', 'x'.repeat(5000))
  child.stdout.emit('data', listenerLine)
  child.stderr.emit('data', 'x'.repeat(4097))
  child.stderr.emit('data', reconnectLine())
  assert.equal(handle.isReconnecting(), false)
  assert.equal(handle.isAuthenticated(), false)
  child.stdout.emit('data', listenerLine)
  assert.equal(handle.isAuthenticated(), true)
  child.stderr.emit('data', reconnectLine())
  child.stdout.emit('data', 'x'.repeat(100000) + listenerLine)
  assert.equal(handle.isReconnecting(), true)
  child.stdout.emit('data', listenerLine)
  assert.equal(handle.isAuthenticated(), true)
  await handle.stop()
  assert.equal(handle.isReconnecting(), false)
  assert.equal(handle.reconnectState(), null)
})

test('client: invalid and incomplete native lines are not state evidence', async () => {
  const f = await fixture()
  const handle = await f.start()
  const child = f.children[0]
  for (const line of [reconnectLine(0), reconnectLine(5), reconnectLine(6), reconnectLine(1, 0), reconnectLine().trimEnd() + 'suffix\n', 'prefix ' + reconnectLine()]) child.stderr.emit('data', line)
  assert.equal(handle.isReconnecting(), false)
  child.stderr.emit('data', reconnectLine().slice(0, -1))
  child.finish(1)
  assert.equal(handle.reconnectState(), null)
})

test('client: default selection is explicit and native retries need no stdin reset', async () => {
  for (const options of [{}, { server: 'chosen' }, { server: 'auto' }, { extraArgs: ['--auto'] }, { extraArgs: ['--server', '3'] }, { extraArgs: ['--server=2'] }]) {
    const f = await fixture()
    const handle = await f.start(options)
    const child = f.children[0]
    const args = child.command.args
    if (options.server) assert.equal(args[args.indexOf('--server') + 1], options.server)
    else if (!options.extraArgs) assert.equal(args[args.indexOf('--server') + 1], '1')
    else {
      for (const arg of options.extraArgs) assert.ok(args.includes(arg))
      assert.equal(args.filter(arg => arg === '--server').length, options.extraArgs.includes('--server') ? 1 : 0)
    }
    child.stderr.emit('data', reconnectLine())
    child.stdout.emit('data', listenerLine)
    child.stderr.emit('data', reconnectLine(2))
    child.stdout.emit('data', listenerLine)
    assert.equal(child.writes.length, 0)
    assert.equal(handle.isAuthenticated(), true)
    await handle.stop()
  }
})

test('client: stop interrupts native reconnect and clears all public progress evidence', async () => {
  const f = await fixture()
  const handle = await f.start()
  const child = f.children[0]
  child.stderr.emit('data', reconnectLine())
  assert.equal(handle.isReconnecting(), true)
  assert.deepEqual(Object.keys(handle.reconnectState()).sort(), ['attempt', 'lastAttemptAt', 'maxAttempts', 'since'])
  await handle.stop()
  assert.equal(handle.isAlive(), false)
  assert.equal(handle.isReconnecting(), false)
  assert.equal(handle.reconnectState(), null)
  assert.equal(handle.isAuthenticated(), false)
  assert.equal(child.kills.length, 1)
  assert.equal(f.time.tasks.size, 0)
})

test('client: native reconnect consumes fresh fragmented lines and invalidates old proof', async () => {
  let time = 100
  const f = await fixture()
  const handle = await f.start({ now: () => time })
  const child = f.children[0]
  child.stdout.emit('data', listenerLine)
  assert.equal(handle.authenticatedAt, 100)
  const line = reconnectLine()
  child.stderr.emit('data', line.slice(0, 30))
  child.stdout.emit('data', 'unrelated\n')
  assert.equal(handle.isReconnecting(), false)
  child.stderr.emit('data', line.slice(30, -1))
  assert.equal(handle.isAuthenticated(), true)
  time = 200
  child.stderr.emit('data', '\r\n')
  assert.equal(handle.isAlive(), true)
  assert.equal(handle.isReconnecting(), true)
  assert.equal(handle.isAuthenticated(), false)
  assert.equal(handle.authenticatedAt, null)
  assert.equal(JSON.stringify(handle.reconnectState()), JSON.stringify({ since: 200, lastAttemptAt: 200, attempt: 1, maxAttempts: 5 }))
  const copy = handle.reconnectState(); copy.since = -1
  assert.equal(handle.reconnectState().since, 200)
  child.stdout.emit('data', 'ordinary log\n')
  child.stderr.emit('data', listenerLine)
  child.stdout.emit('data', listenerLine.replace(':21080', ':21081'))
  child.stdout.emit('data', listenerLine.replace('127.0.0.1', '127.0.0.2'))
  assert.equal(handle.isReconnecting(), true)
  time = 500
  child.stdout.emit('data', listenerLine.slice(0, -1))
  assert.equal(handle.isAuthenticated(), false)
  child.stdout.emit('data', '\n')
  assert.equal(handle.isReconnecting(), false)
  assert.equal(handle.reconnectState(), null)
  assert.equal(handle.isAuthenticated(), true)
  assert.equal(handle.authenticatedAt, 500)
  child.stderr.emit('data', 'next status\n')
  assert.equal(handle.isReconnecting(), false)
  await handle.stop()
})

test('client: managed startup bypasses a real busy listener and releases the new bind', async () => {
  const busy = net.createServer((socket) => socket.destroy())
  const listen = (server, port) => new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  const close = (server) => new Promise((resolve) => server.close(resolve))
  await listen(busy, 0)
  try {
    const requested = busy.address().port
    const f = await fixture({ ports: [true], realBinds: true })
    let notifySpawn
    const spawned = new Promise((resolve) => { notifySpawn = resolve })
    const result = f.start({ autoSwitchPort: true, socksPort: requested, onSpawned: notifySpawn })
    const handle = await Promise.race([spawned, result])
    const chosen = handle.socksPort
    assert.equal(handle.socksHost, '127.0.0.1')
    assert.ok(chosen >= 1024 && chosen !== requested)
    assert.throws(() => { handle.socksPort = requested }, TypeError)
    const child = f.children[0]
    assert.ok(child.command.args.includes('127.0.0.1:' + chosen))
    const released = net.createServer()
    await listen(released, chosen)
    await close(released)
    child.stdout.emit('data', 'SOCKS5 listening on 127.0.0.1:' + chosen + '\n')
    f.time.tick(200)
    assert.equal(await result, handle)
    await handle.stop()
    assert.equal(await isPortOpen(requested), true)
  } finally { await close(busy) }
})

for (const exclusion of [{ code: 'EACCES' }, { errno: 10013 }, { errno: -10048 }]) {
  test('client: preflight handles Windows excluded port ' + JSON.stringify(exclusion), async () => {
    const f = await fixture({ binds: [Object.assign(new Error('excluded'), exclusion), 53000], ports: [true] })
    const result = f.start({ autoSwitchPort: true, socksHost: '[::1]' })
    await flush()
    assert.deepEqual(f.servers.map(({ options }) => ({ ...options })), [
      { host: '::1', port: 21080, exclusive: true }, { host: '::1', port: 0, exclusive: true },
    ])
    assert.equal(f.servers[1].closed, true)
    assert.equal(f.children.length, 1)
    assert.ok(f.children[0].command.args.includes('[::1]:53000'))
    f.children[0].stdout.emit('data', 'SOCKS5 listening on [::1]:53000\n')
    f.time.tick(200)
    const handle = await result
    assert.equal(handle.socksHost, '::1')
    assert.equal(handle.socksPort, 53000)
    await handle.stop()
  })
}

test('client: managed readiness needs fresh owned stdout before TCP and survives native renew', async () => {
  const f = await fixture({ ports: ['hang', true] })
  let ready = false
  const result = f.start({ autoSwitchPort: true }).then((handle) => { ready = true; return handle })
  await flush()
  const child = f.children[0]
  assert.ok(child.command.args.includes('127.0.0.1:21080'))
  child.stderr.emit('data', listenerLine)
  child.stdout.emit('data', listenerLine.replace(':21080', ':21081'))
  child.stdout.emit('data', listenerLine.slice(0, -1))
  f.time.tick(200)
  assert.equal(f.sockets.length, 0)
  assert.equal(ready, false)
  child.stdout.emit('data', '\n')
  f.time.tick(200)
  assert.equal(f.sockets.length, 1)
  child.stderr.emit('data', reconnectLine())
  child.stdout.emit('data', listenerLine)
  f.sockets[0].emit('connect')
  await flush()
  assert.equal(ready, false, 'TCP from a previous proof cannot attest the renewed listener')
  f.time.tick(200)
  const handle = await result
  assert.equal(handle.isAuthenticated(), true)
  child.stderr.emit('data', reconnectLine(2))
  assert.equal(handle.isAuthenticated(), false)
  child.stdout.emit('data', listenerLine)
  assert.equal(handle.isAuthenticated(), true)
  await handle.stop()
})

test('client: bind race drains stderr after exit and only retries on close', async () => {
  const f = await fixture({ binds: [21080, 53001], ports: [true] })
  const result = f.start({ autoSwitchPort: true })
  await flush()
  const first = f.children[0]
  f.time.tick(200)
  assert.equal(f.sockets.length, 0, 'a foreign listener cannot satisfy startup')
  first.emit('exit', 1, null)
  first.stderr.emit('data', 'Error: bind SOCKS5 listener 127.0.0.1:21080\r\n\r\nCaused by:\r\n    试图以访问权限所禁止的方式访问套接字。 (os error 10013)')
  await flush()
  assert.equal(f.children.length, 1)
  first.emit('close', 1, null)
  await flush()
  assert.equal(f.children.length, 2)
  assert.deepEqual(first.kills, [])
  f.children[1].stdout.emit('data', 'SOCKS5 listening on 127.0.0.1:53001\n')
  f.time.tick(200)
  const handle = await result
  assert.equal(handle.socksPort, 53001)
  await handle.stop()
})

test('client: native bind race waits for confirmed teardown and shares the original deadline', async () => {
  const f = await fixture({ autoExit: false })
  const result = assert.rejects(f.start({ autoSwitchPort: true, timeoutMs: 40 }), { name: 'TimeoutError' })
  await flush()
  const first = f.children[0]
  f.time.tick(15)
  first.stderr.emit('data', 'connection ended: bind SOCKS5 listener 127.0.0.1:21080; reconnecting (1/5)...\n')
  assert.deepEqual(first.kills, ['SIGTERM'])
  await flush()
  assert.equal(f.children.length, 1)
  first.finish(null, 'SIGTERM')
  await flush()
  assert.equal(f.children.length, 2)
  f.time.tick(25)
  await result
  const second = f.children[1]
  assert.deepEqual(second.kills, ['SIGTERM'])
  second.finish(null, 'SIGTERM')
  assert.equal(f.time.tasks.size, 0)
})

test('client: abort during preflight closes the bind without spawning', async () => {
  const f = await fixture({ binds: ['hang'] })
  const controller = new AbortController()
  const result = assert.rejects(f.start({ autoSwitchPort: true, signal: controller.signal }), { name: 'AbortError' })
  controller.abort()
  await result
  assert.equal(f.servers[0].closed, true)
  assert.equal(f.servers[0].listenerCount('error'), 0)
  assert.equal(f.children.length, 0)
  assert.equal(f.time.tasks.size, 0)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('client: abort while retiring a bind-raced child cannot spawn a replacement', async () => {
  const f = await fixture({ autoExit: false })
  const controller = new AbortController()
  let childHandle
  const result = assert.rejects(f.start({ autoSwitchPort: true, signal: controller.signal,
    onSpawned: (handle) => { childHandle = handle } }), { name: 'AbortError' })
  await flush()
  const child = f.children[0]
  child.stderr.emit('data', 'connection ended: bind SOCKS5 listener 127.0.0.1:21080; reconnecting (1/5)...\n')
  controller.abort()
  await result
  const stopping = childHandle.stop()
  f.time.tick(1500)
  await stopping
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL'])
  assert.equal(childHandle.hasExited(), false)
  child.finish(null, 'SIGKILL')
  assert.equal(childHandle.hasExited(), true)
  assert.equal(f.children.length, 1)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  assert.equal(f.time.tasks.size, 0)
})

test('client: unrelated bind preflight and child errors never try another port', async () => {
  const invalid = await fixture({ binds: [Object.assign(new Error('unavailable address'), { code: 'EADDRNOTAVAIL' })] })
  await assert.rejects(invalid.start({ autoSwitchPort: true }), /unavailable address/)
  assert.equal(invalid.servers.length, 1)
  assert.equal(invalid.children.length, 0)

  for (const error of [
    'Error: authentication failed\n\nCaused by:\n    拒绝访问。 (os error 10013)',
    'Error: connect upstream: EADDRINUSE',
    'Error: bind SOCKS5 listener 127.0.0.1:21081: EADDRINUSE',
    'Error: bind SOCKS5 listener 127.0.0.1:21080: Address not available (os error 99)',
  ]) {
    const f = await fixture()
    const result = assert.rejects(f.start({ autoSwitchPort: true }), /code=1/)
    await flush()
    const child = f.children[0]
    child.stderr.emit('data', error + '\n')
    child.finish(1)
    await result
    assert.equal(f.children.length, 1)
    assert.equal(f.servers.length, 1)
    assert.equal(f.time.tasks.size, 0)
  }
})

test('client: managed candidate retries are bounded', async () => {
  const f = await fixture()
  const result = assert.rejects(f.start({ autoSwitchPort: true }), /EADDRINUSE/)
  for (let i = 0; i < 4; i++) {
    await flush()
    const child = f.children[i]
    const addr = child.command.args[child.command.args.indexOf('--socks-listen') + 1]
    child.stderr.emit('data', 'Error: bind SOCKS5 listener ' + addr + ': EADDRINUSE\n')
    child.finish(1)
  }
  await result
  assert.equal(f.children.length, 4)
  assert.equal(f.time.tasks.size, 0)
})
