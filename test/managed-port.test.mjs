import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { createRouteHandler } from '../lib/routes.js'
import { fixture as runtimeFixture } from './helpers/runtime-fixture.mjs'
import { fixture as clientFixture } from './helpers/client-fixture.mjs'

const host = '127.0.0.1'
const preferred = 1080 // An explicitly saved pre-upgrade port.
const getStatus = rt => createRouteHandler(rt)(new Request('http://localhost/ustc-iwan/api/status')).then(r => r.json()).then(r => r.value)

async function listen(t) {
  const server = createServer(socket => socket.end())
  server.listen(0, host)
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  return server.address().port
}

test('managed fallback uses the effective port for routing, monitor and status, without persisting it', async t => {
  const ports = [await listen(t), await listen(t)]
  const launches = [], probes = []
  const { rt, state } = await runtimeFixture({ './iwan-client.js': {
    ensureIwanClient: async opts => {
      launches.push(opts)
      return { managed: true, socksHost: host, socksPort: ports[launches.length - 1], stop() {} }
    },
    isPortOpen: async (port, address) => { probes.push([port, address]); return true },
  } }, { overrides: { manageClient: true, iwanSocksPort: preferred } })
  t.after(() => rt.dispose())
  await rt.init()
  for (const port of ports) {
    assert.equal(state.starts[0].iwan().proxyPort, port)
    assert.equal(await state.monitor.probe({}), true)
    assert.deepEqual(probes.at(-1), [port, host])
    const status = await getStatus(rt)
    assert.equal(status.iwan.socksPort, port)
    assert.equal(status.iwan.socksAlive, true)
    assert.equal(status.settings.iwanSocksPort, preferred)
    if (port === ports[0]) assert.equal(await state.monitor.recover({}), true)
  }
  assert.equal(state.starts.length, 1, 'changing the effective port does not restart the proxy')
  assert.equal(state.writes.length, 0)
  assert.deepEqual(launches.map(o => [o.autoSwitchPort, o.socksPort]), [[true, preferred], [true, preferred]])
  await rt.disconnect()
  assert.equal(state.starts[0].iwan(), null)
  assert.equal(rt.status().iwan.socksPort, preferred)
})

test('a configured occupied port is only used as an external endpoint when management is disabled', async t => {
  const port = await listen(t)
  for (const manageClient of [true, false]) {
    const { rt, state } = await runtimeFixture({ './binary.js': { resolveBinary: () => ({}) } }, { overrides: { manageClient, iwanSocksPort: port } })
    t.after(() => rt.dispose())
    await rt.init()
    assert.equal(state.starts[0].iwan()?.proxyPort ?? null, manageClient ? null : port)
    assert.equal((await getStatus(rt)).iwan.socksAlive, !manageClient)
    assert.equal(state.clients.length, 0)
  }
})

test('an expired native reconnect does not use an unrelated listener to stay healthy', async t => {
  const port = await listen(t)
  let native = null, probes = 0, launched = 0
  const { rt, state } = await runtimeFixture({ './iwan-client.js': {
    ensureIwanClient: async () => {
      launched++
      return { managed: true, socksPort: port, reconnectState: () => native, stop() { native = null } }
    },
    isPortOpen: async () => { probes++; return true },
  } }, { overrides: { manageClient: true }, monitoring: { now: () => 31_000 } })
  t.after(() => rt.dispose())
  await rt.init()
  native = { since: 1000, lastAttemptAt: 1000, attempt: 1, maxAttempts: 5 }
  assert.equal(state.monitor.inspect().nativeReconnectExpired, true)
  assert.equal(state.starts[0].iwan(), null)
  assert.equal(await state.monitor.probe({}), false)
  assert.equal(probes, 0)
  assert.equal((await getStatus(rt)).iwan.socksAlive, false)
  const recoveredInTime = state.monitor.recover({ reason: 'native-reconnect-timeout' })
  const expired = native
  native = null
  assert.equal(await recoveredInTime, false)
  native = expired
  assert.equal(await state.monitor.recover({ reason: 'native-reconnect-timeout' }), true)
  assert.equal(launched, 2)
})

test('settings card identifies the actual fallback without replacing the configured port', async () => {
  const ui = clientFixture(), server = ui.server()
  ui.setServer({ ...server, settings: { ...server.settings, manageClient: true, iwanSocksPort: preferred },
    iwan: { managed: true, socksAlive: true, socksHost: host, socksPort: 50080 } })
  await ui.mount()
  const dot = ui.nodes().find(node => node.props.label === '127.0.0.1:50080（在线）')
  assert.ok(dot)
  assert.match(ui.text(), /首选端口 1080 不可用，当前托管会话使用 50080/)
  assert.ok(ui.nodes().some(node => node.type === 'input' && node.props.type === 'number' && node.props.value === preferred))
  ui.unmount()
})
