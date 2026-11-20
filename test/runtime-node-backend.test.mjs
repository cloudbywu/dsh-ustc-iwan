import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { fixture, defaults, deferred } from './helpers/runtime-fixture.mjs'
import { createRouteHandler } from '../lib/routes.js'

async function untilSwitchSettles(rt) {
  for (let i = 0; i < 20 && rt.status().iwan.backendSwitch?.state === 'switching'; i++) await setImmediate()
  assert.notEqual(rt.status().iwan.backendSwitch?.state, 'switching')
  return rt.status().iwan.backendSwitch
}

const managed = (backend, events) => {
  let alive = true
  return { backend, managed:true, socksHost:'127.0.0.1', socksPort:21080, isAuthenticated:()=>alive,
    hasExited:()=>!alive, isAlive:()=>alive, stop(){alive=false;events.push(['stop',backend])} }
}

test('backend selection stops the previous managed session and Node can start and sign in without the native binary', async t => {
  let hasExe = true, authOptions, authBusy = false
  const events = [], makeAuth = () => { throw new Error('only injection verified') }
  const {rt,state} = await fixture({
    './settings-store.js': { readSettings:()=>({...defaults,manageClient:true}) },
    './iwan-client.js': { ensureIwanClient:async opts=>{events.push(['native',opts.exePath]);return managed('native',events)} },
    './node-iwan/backend.js': {ensureNodeIwan:async opts=>{events.push(['node',opts.exePath]);return managed('node',events)}},
    './node-iwan/oidc.js': { createNodeIwanAuthorization:makeAuth },
    './binary.js': { resolveBinary:()=>({path:hasExe?'native-fixture':undefined}), binaryState:()=>({installed:hasExe}) },
    './auth.js': { startAuth:options=>{authOptions=options;return Promise.resolve({state:'awaiting'})}, authState:()=>({state:authBusy?'awaiting':'idle'}) },
  })
  t.after(()=>rt.dispose())
  await rt.init()
  assert.deepEqual(events,[['native','native-fixture']]); assert.equal(rt.status().iwan.activeBackend,'native')
  hasExe = false
  await rt.applySettings({iwanBackend:'node'})
  assert.equal((await untilSwitchSettles(rt)).state,'done')
  assert.deepEqual(events,[['native','native-fixture'],['stop','native'],['node',undefined]])
  assert.equal(rt.status().settings.iwanBackend,'node'); assert.equal(rt.status().iwan.activeBackend,'node')
  assert.equal(rt.status().auth.canStart,true); assert.equal(rt.status().auth.credentials.state,'valid')
  await rt.beginAuth()
  assert.equal(authOptions.createAuthorization,makeAuth); assert.equal(authOptions.exePath,undefined)
  assert.throws(()=>rt.installClient(),/无需安装/)
  authBusy = true
  await assert.rejects(rt.applySettings({iwanBackend:'native'}),{status:409})
  assert.equal(state.writes.length,1)
  authBusy = false; hasExe = true
  await rt.applySettings({iwanBackend:'native'})
  assert.equal((await untilSwitchSettles(rt)).state,'done')
  assert.deepEqual(events.slice(-2),[['stop','node'],['native','native-fixture']]); assert.equal(rt.status().iwan.activeBackend,'native')
})

