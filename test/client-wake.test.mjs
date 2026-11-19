import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, initial, tick, deferred } from './helpers/client-fixture.mjs'

// Wake, cancellation, recovery, and reconnect regressions use only the VM fetch mock.
const statusRequests = ui => ui.requests.filter(({url}) => url.endsWith('/status'))
const pathInput = ui => ui.input('留空则使用已下载的副本')
const changePath = (ui,value) => { pathInput(ui).props.onChange({target:{value}});ui.render() }

test('focus, hidden-to-visible, and online immediately fetch real status without authentication',async()=>{
  const ui=fixture();await ui.mount()
  assert.equal(statusRequests(ui).length,1)
  for(const event of ['focus','online']) {
    const before=ui.requests.length
    ui.setServer({...ui.server(),log:[{at:1,msg:event+' refreshed'}]})
    ui.emit(event)
    assert.equal(ui.requests.length,before+1)
    await tick();ui.render();assert.match(ui.text(),new RegExp(event+' refreshed'))
  }
  const before=ui.requests.length
  ui.visibility('hidden');assert.equal(ui.requests.length,before)
  ui.visibility('visible');assert.equal(ui.requests.length,before+1)
  ui.visibility('visible');assert.equal(ui.requests.length,before+1)
  await tick();ui.render()
  assert.ok(ui.requests.every(({url,init})=>url.endsWith('/status')&&!init.method))
})

test('responses from before sleep and earlier wake events cannot overwrite the latest status or drafts',async()=>{
  const ui=fixture();await ui.mount();const old=deferred(),focus=deferred(),online=deferred()
  const queue=[old,focus,online]
  ui.override(url=>url.endsWith('/status')?queue.shift().promise:null)
  ui.poll();ui.visibility('hidden');ui.emit('focus');ui.emit('online')
  changePath(ui,'C:/unsaved.exe')
  const next={...initial(),settings:{...initial().settings,iwanClientPath:'C:/server.exe'},log:[{at:1,msg:'latest awake status'}]}
  online.resolve(ui.response(next));await tick();ui.render()
  focus.resolve(ui.response({...initial(),log:[{at:1,msg:'stale focus'}]}))
  old.resolve(ui.response({...initial(),log:[{at:1,msg:'stale sleeping poll'}]}))
  await tick();ui.render()
  assert.match(ui.text(),/latest awake status/);assert.doesNotMatch(ui.text(),/stale focus|stale sleeping poll/)
  assert.equal(pathInput(ui).props.value,'C:/unsaved.exe')
  assert.match(ui.text(),/有未保存的修改/)
  assert.ok(statusRequests(ui).slice(1,3).every(({init})=>init.signal.aborted))
})

for(const finishBeforeSave of [true,false])test('wake refresh during save never replaces its result (early='+finishBeforeSave+')',async()=>{
  const ui=fixture();await ui.mount();const saving=deferred(),waking=deferred()
  ui.override(url=>url.endsWith('/settings')?saving.promise:url.endsWith('/status')?waking.promise:null)
  changePath(ui,'C:/submitted.exe')
  const done=ui.button('保存配置').props.onClick();ui.render();ui.emit('focus')
  const old={...initial(),settings:{...initial().settings,iwanClientPath:'C:/stale.exe'},log:[{at:1,msg:'stale wake result'}]}
  if(finishBeforeSave){waking.resolve(ui.response(old));await tick();ui.render()}
  const saved={...initial(),settings:{...initial().settings,iwanClientPath:'C:/submitted.exe'},log:[{at:1,msg:'saved result'}]}
  saving.resolve(ui.response(saved));await done;ui.render()
  if(!finishBeforeSave){waking.resolve(ui.response(old));await tick();ui.render()}
  assert.equal(pathInput(ui).props.value,'C:/submitted.exe')
  assert.match(ui.text(),/saved result/);assert.doesNotMatch(ui.text(),/stale wake result|有未保存的修改/)
})

