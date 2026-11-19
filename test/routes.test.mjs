import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { createRouteHandler, registerRoutes } from '../lib/routes.js'
import dns from 'node:dns'
import { createResolver } from '../lib/resolver.js'
import { defaults, fixture } from './helpers/runtime-fixture.mjs'

const request=(path,body,method='POST')=>new Request('http://localhost/ustc-iwan/api'+path,{method,...(method==='POST'?{body:typeof body==='string'?body:JSON.stringify(body??{})}:{})})
function runtime() {
  return {runtime:{disposed:false},status:()=>({settings:{},iwan:{}}),applySettings:async()=>{},connect:async()=>({managed:true}),disconnect:async()=>true,installClient:async({mode})=>({started:true,mode}),inspectUpdates:async()=>({started:true,latestVersion:'v2.0'}),cancelClientInstall:async()=>({cancelled:true}),beginAuth:async()=>({id:'auth-1',authorizeUrl:'https://id.example.test/authorize'}),completeAuth:()=>({id:'auth-1'}),abandonAuth:()=>({cancelled:true})}
}

test('disconnect waits for asynchronous cleanup and returns a boolean',async()=>{
  const rt=runtime();let finish;rt.disconnect=()=>new Promise(r=>{finish=r})
  const handling=createRouteHandler(rt)(request('/disconnect'))
  await new Promise(setImmediate);finish(true)
  assert.deepEqual(await (await handling).json(),{ok:true,value:{disconnected:true}})
})

test('JSON endpoints reject null, arrays, malformed JSON and oversized bodies',async()=>{
  const handle=createRouteHandler(runtime())
  for(const path of ['/settings','/auth/complete','/auth/cancel','/test']) {
    for(const body of ['null','[]','{broken'])assert.equal((await handle(request(path,body))).status,400)
    assert.equal((await handle(request(path,JSON.stringify({host:'中'.repeat(100000)})))).status,413)
  }
})

test('settings route returns 400 on invalid DNS or CIDR without writing',async()=>{
  const {rt,state}=await fixture()
  const handle=createRouteHandler(rt)
  for(const [key,value] of [['dnsServer','[::1]:0'],['cidrs','10.0.0.0/33']]) {
    const response=await handle(request('/settings',{[key]:value,verbose:true}))
    assert.equal(response.status,400)
    assert.match((await response.json()).error,new RegExp(key))
  }
  assert.equal(state.writes.length,0)
  await rt.dispose()
})

test('route diagnostics reuse the routing DNS cache and return fake IPs without proxy secrets',async t=>{
  const resolve=t.mock.method(dns.promises,'resolve4',async()=>['198.18.0.2'])
  const {rt}=await fixture({
    './resolver.js':{createResolver},
    './settings-store.js':{readSettings:()=>({...defaults,dnsServer:'old.invalid:0'})},
  },{detectedUpstreamProxy:'https://secret-user:secret-password@proxy.example.test:8443/private?token=secret'})
  t.after(()=>rt.dispose())
  rt.refreshDerived() // 同一份已保存的坏 DNS 配置在启动与诊断均回退系统 DNS。
  assert.equal((await rt.decide('llm.ustc.edu.cn')).kind,'iwan')
  assert.equal(resolve.mock.callCount(),0,'live suffix routing does not query DNS')
  const handle=createRouteHandler(rt)
  assert.deepEqual((await (await handle(request('/test'))).json()).value,{
    host:'llm.ustc.edu.cn',decision:{kind:'iwan'},resolvedIps:['198.18.0.2'],fake:true,
  })
  assert.equal(resolve.mock.callCount(),1)
  await rt.decide('external.test')
  const result=(await (await handle(request('/test',{host:'external.test'}))).json()).value
  assert.deepEqual(result,{
    host:'external.test',decision:{kind:'upstream',url:'https://proxy.example.test:8443'},resolvedIps:['198.18.0.2'],fake:true,
  })
  assert.equal(resolve.mock.callCount(),2,'diagnostics reuse data cached by live routing')
  const again=(await (await handle(request('/test',{host:'198.18.0.3'}))).json()).value
  assert.equal(again.fake,true)
  assert.equal(resolve.mock.callCount(),2,'IPv4 literals require no DNS')
  const ordinary=(await (await handle(request('/test',{host:'8.8.8.8'}))).json()).value
  assert.equal(ordinary.fake,false)
  assert.equal(resolve.mock.callCount(),2)
})

