import test from 'node:test'
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { fixture, deferred } from './helpers/runtime-fixture.mjs'
const tick=()=>new Promise(setImmediate)
const managed={overrides:{manageClient:true}}

test('monitor starts only after initialization completes and stops with runtime',async()=>{
  const ready=deferred();const {rt,state}=await fixture({'./iwan-client.js':{ensureIwanClient:()=>ready.promise}},managed)
  const init=rt.init();await tick();assert.equal(state.monitorStarted,undefined)
  ready.resolve({managed:true,isAlive:()=>true,stop(){}});await init;assert.equal(state.monitorStarted,true)
  await rt.dispose();assert.equal(state.monitorStopped,true)
})

test('recovery eligibility respects explicit opt-out, disabled routing, pause and missing requirements',async()=>{
  for(const options of [{overrides:{manageClient:false}},{overrides:{manageClient:true,enabled:false}}]){
    const {rt,state}=await fixture({},options);assert.equal(state.monitor.inspect().mode,'paused');await rt.dispose()
  }
  for(const overrides of [{'./binary.js':{resolveBinary:()=>({error:'missing'})}},{'./credentials.js':{readCredentialStatus:()=>({state:'missing',serverCount:0})}}]){
    const {rt,state}=await fixture(overrides,managed);assert.equal(state.monitor.inspect().mode,'blocked');await rt.dispose()
  }
  const {rt,state}=await fixture({},managed);await rt.connect();await rt.disconnect();assert.equal(state.monitor.inspect().mode,'paused');assert.equal(await state.monitor.recover({}),false);await rt.dispose()
})

test('wake invalidates old authentication proof and cached DNS until new managed connection',async()=>{
  let resolves=0,starts=0,stops=0
  const {rt,state}=await fixture({'./resolver.js':{createResolver:()=>{resolves++;return async()=>({ips:[],fake:false})}},'./iwan-client.js':{ensureIwanClient:async()=>{starts++;return {managed:true,isAlive:()=>true,isAuthenticated:()=>true,stop(){stops++}}}}},managed)
  await rt.connect();await rt.decide('ordinary.test');assert.equal(rt.status().auth.credentials.state,'valid');assert.equal(resolves,1)
  state.monitor.onWake();assert.equal(rt.status().auth.credentials.state,'unknown');await rt.decide('ordinary.test');assert.equal(resolves,2)
  assert.equal(await state.monitor.recover({}),true);assert.equal(starts,2);assert.equal(stops,1);assert.equal(rt.status().auth.credentials.state,'valid');await rt.dispose()
})

test('auto recovery waits for old process actual exit before spawning replacement',async()=>{
  const exit=deferred();let exited=false,starts=0
  const {rt,state}=await fixture({'./iwan-client.js':{ensureIwanClient:async()=>{starts++;return starts===1?{managed:true,isAlive:()=>true,hasExited:()=>exited,stop:()=>exit.promise.then(()=>{exited=true})}:{managed:true,isAlive:()=>true,stop(){}}}}},managed)
  await rt.connect();const recovery=state.monitor.recover({});await tick();assert.equal(starts,1)
  exit.resolve();assert.equal(await recovery,true);assert.equal(starts,2);await rt.dispose()
})

test('manual pause invalidates recovery queued behind another lifecycle task',async()=>{
  const bind=deferred();const {rt,state}=await fixture({'./split-proxy.js':{startSplitProxy:()=>bind.promise}},managed)
  await rt.connect();const updating=rt.applySettings({listenPort:19002});await tick()
  const recovering=state.monitor.recover({});await rt.disconnect();bind.resolve({close(){}})
  await updating;assert.equal(await recovering,false);assert.equal(state.clients.length,1);assert.equal(rt.status().iwan.paused,true);await rt.dispose()
})

test('external connection is never stopped or automatically replaced',async()=>{
  let stops=0,starts=0
  const {rt,state}=await fixture({'./iwan-client.js':{ensureIwanClient:async()=>{starts++;return {managed:false,stop(){stops++}}}}},managed)
  await rt.connect();assert.equal(state.monitor.inspect().mode,'external');assert.equal(await state.monitor.recover({}),false)
  await assert.rejects(rt.reconnect(),/外部客户端/);assert.equal(starts,1);assert.equal(stops,0);await rt.dispose();assert.equal(stops,0)
})

test('manual reconnect replaces a live owned process and duplicate calls share one operation',async()=>{
  let stops=0,starts=0
  const {rt}=await fixture({'./iwan-client.js':{ensureIwanClient:async()=>{starts++;return {managed:true,isAlive:()=>true,stop(){stops++}}}}},managed)
  await rt.connect();const first=rt.reconnect(),second=rt.reconnect();assert.equal(first,second);assert.equal(rt.status().iwan.connecting,true)
  await first;assert.equal(stops,1);assert.equal(starts,2);await rt.dispose()
})

test('manual stop cancels a queued explicit reconnect without late process creation',async()=>{
  const bind=deferred();const {rt,state}=await fixture({'./split-proxy.js':{startSplitProxy:()=>bind.promise}},managed)
  await rt.connect();const updating=rt.applySettings({listenPort:19003});await tick()
  const reconnecting=rt.reconnect();const rejected=assert.rejects(reconnecting,/取消|替代/)
  await rt.disconnect();bind.resolve({close(){}});await updating;await rejected;assert.equal(state.clients.length,1);await rt.dispose()
})

test('stale probe after a user operation is discarded instead of restarting new connection',async()=>{
  const probe=deferred();const {rt,state}=await fixture({'./iwan-client.js':{isPortOpen:()=>probe.promise}},managed)
  await rt.connect();const checking=state.monitor.probe({});await rt.connect();probe.resolve(false)
  await assert.rejects(checking,{name:'AbortError'});assert.equal(state.clients.length,1);await rt.dispose()
})

test('monitor cancellation propagates to pending managed startup and removes signal listener',async()=>{
  let calls=0
  const {rt,state}=await fixture({'./iwan-client.js':{ensureIwanClient:opts=>{calls++;if(calls===1)return Promise.resolve({managed:true,isAlive:()=>true,stop(){}});return new Promise((_,reject)=>opts.signal.addEventListener('abort',()=>reject(opts.signal.reason),{once:true}))}}},managed)
  await rt.connect();const controller=new AbortController();const recovering=state.monitor.recover({signal:controller.signal})
  const rejected=assert.rejects(recovering,{name:'AbortError'});await tick();controller.abort();await rejected
  assert.equal(getEventListeners(controller.signal,'abort').length,0);assert.equal(rt.status().iwan.managed,false);await rt.dispose()
})

test('busy authentication prevents automatic recovery and manual reconnect',async()=>{
  const {rt,state}=await fixture({'./auth.js':{authState:()=>({state:'awaiting'})}},managed)
  assert.equal(state.monitor.inspect().mode,'busy');assert.equal(await state.monitor.recover({}),false);await assert.rejects(rt.reconnect(),/认证/);await rt.dispose()
})
