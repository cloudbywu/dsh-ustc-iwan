import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './helpers/runtime-fixture.mjs'

async function nativeFixture(){
  let time=1000,native=null,starts=0,stops=0,passedNow
  const f=await fixture({'./iwan-client.js':{ensureIwanClient:async opts=>{passedNow=opts.now;const generation=++starts;return {managed:true,isAlive:()=>true,isAuthenticated:()=>generation>1||!native,reconnectState:()=>generation===1?native:null,stop(){stops++}}}}},{overrides:{manageClient:true},monitoring:{now:()=>time}})
  await f.rt.connect()
  return {...f,setTime:value=>{time=value},setNative:value=>{native=value},starts:()=>starts,stops:()=>stops,passedNow:()=>passedNow}
}

test('native progress suppresses forced restart and invalidates old authentication proof',async()=>{
  const f=await nativeFixture();assert.equal(f.rt.status().auth.credentials.state,'valid')
  f.setNative({since:1000,lastAttemptAt:1000,attempt:1,maxAttempts:5});assert.equal(f.state.monitor.inspect().mode,'native-reconnecting')
  assert.equal(f.rt.status().auth.credentials.state,'unknown');assert.equal(await f.state.monitor.recover({}),false);assert.equal(f.stops(),0)
  f.setNative(null);assert.equal(f.state.monitor.inspect().mode,'managed');assert.equal(f.rt.status().auth.credentials.state,'valid');await f.rt.dispose()
})

test('native grace has both a per-attempt and total upper bound',async()=>{
  const f=await nativeFixture();f.setNative({since:1000,lastAttemptAt:1000,attempt:1,maxAttempts:5})
  f.setTime(30999);assert.equal(f.state.monitor.inspect().mode,'native-reconnecting')
  f.setTime(31000);assert.equal(f.state.monitor.inspect().mode,'managed');assert.equal(f.state.monitor.inspect().nativeReconnectExpired,true)
  f.setNative({since:1000,lastAttemptAt:90000,attempt:5,maxAttempts:5});f.setTime(90999);assert.equal(f.state.monitor.inspect().mode,'native-reconnecting')
  f.setTime(91000);assert.equal(f.state.monitor.inspect().mode,'managed');assert.equal(f.state.monitor.inspect().nativeReconnectExpired,true);await f.rt.dispose()
})

test('explicit user reconnect and stop still override native recovery wait',async()=>{
  const f=await nativeFixture();f.setNative({since:1000,lastAttemptAt:1000,attempt:1,maxAttempts:5})
  await f.rt.reconnect();assert.equal(f.starts(),2);assert.equal(f.stops(),1);assert.equal(f.state.monitor.inspect().mode,'managed')
  await f.rt.disconnect();assert.equal(f.state.monitor.inspect().mode,'paused');assert.equal(f.rt.status().iwan.nativeReconnect,null);await f.rt.dispose()
})

test('native timestamps use the same injectable clock as the monitor',async()=>{
  const f=await nativeFixture();f.setTime(12345);assert.equal(f.passedNow()(),12345);await f.rt.dispose()
})
