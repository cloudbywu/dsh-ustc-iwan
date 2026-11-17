import test from 'node:test'
import assert from 'node:assert/strict'
import { createReconnectMonitor } from '../lib/reconnect-monitor.js'
import { fixture, deferred } from './helpers/runtime-fixture.mjs'
const flush=()=>new Promise(setImmediate)

function clock(){
  let time=0,sequence=0;const timers=new Map()
  return {timers,now:()=>time,setTimer:(fn,delay)=>{const id=++sequence;timers.set(id,{fn,at:time+delay});return id},clearTimer:id=>timers.delete(id),jump:ms=>{time+=ms},
    async advance(ms){const end=time+ms;for(;;){const next=[...timers].filter(([,task])=>task.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;time=Math.max(time,next[1].at);timers.delete(next[0]);next[1].fn();await flush()}time=end;await flush()},
  }
}
async function setup(extra={}){
  const time=clock();let monitor,starts=0,stops=0,latest
  const modules={
    './reconnect-monitor.js':{createReconnectMonitor:options=>(monitor=createReconnectMonitor(options))},
    './iwan-client.js':{isPortOpen:async()=>true,ensureIwanClient:async()=>{starts++;let alive=true,exited=false;latest={managed:true,isAlive:()=>alive,hasExited:()=>exited,isAuthenticated:()=>alive,stop(){stops++;alive=false;exited=true}};return latest}},
  }
  for(const [key,value] of Object.entries(extra))modules[key]={...modules[key],...value}
  const f=await fixture(modules,{overrides:{manageClient:true},monitoring:{now:time.now,setTimer:time.setTimer,clearTimer:time.clearTimer,timings:{intervalMs:10,wakeThresholdMs:30,wakeGraceMs:5,retryDelaysMs:[10,20],maxAttempts:3}}})
  return {...f,time,get monitor(){return monitor},starts:()=>starts,stops:()=>stops,latest:()=>latest}
}

test('real monitor and runtime rebuild a stale owned session after wake even if old port remains open',async()=>{
  const f=await setup();await f.rt.init();assert.equal(f.starts(),1);assert.equal(f.rt.status().auth.credentials.state,'valid')
  await f.time.advance(10);assert.equal(f.monitor.status().state,'healthy')
  f.time.jump(100);await f.time.advance(0);assert.equal(f.monitor.status().state,'waiting');assert.equal(f.rt.status().auth.credentials.state,'unknown');assert.equal(f.starts(),1)
  await f.time.advance(5);assert.equal(f.starts(),2);assert.equal(f.stops(),1);assert.equal(f.monitor.status().state,'healthy');assert.equal(f.rt.status().auth.credentials.state,'valid')
  await f.rt.dispose();assert.equal(f.time.timers.size,0)
})

test('real wake heartbeat never reverses an explicit manual pause',async()=>{
  const f=await setup();await f.rt.init();await f.rt.disconnect();f.time.jump(100);await f.time.advance(20)
  assert.equal(f.starts(),1);assert.equal(f.monitor.status().state,'paused');assert.equal(f.rt.status().iwan.paused,true);await f.rt.dispose();assert.equal(f.time.timers.size,0)
})

test('real monitor discards old port probe after settings create a fresh connection',async()=>{
  const oldProbe=deferred();let calls=0
  const f=await setup({'./iwan-client.js':{isPortOpen:()=>++calls===1?oldProbe.promise:Promise.resolve(true)}});await f.rt.init()
  await f.time.advance(10);await f.rt.applySettings({iwanSocksPort:2090});assert.equal(f.starts(),2)
  oldProbe.resolve(false);await flush();assert.equal(f.starts(),2);assert.equal(f.monitor.status().attempts,0)
  await f.time.advance(10);assert.equal(f.monitor.status().state,'healthy');assert.equal(f.starts(),2);await f.rt.dispose()
})

test('runtime disposal waits for an ignored-abort probe and never reconnects late',async()=>{
  const probe=deferred();const f=await setup({'./iwan-client.js':{isPortOpen:()=>probe.promise}});await f.rt.init();await f.time.advance(10)
  let disposed=false;const disposing=f.rt.dispose().then(()=>{disposed=true});await flush();assert.equal(disposed,false)
  probe.resolve(false);await disposing;assert.equal(f.starts(),1);assert.equal(f.time.timers.size,0);assert.equal(f.monitor.status().state,'idle')
})

test('failed spawned recovery is counted only after its terminating child has really exited',async()=>{
  const exited=deferred();let starts=0,dead=false
  const f=await setup({'./iwan-client.js':{isPortOpen:async()=>false,ensureIwanClient:async opts=>{starts++;if(starts===1)return {managed:true,isAlive:()=>true,stop(){}};opts.onSpawned({isAlive:()=>false,hasExited:()=>dead,stop:()=>exited.promise.then(()=>{dead=true})});throw new Error('synthetic startup error')}}})
  await f.rt.init();await f.time.advance(10);await f.time.advance(10);assert.equal(starts,2);assert.equal(f.monitor.status().state,'recovering')
  exited.resolve();await flush();assert.equal(f.monitor.status().attempts,1);assert.equal(f.monitor.status().state,'waiting');assert.ok(f.monitor.status().nextRetryAt>f.time.now());await f.rt.dispose()
})
