import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, deferred, defaults } from './helpers/runtime-fixture.mjs'

test('verbose changes rebuild the proxy and the new proxy uses the configured SOCKS endpoint',async()=>{
  const {rt,state}=await fixture(); await rt.init()
  await rt.applySettings({iwanSocksPort:2080,iwanSocksHost:'localhost',verbose:true})
  assert.equal(state.starts.length,2)
  assert.equal(state.starts[1].iwan().proxyPort,2080)
  assert.equal(state.starts[1].verbose,true)
  assert.equal(state.closes,1);assert.equal(state.restores,1)
  await rt.dispose()
})

test('dispose during proxy startup closes late resources without installing policy',async()=>{
  const start=deferred(); let closed=0
  const {rt,state}=await fixture({'./split-proxy.js':{startSplitProxy:()=>start.promise}})
  const initializing=rt.init(); await new Promise(setImmediate)
  const disposing=rt.dispose();start.resolve({close(){closed++}})
  await Promise.all([initializing,disposing])
  assert.equal(rt.runtime.proxy,null);assert.equal(state.installs,0);assert.equal(closed,1)
})

test('dispose during policy installation restores late policy exactly once',async()=>{
  const policy=deferred();let restored=0
  const {rt,state}=await fixture({'./policy.js':{installSplitPolicy:()=>policy.promise}})
  const initializing=rt.init();await new Promise(setImmediate)
  const disposing=rt.dispose()
  assert.equal(state.closes,1,'dispose closes the listener before pending policy installation completes')
  policy.resolve(()=>{restored++})
  await Promise.all([initializing,disposing]);await rt.dispose()
  assert.equal(restored,1);assert.equal(state.closes,1);assert.equal(rt.runtime.policyDisposer,null)
})

test('dispose closes active tunnels without waiting for proxy policy restoration',async()=>{
  const restore=deferred()
  let restored=false,finished=false
  const {rt,state}=await fixture({'./policy.js':{installSplitPolicy:async()=>async()=>{await restore.promise;restored=true}}})
  await rt.init()
  const dispose=rt.dispose().then(()=>{finished=true})
  try {
    await new Promise(setImmediate)
    assert.equal(state.closes,1)
    assert.equal(restored,false)
    assert.equal(finished,false)
  } finally {
    restore.resolve()
    await dispose
  }
  assert.equal(restored,true)
})

test('concurrent init and setting changes are serialized',async()=>{
  const {rt,state}=await fixture()
  await Promise.all([rt.init(),rt.applySettings({listenPort:19001}),rt.applySettings({listenPort:19002})])
  assert.equal(state.starts.length,3);assert.equal(state.starts[2].port,19002)
  assert.equal(state.closes,2);await rt.dispose()
})

test('normal routing is quiet when verbose is disabled',async()=>{
  const {rt}=await fixture()
  assert.equal((await rt.decide('llm.ustc.edu.cn')).kind,'iwan')
  assert.equal((await rt.decide('campus.test')).kind,'iwan')
  assert.equal((await rt.decide('example.test')).kind,'direct')
  assert.equal(rt.runtime.ring.length,0);await rt.dispose()
})

test('concurrent connect calls share one managed process',async()=>{
  const {rt,state}=await fixture()
  const [first,second]=await Promise.all([rt.connect(),rt.connect()])
  assert.equal(first,second);assert.equal(state.clients.length,1);assert.equal(rt.status().iwan.managed,true)
  await rt.dispose()
})

test('disconnect aborts startup and waits for the pending connection',async()=>{
  let signal
  const {rt}=await fixture({'./iwan-client.js':{ensureIwanClient:opts=>{signal=opts.signal;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))}}})
  const connecting=rt.connect();const rejected=assert.rejects(connecting)
  await new Promise(setImmediate);assert.equal(await rt.disconnect(),true);await rejected
  assert.equal(signal.aborted,true);assert.equal(rt.status().iwan.managed,false);await rt.dispose()
})

