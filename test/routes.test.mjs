import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { createRouteHandler, registerRoutes } from '../lib/routes.js'

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
  let mount,disposed=0;const pluginEvents={},scopeEvents={}
  const ctx={on:(event,fn)=>{pluginEvents[event]=fn},inject:(_,fn)=>{mount=fn}}
  const unmount=registerRoutes(ctx,async()=>new Response('ok'))
  const scope={on:(event,fn)=>{scopeEvents[event]=fn},webServer:{register:()=>()=>{disposed++}}}
  mount(scope);scopeEvents.dispose();unmount();pluginEvents.dispose();assert.equal(disposed,1)
  mount(scope);assert.equal(disposed,1)
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