test('wake refresh preserves edits made while a save is pending',async()=>{
  const ui=fixture();await ui.mount();const saving=deferred()
  ui.override(url=>url.endsWith('/settings')?saving.promise:null)
  changePath(ui,'C:/submitted.exe');const done=ui.button('保存配置').props.onClick()
  changePath(ui,'C:/newer.exe');ui.emit('online');await tick();ui.render()
  saving.resolve(ui.response({...initial(),settings:{...initial().settings,iwanClientPath:'C:/submitted.exe'}}))
  await done;ui.render()
  assert.equal(pathInput(ui).props.value,'C:/newer.exe');assert.match(ui.text(),/仍有未保存修改/)
})

test('hanging initial status times out even when fetch ignores abort, and focus can recover',async()=>{
  const ui=fixture();const hung=deferred();ui.override(()=>hung.promise)
  ui.render();ui.advance(30000);await tick();ui.render()
  assert.match(ui.text(),/请求超时/);assert.equal(ui.requests[0].init.signal.aborted,true)
  assert.equal(ui.timeoutCount(),0)
  ui.override(()=>null);ui.emit('focus');await tick();ui.render()
  assert.ok(ui.button('重新连接'));assert.doesNotMatch(ui.text(),/请求超时/)
  hung.resolve(ui.response({...initial(),log:[{at:1,msg:'obsolete status'}]}));await tick();ui.render()
  assert.doesNotMatch(ui.text(),/obsolete status/)
})

test('a timed-out save releases busy without accepting its late response or discarding the draft',async()=>{
  const ui=fixture();await ui.mount();const hung=deferred()
  ui.override(url=>url.endsWith('/settings')?hung.promise:null)
  changePath(ui,'C:/draft.exe');const done=ui.button('保存配置').props.onClick();ui.render()
  assert.equal(ui.button('保存中…').props.disabled,true)
  ui.advance(30000);await done;ui.render()
  assert.match(ui.text(),/请求超时/);assert.equal(ui.button('保存配置').props.disabled,false)
  assert.equal(ui.requests.find(({url})=>url.endsWith('/settings')).init.signal.aborted,true)
  hung.resolve(ui.response({...initial(),settings:{...initial().settings,iwanClientPath:'C:/late.exe'}}))
  await tick();ui.render()
  assert.equal(pathInput(ui).props.value,'C:/draft.exe');assert.match(ui.text(),/有未保存的修改/)
  assert.doesNotMatch(ui.text(),/配置已保存并即时生效/)
})

test('timeout also bounds response body reads rather than only fetch headers',async()=>{
  const ui=fixture();await ui.mount();const body=deferred()
  ui.override(url=>url.endsWith('/reconnect')?{ok:true,status:200,text:()=>body.promise}:null)
  const done=ui.button('重新连接').props.onClick();await tick();ui.render()
  ui.advance(30000);await done;ui.render()
  assert.match(ui.text(),/请求超时/);assert.equal(ui.button('重新连接').props.disabled,false)
  const before=ui.requests.length
  body.resolve(JSON.stringify({ok:true,value:initial()}));await tick();ui.render()
  assert.equal(ui.requests.length,before)
})

test('stop interrupts reconnect even when fetch ignores abort, and late failure is harmless',async()=>{
  const ui=fixture();await ui.mount();const hung=deferred()
  ui.override(url=>url.endsWith('/reconnect')?hung.promise:null)
  const done=ui.button('重新连接').props.onClick();ui.render()
  assert.equal(ui.button('重连中…').props.disabled,true)
  assert.equal(ui.element('启动中…'),undefined)
  assert.equal(ui.button('停止托管').props.disabled,false)
  await ui.button('停止托管').props.onClick();await done;ui.render()
  const reconnect=ui.requests.find(({url})=>url.endsWith('/reconnect'))
  assert.equal(reconnect.init.method,'POST');assert.equal(reconnect.init.signal.aborted,true)
  assert.equal(ui.requests.filter(({url})=>url.endsWith('/disconnect')).length,1)
  const before=ui.requests.length
  hung.resolve({ok:false,status:400,text:async()=>JSON.stringify({ok:false,error:'obsolete reconnect failure'})})
  await tick();ui.render()
  assert.equal(ui.requests.length,before);assert.doesNotMatch(ui.text(),/obsolete reconnect failure|请求已取消/)
})

