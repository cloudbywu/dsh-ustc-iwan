import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, deferred } from './helpers/runtime-fixture.mjs'
const tick=()=>new Promise(setImmediate)

test('default management waits quietly for installation and saved credentials',async()=>{
  for(const missing of ['binary','credentials']){
    const overrides=missing==='binary'?{'./binary.js':{resolveBinary:()=>({error:'missing'})}}:{'./credentials.js':{readCredentialStatus:()=>({state:'missing',serverCount:0,revision:null})}}
    const {rt,state}=await fixture(overrides,{overrides:{manageClient:true}})
    await rt.init();assert.equal(state.clients.length,0);assert.equal(rt.runtime.ring.some(x=>x.level==='warn'),false);await rt.dispose()
  }
})

test('stored credentials and available binary are sufficient to try automatic management',async()=>{
  const {rt,state}=await fixture({}, {overrides:{manageClient:true}})
  await rt.init();assert.equal(state.clients.length,1);await rt.dispose()
})

test('successful authentication queues automatic connection only when management is enabled',async()=>{
  for(const manageClient of [false,true]){
    let complete
    const {rt,state}=await fixture({'./auth.js':{startAuth:opts=>{complete=opts.onComplete;return {id:'auth-1'}}}},{overrides:{manageClient}})
    await rt.beginAuth();await complete();assert.equal(state.clients.length,manageClient?1:0);await rt.dispose()
  }
})

test('authentication is valid only for an attested live process with unchanged config',async()=>{
  let attested=false,revision='one',alive=true
  const {rt}=await fixture({'./credentials.js':{readCredentialStatus:()=>({state:'unknown',serverCount:1,revision,expiresAt:null})},'./iwan-client.js':{ensureIwanClient:async()=>({managed:true,isAlive:()=>alive,isAuthenticated:()=>attested,authenticatedAt:123,stop(){alive=false}})}})
  await rt.connect();assert.equal(rt.status().auth.credentials.state,'unknown')
  attested=true;assert.equal(rt.status().auth.credentials.state,'valid');assert.equal(rt.status().auth.credentials.verifiedAt,123)
  revision='two';assert.equal(rt.status().auth.credentials.state,'unknown')
  revision='one';alive=false;assert.equal(rt.status().auth.credentials.state,'unknown');await rt.dispose()
})

test('external listener and completed auth process do not attest credentials',async()=>{
  const {rt}=await fixture({'./auth.js':{authState:()=>({state:'done'})},'./iwan-client.js':{ensureIwanClient:async()=>({managed:false,isAuthenticated:()=>true,stop(){}})}})
  await rt.connect();assert.equal(rt.status().auth.credentials.state,'unknown');await rt.dispose()
})

test('already downloaded client and in-progress check do not interrupt a live client',async()=>{
  for(const checking of [false,true]){
    let stopped=0
    const {rt}=await fixture({'./binary.js':{binaryState:()=>({installed:true,downloaded:true,checking})},'./iwan-client.js':{ensureIwanClient:async()=>({managed:true,isAlive:()=>true,stop(){stopped++}})}})
    await rt.connect();assert.equal(rt.installClient({mode:checking?'reinstall':'download'}).started,false);assert.equal(stopped,0);await rt.dispose()
  }
})

test('queued enable-management cannot start an old process during installation',async()=>{
  let downloadingManaged
  const {rt,state}=await fixture({'./binary.js':{startDownload:async()=>{downloadingManaged=rt.runtime.iwan!==null;return {started:true}}}})
  const settings=rt.applySettings({manageClient:true});rt.installClient({mode:'reinstall'})
  await settings;await rt.waitForClientMaintenance();assert.equal(downloadingManaged,false);assert.equal(state.clients.length,1);await rt.dispose()
})

