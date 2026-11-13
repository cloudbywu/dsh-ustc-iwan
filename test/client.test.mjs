import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import assert from 'node:assert/strict'

const initial = () => ({settings:{enabled:true,listenPort:18118,iwanSocksHost:'127.0.0.1',iwanSocksPort:1080,manageClient:false,iwanClientPath:'',iwanServer:'',upstreamProxy:'',cidrs:'',domainSuffixes:'ustc.edu.cn',dnsServer:'',verbose:false},proxy:{listening:true,port:18118},policyInstalled:true,iwan:{socksAlive:false,managed:false},binary:{},download:{state:'idle'},auth:{state:'idle'},log:[]})
const tick = () => new Promise(setImmediate)
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}}
function fixture() {
  let exported,Component,cursor=0,pending=[],tree,server=initial(),fetchOverride=null
  const hooks=[],intervals=new Map();let timerId=0
  const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]))
  const React={
    createElement:(type,props,...children)=>({type,props:props??{},children}),
    useState(value){const i=cursor++;if(!(i in hooks))hooks[i]=value;return [hooks[i],v=>{hooks[i]=typeof v==='function'?v(hooks[i]):v}]},
    useRef(value){const i=cursor++;return hooks[i]??(hooks[i]={current:value})},
    useCallback(fn,deps){const i=cursor++;if(!hooks[i]||!same(hooks[i].deps,deps))hooks[i]={deps,fn};return hooks[i].fn},
    useEffect(fn,deps){const i=cursor++;if(!hooks[i]||!same(hooks[i].deps,deps)){hooks[i]?.cleanup?.();pending.push(()=>{hooks[i]={deps,cleanup:fn()}})}},
  }
  const response=value=>({ok:true,status:200,text:async()=>JSON.stringify({ok:true,value})})
  const ctx={window:{__ModuleLoader__:{load:entry=>{exported=entry.factory(()=>React)}}},document:{getElementById:()=>true},console,
    fetch:async(url,init)=>{if(fetchOverride){const handled=fetchOverride(url,init);if(handled)return handled}if(url.endsWith('/settings'))server={...server,settings:JSON.parse(init.body)};return response(server)},
    setInterval:fn=>{intervals.set(++timerId,fn);return timerId},clearInterval:id=>intervals.delete(id),
  }
  vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js',import.meta.url),'utf8'),ctx)
  exported.apply({slots:{inject:(_,fn)=>fn(),register:(_,C)=>{Component=C}}})
  const render=()=>{cursor=0;tree=Component();const effects=pending;pending=[];effects.forEach(fn=>fn());return tree}
  const nodes=node=>!node||typeof node!=='object'?[]:[node,...(node.children??[]).flat(Infinity).flatMap(nodes)]
  return {render,async mount(){render();await tick();render()},poll:()=>[...intervals.values()].forEach(fn=>fn()),
    input:placeholder=>nodes(tree).find(n=>n.type==='input'&&n.props.placeholder===placeholder),
    button:text=>nodes(tree).find(n=>n.type==='button'&&n.children.includes(text)),
    text:()=>nodes(tree).flatMap(n=>n.children.filter(c=>typeof c==='string')).join(' '),
    server:()=>server,setServer:s=>{server=s},override:fn=>{fetchOverride=fn},response,
  }
}

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