test('unmount removes every listener and timer, aborts in-flight work, and ignores late state writes',async()=>{
  const ui=fixture();await ui.mount();const saving=deferred(),polling=deferred()
  ui.override(url=>url.endsWith('/settings')?saving.promise:url.endsWith('/status')?polling.promise:null)
  changePath(ui,'C:/draft.exe');const done=ui.button('保存配置').props.onClick();ui.emit('focus')
  const active=ui.requests.slice(-2)
  assert.equal(ui.listenerCount(),3)
  ui.unmount();await done;await tick()
  assert.equal(ui.listenerCount(),0);assert.deepEqual(ui.intervalMs(),[]);assert.equal(ui.timeoutCount(),0)
  assert.ok(active.every(({init})=>init.signal.aborted))
  const before=ui.requests.length;ui.emit('focus');ui.emit('online');ui.visibility('hidden');ui.visibility('visible');ui.poll()
  saving.resolve(ui.response(initial()));polling.resolve(ui.response(initial()));await tick()
  assert.equal(ui.requests.length,before);assert.equal(ui.staleUpdates(),0)
})

test('clicking start auth can poll its new session ID and cancel while authorization URL POST is pending',async()=>{
  const ui=fixture();const starting=deferred()
  ui.setServer({...initial(),auth:{state:'idle',credentials:{state:'missing',serverCount:0}}})
  await ui.mount();changePath(ui,'C:/unsaved.exe')
  ui.override(url=>{
    if(url.endsWith('/auth/start')){
      ui.setServer({...ui.server(),auth:{...ui.server().auth,state:'starting',id:'new-auth-session'}})
      return starting.promise
    }
    if(url.endsWith('/auth/cancel')){
      ui.setServer({...ui.server(),auth:{...ui.server().auth,state:'idle',id:null}})
      return ui.response({cancelled:true})
    }
    return null
  })
  const done=ui.button('开始认证').props.onClick();ui.render()
  assert.equal(ui.button('取消认证').props.disabled,true)
  assert.deepEqual(ui.intervalMs(),[1500])
  ui.poll();await tick();ui.render()
  assert.equal(ui.button('取消认证').props.disabled,false)
  assert.equal(pathInput(ui).props.value,'C:/unsaved.exe')
  await ui.button('取消认证').props.onClick();await done;ui.render()
  const cancel=ui.requests.find(({url})=>url.endsWith('/auth/cancel'))
  assert.deepEqual(JSON.parse(cancel.init.body),{id:'new-auth-session'})
  assert.equal(ui.requests.find(({url})=>url.endsWith('/auth/start')).init.signal.aborted,true)
  assert.ok(ui.button('开始认证'));assert.doesNotMatch(ui.text(),/请求已取消/)
  const before=ui.requests.length
  starting.resolve({ok:false,status:400,text:async()=>JSON.stringify({ok:false,error:'obsolete authorization error'})})
  await tick();ui.render()
  assert.equal(ui.requests.length,before);assert.doesNotMatch(ui.text(),/obsolete authorization error/)
})

test('active interval polling is single-flight and a status slower than its interval eventually applies',async()=>{
  const ui=fixture();ui.setServer({...initial(),recovery:{state:'waiting'}});await ui.mount()
  const slow=deferred();ui.override(url=>url.endsWith('/status')?slow.promise:null)
  const before=statusRequests(ui).length;ui.poll()
  const request=statusRequests(ui).at(-1)
  for(let i=0;i<5;i++){ui.advance(1500);ui.poll();await tick()}
  assert.deepEqual(ui.intervalMs(),[1500]);assert.equal(statusRequests(ui).length,before+1)
  assert.equal(request.init.signal.aborted,false)
  slow.resolve(ui.response({...initial(),log:[{at:1,msg:'slow poll completed'}]}))
  await tick();ui.render();assert.match(ui.text(),/slow poll completed/)
  ui.override(()=>null);ui.poll();await tick();ui.render()
  assert.equal(statusRequests(ui).length,before+2)
})