test('dispose stops a late client even if a dependency ignores cancellation',async()=>{
  const pending=deferred();let stopped=0
  const {rt}=await fixture({'./iwan-client.js':{ensureIwanClient:()=>pending.promise}})
  const connecting=rt.connect();const rejected=assert.rejects(connecting,/取消/)
  await new Promise(setImmediate);const disposing=rt.dispose()
  pending.resolve({managed:true,stop(){stopped++}})
  await Promise.all([disposing,rejected]);assert.equal(stopped,1);assert.equal(rt.runtime.iwan,null)
})

test('client exit clears the managed status',async()=>{
  let alive=true,onExit
  const {rt}=await fixture({'./iwan-client.js':{ensureIwanClient:async()=>({managed:true,isAlive:()=>alive,onExit:fn=>{onExit=fn;return ()=>{}},stop(){alive=false}})}})
  await rt.connect();alive=false;onExit({code:1})
  assert.equal(rt.status().iwan.managed,false);await rt.dispose()
})

test('changing client settings restarts managed client and disabling stops it',async()=>{
  let stopped=0
  const {rt,state}=await fixture({'./iwan-client.js':{ensureIwanClient:async opts=>{state.clients.push(opts);return {managed:true,isAlive:()=>true,stop(){stopped++}}}}})
  await rt.init();await rt.applySettings({manageClient:true})
  await rt.applySettings({iwanSocksPort:2080});assert.equal(stopped,1);assert.equal(state.clients[1].socksPort,2080)
  await rt.applySettings({enabled:false});assert.equal(stopped,2);assert.equal(rt.status().iwan.managed,false)
  await rt.dispose()
})

test('an unchanged false manage flag does not stop a manually started managed client',async()=>{
  let stopped=0
  const {rt}=await fixture({'./iwan-client.js':{ensureIwanClient:async()=>({managed:true,isAlive:()=>true,stop(){stopped++}})}})
  await rt.connect();await rt.applySettings({manageClient:false,upstreamProxy:'http://localhost:7890'})
  assert.equal(stopped,0);await rt.dispose();assert.equal(stopped,1)
})

test('persist failure leaves previous settings effective',async()=>{
  const {rt}=await fixture({'./settings-store.js':{writeSettings:()=>{throw new Error('disk failure')}}})
  await assert.rejects(rt.applySettings({listenPort:19001}),/disk failure/)
  assert.equal(rt.status().settings.listenPort,18118);await rt.dispose()
})

test('disposed runtime rejects new work and cancels background operations once',async()=>{
  const {rt,state}=await fixture();await rt.dispose();await rt.dispose()
  await assert.rejects(rt.connect(),/已停止/);await assert.rejects(rt.applySettings({enabled:true}),/已停止/)
  assert.throws(()=>rt.beginAuth(),/已停止/);await rt.init()
  assert.equal(state.starts.length,0);assert.equal(state.authCancelled,1);assert.equal(state.downloadCancelled,1)
})

test('external SOCKS can be used without a local executable',async()=>{
  const {rt,state}=await fixture({'./binary.js':{resolveBinary:()=>({error:'not found'})},'./iwan-client.js':{ensureIwanClient:async opts=>{state.clients.push(opts);return {managed:false,stop(){}}}}})
  const handle=await rt.connect();assert.equal(handle.managed,false);assert.equal(state.clients[0].exePath,undefined)
  await rt.dispose()
})


test('environment overrides remain effective but never replace saved settings on a full-form update',async()=>{
  const upstreamProxy='https://env-user:env-password@proxy.example.test:8443/private?token=secret'
  const mockStore={readSettings:()=>({...defaults,iwanSocksPort:2090,dnsServer:'8.8.8.8',upstreamProxy:'http://saved.test'})}
  const {rt,state}=await fixture({'./settings-store.js':mockStore}, {overrides:{iwanSocksPort:2080,dnsServer:'1.1.1.1',upstreamProxy}})
  const initial=rt.status()
  assert.deepEqual([...initial.environmentOverrides],['iwanSocksPort','dnsServer','upstreamProxy'])
  assert.equal(initial.settings.upstreamProxy,'https://proxy.example.test:8443')
  assert.equal((await rt.decide('external.test')).url,upstreamProxy)
  await rt.applySettings({...initial.settings,verbose:true})
  assert.equal(rt.status().settings.iwanSocksPort,2080)
  assert.equal(rt.status().settings.dnsServer,'1.1.1.1')
  assert.equal(state.writes[0].iwanSocksPort,2090)
  assert.equal(state.writes[0].dnsServer,'8.8.8.8')
  assert.equal(state.writes[0].upstreamProxy,'http://saved.test')
  assert.equal(state.writes[0].verbose,true)
  assert.doesNotMatch(JSON.stringify(rt.status()),/env-user|env-password|token=secret/)
  await rt.dispose()
})

