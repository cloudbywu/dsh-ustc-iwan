import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, initial, tick, deferred } from './helpers/client-fixture.mjs'

test('polling preserves unsaved form input and discard explicitly resets it',async()=>{
  const ui=fixture();await ui.mount()
  ui.input('留空则使用已下载的副本').props.onChange({target:{value:'C:/new.exe'}});ui.render()
  ui.poll();await tick();ui.render()
  assert.equal(ui.input('留空则使用已下载的副本').props.value,'C:/new.exe')
  assert.match(ui.text(),/有未保存的修改/)
  ui.button('放弃未保存修改').props.onClick();ui.render()
  assert.equal(ui.input('留空则使用已下载的副本').props.value,'')
})

test('save establishes a new clean baseline for later polling',async()=>{
  const ui=fixture();await ui.mount()
  ui.input('留空则使用已下载的副本').props.onChange({target:{value:'C:/saved.exe'}});ui.render()
  await ui.button('保存配置').props.onClick();ui.render()
  assert.doesNotMatch(ui.text(),/有未保存的修改/)
  ui.setServer({...ui.server(),settings:{...ui.server().settings,iwanClientPath:'C:/external.exe'}})
  ui.poll();await tick();ui.render()
  assert.equal(ui.input('留空则使用已下载的副本').props.value,'C:/external.exe')
})

test('edits made while save is in flight are not discarded',async()=>{
  const ui=fixture();await ui.mount();const saving=deferred()
  ui.override(url=>url.endsWith('/settings')?saving.promise:null)
  ui.input('留空则使用已下载的副本').props.onChange({target:{value:'C:/submitted.exe'}});ui.render()
  const done=ui.button('保存配置').props.onClick()
  ui.input('留空则使用已下载的副本').props.onChange({target:{value:'C:/newer.exe'}})
  saving.resolve(ui.response({...ui.server(),settings:{...ui.server().settings,iwanClientPath:'C:/submitted.exe'}}))
  await done;ui.render();assert.equal(ui.input('留空则使用已下载的副本').props.value,'C:/newer.exe')
  assert.match(ui.text(),/有未保存的修改/)
})

test('a poll started before save cannot replace the saved state',async()=>{
  const ui=fixture();await ui.mount();const old=deferred();let intercept=true
  ui.override(url=>url.endsWith('/status')&&intercept?old.promise:null)
  ui.poll();intercept=false
  ui.input('留空则使用已下载的副本').props.onChange({target:{value:'C:/saved.exe'}});ui.render()
  await ui.button('保存配置').props.onClick();ui.render()
  old.resolve(ui.response(initial()));await tick();ui.render()
  assert.equal(ui.input('留空则使用已下载的副本').props.value,'C:/saved.exe')
})

test('starting and submitting authentication expose cancellation',async()=>{
  const ui=fixture();await ui.mount()
  for(const state of ['starting','submitting']) {
    ui.setServer({...ui.server(),auth:{id:'auth-1',state}});ui.poll();await tick();ui.render()
    assert.equal(ui.button('取消认证').props.disabled,false)
  }
})

test('stop remains available while managed client is starting and suppresses stale start errors',async()=>{
  const ui=fixture();await ui.mount();const connecting=deferred();let stops=0
  ui.override(url=>{
    if(url.endsWith('/connect'))return connecting.promise
    if(url.endsWith('/disconnect')){stops++;return Promise.resolve(ui.response({disconnected:true}))}
    return null
  })
  const starting=ui.button('启动 iWAN').props.onClick();ui.render()
  assert.equal(ui.button('停止托管').props.disabled,false)
  await ui.button('停止托管').props.onClick()
  connecting.resolve({ok:false,status:400,text:async()=>JSON.stringify({ok:false,error:'stale connect failure'})})
  await starting;ui.render();assert.equal(stops,1);assert.doesNotMatch(ui.text(),/stale connect failure/)
})