test('ordinary interval ticks do not extend the hard timeout of a hanging status request',async()=>{
  const ui=fixture();ui.setServer({...initial(),recovery:{state:'waiting'}});await ui.mount()
  const hung=deferred();ui.override(url=>url.endsWith('/status')?hung.promise:null)
  const before=statusRequests(ui).length;ui.poll()
  for(let i=0;i<20;i++){ui.advance(1500);ui.poll()}
  await tick();ui.render()
  assert.equal(statusRequests(ui).length,before+1)
  assert.equal(statusRequests(ui).at(-1).init.signal.aborted,true)
  assert.match(ui.text(),/请求超时/);assert.equal(ui.timeoutCount(),0)
})

for(const trigger of ['focus','online','visibility','刷新状态','刷新认证状态'])test('explicit '+trigger+' replaces an in-flight status request',async()=>{
  const ui=fixture();await ui.mount();const old=deferred();let first=true
  ui.override(url=>{if(url.endsWith('/status')&&first){first=false;return old.promise}return null})
  const before=statusRequests(ui).length;ui.poll()
  const oldRequest=statusRequests(ui).at(-1)
  if(trigger==='visibility'){ui.visibility('hidden');ui.visibility('visible')}
  else if(trigger.startsWith('刷新'))ui.button(trigger).props.onClick()
  else ui.emit(trigger)
  assert.equal(statusRequests(ui).length,before+2);assert.equal(oldRequest.init.signal.aborted,true)
  await tick();ui.render()
  old.resolve(ui.response({...initial(),log:[{at:1,msg:'obsolete forced poll'}]}));await tick();ui.render()
  assert.doesNotMatch(ui.text(),/obsolete forced poll/)
})

// Recovery display and reconnect eligibility.
test('optional recovery states have truthful labels and active recovery polls faster',async()=>{
  const ui=fixture();await ui.mount();assert.deepEqual(ui.intervalMs(),[10000])
  const labels={idle:'自动恢复待命',checking:'正在检查 SOCKS 连接…',healthy:'SOCKS 端口检查正常',waiting:'等待网络，稍后自动重试',recovering:'正在自动重新连接…',paused:'自动重连已暂停',external:'外部客户端，不干预',blocked:'自动重连受阻'}
  for(const [state,label] of Object.entries(labels)) {
    ui.setServer({...initial(),iwan:{managed:true,alive:true,socksAlive:false},recovery:{state,attempts:2,nextRetryAt:1700000000000,lastCheckedAt:1,lastResumeAt:1,lastError:'mock port unavailable',reason:'mock recovery reason'}})
    ui.poll();await tick();ui.render()
    assert.match(ui.text(),new RegExp(label));assert.match(ui.text(),/已尝试 2 次|mock recovery reason/)
    assert.match(ui.text(),/mock port unavailable/)
    assert.ok(ui.nodes().some(n=>typeof n.props.label==='string'&&n.props.label.endsWith('（离线）')))
    assert.deepEqual(ui.intervalMs(),[['checking','waiting','recovering'].includes(state)?1500:10000])
    if(state==='waiting')assert.match(ui.text(),/下次重试/)
    assert.equal(ui.element('认证有效'),undefined)
  }
  ui.setServer(initial());ui.poll();await tick();ui.render()
  assert.doesNotMatch(ui.text(),/自动重连受阻|mock port unavailable/)
  assert.equal(ui.button('重新连接').props.disabled,false)
})

test('automatic waiting can be explicitly stopped even with no surviving managed process',async()=>{
  const ui=fixture();ui.setServer({...initial(),recovery:{state:'waiting'}});await ui.mount()
  assert.equal(ui.button('停止托管').props.disabled,false)
  await ui.button('停止托管').props.onClick()
  assert.ok(ui.requests.some(({url,init})=>url.endsWith('/disconnect')&&init.method==='POST'))
})