test('successful settings save does not await backend startup; failures remain distinct from persistence', async t => {
  const started = deferred(), finish = deferred(), events = []
  const { rt, state } = await fixture({
    './settings-store.js': { readSettings:()=>({...defaults,manageClient:true}) },
    './iwan-client.js': { ensureIwanClient:async ()=>managed('native',events) },
    './node-iwan/backend.js': { ensureNodeIwan:async ()=>{started.resolve();await finish.promise;throw new Error('synthetic startup failure')} },
  })
  t.after(async()=>{finish.resolve();await rt.dispose()})
  await rt.init()
  const route = createRouteHandler(rt)
  const reply = await Promise.race([route(new Request('http://localhost/ustc-iwan/api/settings', {
    method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({iwanBackend:'node'}),
  })), setImmediate(null)])
  assert.equal(reply?.status,200)
  const saved = (await reply.json()).value
  assert.equal(saved.settings.iwanBackend,'node')
  assert.equal(saved.iwan.backendSwitch.state,'switching')
  await started.promise
  assert.equal(rt.status().iwan.backendSwitch.state,'switching')
  assert.equal(state.writes.at(-1).iwanBackend,'node')
  assert.throws(()=>rt.beginAuth(),{status:409})
  await assert.rejects(rt.reconnect(),{status:409})
  const secondSave = rt.applySettings({iwanBackend:'native'}); const rejection = assert.rejects(secondSave,{status:409})
  finish.resolve()
  await rejection
  assert.equal((await untilSwitchSettles(rt)).state,'failed')
  assert.equal(rt.status().settings.iwanBackend,'node')
  assert.equal(rt.status().iwan.activeBackend,null)
  await rt.applySettings({iwanBackend:'native'})
  assert.equal((await untilSwitchSettles(rt)).state,'done')
  assert.equal(rt.status().iwan.activeBackend,'native')
})

test('stopping during background switch prevents a new connection from coming up', async t => {
  const stopping = deferred(), release = deferred(), events = []
  const {rt} = await fixture({
    './settings-store.js': { readSettings:()=>({...defaults,manageClient:true}) },
    './iwan-client.js': { ensureIwanClient:async ()=>{
      let stopped = false
      return { managed:true,isAlive:()=>!stopped,hasExited:()=>stopped,async stop(){stopping.resolve();await release.promise;stopped=true} }
    } },
    './node-iwan/backend.js': { ensureNodeIwan:async ()=>{events.push('node');return managed('node',events)} },
  })
  t.after(async()=>{release.resolve();await rt.dispose()})
  await rt.init(); await rt.applySettings({iwanBackend:'node'}); await stopping.promise
  const stopped = rt.disconnect(); release.resolve(); await stopped
  assert.equal((await untilSwitchSettles(rt)).state,'waiting')
  assert.equal(rt.status().iwan.paused,true); assert.deepEqual(events,[])
})

test('split DNS is independent in Node mode; native retains the historical DNS value', async t => {
  const values = []
  const {rt} = await fixture({
    './settings-store.js': {readSettings:()=>({...defaults,iwanBackend:'node',manageClient:true,dnsServer:'2001:db8::53'})},
    './iwan-client.js': {ensureIwanClient:async ({dns})=>{values.push(['native',dns]);return managed('native',[])}},
    './node-iwan/backend.js': {ensureNodeIwan:async ({dns})=>{values.push(['node',dns]);return managed('node',[])}},
  })
  t.after(()=>rt.dispose())
  await rt.init(); assert.deepEqual(values,[['node','202.38.64.1']])
  await rt.applySettings({dnsServer:'223.5.5.5'}); assert.equal(values.length,1)
  await rt.applySettings({iwanTunnelDns:'202.38.64.1:5353'}); assert.deepEqual(values.at(-1),['node','202.38.64.1:5353'])
  await rt.applySettings({iwanBackend:'native'}); await untilSwitchSettles(rt)
  assert.deepEqual(values.at(-1),['native','223.5.5.5'])
})

test('Node selected with management off never starts either backend for the external SOCKS port', async t => {
  const calls = []
  const {rt} = await fixture({
    './settings-store.js': {readSettings:()=>({...defaults,iwanBackend:'node',manageClient:false})},
    './iwan-client.js': {ensureIwanClient:async opts=>{calls.push(opts);return {managed:false}}},
  })
  t.after(()=>rt.dispose())
  await rt.init()
  assert.equal(calls.length,0)
  assert.equal((await rt.connect()).managed,false)
  assert.equal(calls.length,1); assert.equal(calls[0].exePath,undefined); assert.equal(calls[0].autoSwitchPort,false)
  assert.equal(rt.status().iwan.activeBackend,null)
})