test('direct settings updates reject invalid DNS and CIDRs before writing or changing runtime state',async()=>{
  const {rt,state}=await fixture({}, {overrides:{dnsServer:'1.1.1.1'}})
  for(const [key,value] of [['dnsServer','1.1.1.1:0'],['cidrs','202.38.64.0/19,10.0.0.1/33']]) {
    await assert.rejects(rt.applySettings({enabled:false,[key]:value}), {status:400,message:new RegExp(key)})
  }
  assert.equal(state.writes.length,0)
  assert.equal(rt.status().settings.enabled,true)
  assert.equal(rt.status().settings.dnsServer,'1.1.1.1')
  assert.equal(rt.status().settings.cidrs,defaults.cidrs)
  await rt.dispose()
})

test('automatic upstream is used on blank but is never written or exposed with credentials',async()=>{
  const auto='https://auto-user:auto-password@proxy.example.test:8443/private?token=secret'
  const {rt,state}=await fixture({}, {detectedUpstreamProxy:auto})
  assert.equal(rt.status().autoUpstreamProxy,'https://proxy.example.test:8443')
  assert.equal(rt.status().settings.upstreamProxy,'')
  assert.deepEqual([...rt.status().environmentOverrides],[])
  assert.equal((await rt.decide('external.test')).url,auto)
  await rt.applySettings({...rt.status().settings,verbose:true})
  assert.equal(state.writes[0].upstreamProxy,'')
  assert.equal((await rt.decide('external.test')).url,auto)
  await rt.applySettings({upstreamProxy:'http://manual.test:8080'})
  assert.equal((await rt.decide('external.test')).url,'http://manual.test:8080')
  await rt.applySettings({upstreamProxy:''})
  assert.equal((await rt.decide('external.test')).url,auto)
  assert.equal(state.writes.at(-1).upstreamProxy,'')
  assert.doesNotMatch(JSON.stringify(rt.status()),/auto-user|auto-password|token=secret/)
  await rt.dispose()
})

test('logging failures do not interrupt lifecycle cleanup',async()=>{
  const {rt,state}=await fixture({}, {log:()=>{throw new Error('logger unavailable')}})
  await rt.init();await rt.dispose();assert.equal(state.closes,1);assert.equal(state.restores,1)
})


test('a stop failure is reported without poisoning later reconnects',async()=>{
  let starts=0
  const {rt}=await fixture({'./iwan-client.js':{ensureIwanClient:async()=>{starts++;return {managed:true,isAlive:()=>true,stop:()=>starts===1?Promise.reject(new Error('stop rejected')):Promise.resolve()}}}})
  await rt.connect();await assert.rejects(rt.disconnect(),/stop rejected/)
  await rt.connect();assert.equal(starts,2);await rt.dispose()
})

test('dispose waits for every cleanup even when one fails',async()=>{
  const download=deferred(),auth=deferred();let authWaited=false
  const {rt}=await fixture({'./binary.js':{cancelDownload:()=>download.promise},'./auth.js':{waitForAuthCleanup:()=>{authWaited=true;return auth.promise}},'./iwan-client.js':{ensureIwanClient:async()=>({managed:true,isAlive:()=>true,stop:()=>Promise.reject(new Error('stop rejected'))})}})
  await rt.connect();let settled=false
  const rejected=assert.rejects(rt.dispose(),/清理失败/).then(()=>{settled=true})
  await new Promise(setImmediate);assert.equal(authWaited,true);assert.equal(settled,false)
  download.resolve();auth.resolve();await rejected
})