test('route prefix does not match sibling paths and stopped runtime rejects work',async()=>{
  const rt=runtime();const handle=createRouteHandler(rt)
  assert.equal((await handle(new Request('http://localhost/ustc-iwan/apix/status'))).status,404)
  rt.runtime.disposed=true;assert.equal((await handle(request('/download'))).status,503)
})

test('cancel errors are returned as errors, not success payloads',async()=>{
  const rt=runtime();rt.abandonAuth=()=>({error:'unknown session'})
  const response=await createRouteHandler(rt)(request('/auth/cancel',{id:'missing'}))
  assert.equal(response.status,400);assert.equal((await response.json()).ok,false)
})

test('route registration cleans up on scope and plugin disposal exactly once',()=>{
  let mount,registered=0,disposed=0
  const ctx={inject:(_,fn)=>{mount=fn}}
  const unmount=registerRoutes(ctx,async()=>new Response('ok'))
  const scope={webServer:{register:()=>{registered++;return ()=>{disposed++}}}}
  const unmountFirst=mount(scope);unmountFirst();assert.equal(disposed,1)
  const unmountSecond=mount(scope);unmount();unmountSecond();unmount()
  assert.equal(disposed,2)
  mount(scope);assert.equal(registered,2)
})

test('Node adapter accepts JSON POST bodies over a real loopback HTTP server',async t=>{
  let registered
  const ctx={on(){},inject:(_,fn)=>fn({webServer:{register:entry=>{registered=entry;return ()=>{}}}})}
  const unmount=registerRoutes(ctx,createRouteHandler(runtime()));t.after(unmount)
  const server=http.createServer(registered.handler);server.listen(0,'127.0.0.1');await once(server,'listening')
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve))})
  const port=server.address().port
  const response=await fetch('http://127.0.0.1:'+port+'/ustc-iwan/api/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({listenPort:19001})})
  assert.equal(response.status,200);assert.equal((await response.json()).ok,true)
})

test('client management endpoints distinguish update, reinstall, inspect and cancel',async()=>{
  const rt=runtime(),modes=[];rt.installClient=async({mode})=>{modes.push(mode);return {started:true}}
  const handle=createRouteHandler(rt)
  for(const mode of ['download','update','reinstall'])assert.equal((await handle(request('/download',{mode}))).status,200)
  assert.deepEqual(modes,['download','update','reinstall'])
  assert.equal((await handle(request('/download',{mode:'unknown'}))).status,400)
  assert.equal((await handle(request('/download','null'))).status,400)
  assert.equal((await (await handle(request('/update/check'))).json()).value.latestVersion,'v2.0')
  assert.equal((await (await handle(request('/download/cancel'))).json()).value.cancelled,true)
})

test('explicit reconnect endpoint awaits fresh managed connection',async()=>{
  const rt=runtime();let calls=0
  rt.reconnect=async()=>{calls++;return {managed:true}}
  const response=await createRouteHandler(rt)(request('/reconnect'))
  assert.equal(response.status,200);assert.equal((await response.json()).value.managed,true);assert.equal(calls,1)
})

test('status returns latest lifecycle snapshot after the async port probe',async()=>{
  const rt=runtime();let calls=0;const status=rt.status
  rt.status=()=>{const value=status();value.settings={iwanSocksPort:1,iwanSocksHost:'127.0.0.1'};value.iwan.managed=++calls>1;return value}
  const response=await createRouteHandler(rt)(request('/status',undefined,'GET'))
  assert.equal((await response.json()).value.iwan.managed,true);assert.equal(calls,2)
})

test('status reports stopped runtime if disposal occurred during port probing',async()=>{
  const rt=runtime();rt.runtime={disposed:false};const status=rt.status
  rt.status=()=>{queueMicrotask(()=>{rt.runtime.disposed=true});const value=status();value.settings={iwanSocksPort:1,iwanSocksHost:'127.0.0.1'};return value}
  assert.equal((await createRouteHandler(rt)(request('/status',undefined,'GET'))).status,503)
})