test('installation waits for actual exit before replacing a running client and then restores it',async()=>{
  const exit=deferred();let exited=false,calls=0,downloads=0
  const {rt}=await fixture({'./binary.js':{startDownload:async()=>{downloads++;assert.equal(exited,true);return {started:true}}},'./iwan-client.js':{ensureIwanClient:async()=>{calls++;return calls===1?{managed:true,isAlive:()=>true,hasExited:()=>exited,stop:()=>exit.promise.then(()=>{exited=true})}:{managed:true,isAlive:()=>true,stop(){}}}}})
  await rt.connect();rt.installClient({mode:'reinstall'});await tick();assert.equal(downloads,0)
  exit.resolve();await rt.waitForClientMaintenance();assert.equal(downloads,1);assert.equal(calls,2);await rt.dispose()
})

test('installation waits for pending spawned process cleanup after abort',async()=>{
  const exit=deferred();let exited=false,calls=0,downloads=0
  const {rt}=await fixture({'./binary.js':{startDownload:async()=>{downloads++;assert.equal(exited,true);return {started:true}}},'./iwan-client.js':{ensureIwanClient:opts=>{calls++;if(calls>1)return Promise.resolve({managed:true,isAlive:()=>true,stop(){}});opts.onSpawned({isAlive:()=>false,hasExited:()=>exited,stop:()=>exit.promise.then(()=>{exited=true})});return new Promise((_,reject)=>opts.signal.addEventListener('abort',()=>reject(opts.signal.reason),{once:true}))}}})
  const connecting=rt.connect();const rejected=assert.rejects(connecting);await tick()
  rt.installClient({mode:'reinstall'});await tick();assert.equal(downloads,0);exit.resolve()
  await rejected;await rt.waitForClientMaintenance();assert.equal(downloads,1);await rt.dispose()
})

test('natural startup failure retains unconfirmed process and blocks installation until real exit',async()=>{
  let exited=false,downloads=0
  const {rt}=await fixture({'./binary.js':{startDownload:async()=>{downloads++;return {started:true}}},'./iwan-client.js':{ensureIwanClient:async opts=>{opts.onSpawned({isAlive:()=>false,hasExited:()=>exited,stop:async()=>{}});throw new Error('startup failed')}}})
  await assert.rejects(rt.connect(),/startup failed/);assert.equal(rt.status().iwan.stopping,true)
  assert.equal(rt.installClient({mode:'reinstall'}).started,false);assert.equal(downloads,0)
  exited=true;rt.installClient({mode:'reinstall'});await rt.waitForClientMaintenance();assert.equal(downloads,1);await rt.dispose()
})

test('user stop during maintenance prevents automatic restart',async()=>{
  const download=deferred();const {rt,state}=await fixture({'./binary.js':{waitForDownload:()=>download.promise}},{overrides:{manageClient:true}})
  await rt.init();rt.installClient({mode:'reinstall'});await tick();await rt.disconnect()
  download.resolve();await rt.waitForClientMaintenance();assert.equal(state.clients.length,1);assert.equal(rt.status().iwan.paused,true);await rt.dispose()
})

test('dispose cancels maintenance and does not resume the client',async()=>{
  const download=deferred();let cancelled=0
  const {rt,state}=await fixture({'./binary.js':{waitForDownload:()=>download.promise,cancelDownload:()=>{cancelled++;download.resolve()}}},{overrides:{manageClient:true}})
  await rt.init();rt.installClient({mode:'reinstall'});await tick();await rt.dispose()
  assert.equal(cancelled,1);assert.equal(state.clients.length,1);assert.equal(rt.status().maintenance.running,false)
})

test('cancelling during restore stops the new pending connection and keeps management paused',async()=>{
  let calls=0
  const {rt}=await fixture({'./iwan-client.js':{ensureIwanClient:opts=>{calls++;if(calls===1)return Promise.resolve({managed:true,isAlive:()=>true,stop(){}});return new Promise((_,reject)=>opts.signal.addEventListener('abort',()=>reject(opts.signal.reason),{once:true}))}}},{overrides:{manageClient:true}})
  await rt.init();rt.installClient({mode:'reinstall'});await tick()
  assert.equal(rt.status().maintenance.phase,'restoring');await rt.cancelClientInstall();await rt.waitForClientMaintenance()
  assert.equal(rt.status().maintenance.phase,'cancelled');assert.equal(rt.status().iwan.paused,true);assert.equal(rt.status().iwan.managed,false);await rt.dispose()
})