test('reconnect conditions use saved credentials, binary, enabled policy, and operation ownership',async t=>{
  const cases=[
    ['old API with saved unknown credentials',s=>s,false],
    ['owned online client',s=>({...s,iwan:{managed:true,socksAlive:true}}),false],
    ['owned offline client',s=>({...s,iwan:{managed:true,socksAlive:false}}),false],
    ['blocked recovery is explicitly retryable',s=>({...s,recovery:{state:'blocked'}}),false],
    ['paused recovery is explicitly retryable',s=>({...s,recovery:{state:'paused'}}),false],
    ['waiting recovery is explicitly retryable',s=>({...s,recovery:{state:'waiting'}}),false],
    ['split disabled',s=>({...s,settings:{...s.settings,enabled:false}}),true],
    ['missing binary',s=>({...s,binary:{installed:false,path:''}}),true],
    ['binary being checked',s=>({...s,binary:{...s.binary,checking:true}}),true],
    ['no saved credentials',s=>({...s,auth:{state:'idle',credentials:{state:'missing',serverCount:0}}}),true],
    ['invalid saved credentials',s=>({...s,auth:{state:'idle',credentials:{state:'invalid',serverCount:1}}}),true],
    ['expired saved credentials',s=>({...s,auth:{state:'idle',credentials:{state:'expired',serverCount:1}}}),true],
    ['maintenance active',s=>({...s,maintenance:{running:true}}),true],
    ['download active',s=>({...s,download:{state:'downloading'}}),true],
    ...['starting','awaiting','submitting'].map(state=>['auth '+state,s=>({...s,auth:{...s.auth,state}}),true]),
    ['connect pending',s=>({...s,iwan:{managed:false,socksAlive:false,connecting:true}}),true],
    ['stop pending',s=>({...s,iwan:{managed:false,socksAlive:false,stopping:true}}),true],
    ['automatic recovering',s=>({...s,recovery:{state:'recovering'}}),true],
    ['external SOCKS online',s=>({...s,iwan:{managed:false,socksAlive:true}}),true],
    ['external recovery even if SOCKS offline',s=>({...s,recovery:{state:'external'}}),true],
  ]
  for(const [name,transform,disabled] of cases)await t.test(name,async()=>{
    const ui=fixture();ui.setServer(transform(initial()));await ui.mount()
    assert.equal(ui.button('重新连接').props.disabled,disabled)
    assert.ok(ui.requests.every(({url})=>url.endsWith('/status')))
  })
})

test('reconnect eligibility follows saved enabled setting, never unsaved checkbox drafts',async()=>{
  for(const enabled of [true,false]) {
    const ui=fixture();ui.setServer({...initial(),settings:{...initial().settings,enabled}});await ui.mount()
    ui.nodes().find(n=>n.type==='input'&&n.props.type==='checkbox').props.onChange({target:{checked:!enabled}});ui.render()
    assert.equal(ui.button('重新连接').props.disabled,!enabled)
    assert.match(ui.text(),/有未保存的修改/)
  }
})

test('explicit reconnect posts only reconnect then status and preserves dirty draft without manufacturing auth validity',async()=>{
  const ui=fixture();await ui.mount();changePath(ui,'C:/unsaved.exe')
  ui.setServer({...initial(),iwan:{managed:true,socksAlive:true},recovery:{state:'healthy'}})
  const before=ui.requests.length;await ui.button('重新连接').props.onClick();ui.render()
  assert.deepEqual(ui.requests.slice(before).map(({url})=>url),['/ustc-iwan/api/reconnect','/ustc-iwan/api/status'])
  assert.equal(pathInput(ui).props.value,'C:/unsaved.exe');assert.match(ui.text(),/有未保存的修改/)
  assert.ok(ui.element('认证已保存，待连接验证'));assert.equal(ui.element('认证有效'),undefined)
})



test('native child reconnect is visible without claiming authenticated online or blocking manual reconnect',async()=>{
  const ui=fixture();ui.setServer({...ui.server(),iwan:{managed:true,socksAlive:false,connecting:false,stopping:false,nativeReconnect:{since:1000,lastAttemptAt:1000,attempt:1,maxAttempts:5}},auth:{state:'idle',credentials:{state:'unknown',serverCount:1}},recovery:{state:'waiting',reason:'iWAN 客户端正在自行重连，暂不重启进程'}})
  await ui.mount();assert.equal(ui.element('客户端重连中…').props.role,'status');assert.equal(ui.button('重新连接').props.disabled,false);assert.equal(ui.element('认证有效'),undefined)
})
