import fs from 'node:fs'
import vm from 'node:vm'

export const initial = () => ({settings:{enabled:true,listenPort:18118,iwanSocksHost:'127.0.0.1',iwanSocksPort:21080,manageClient:false,iwanClientPath:'',iwanServer:'',upstreamProxy:'',cidrs:'',domainSuffixes:'ustc.edu.cn',dnsServer:'',verbose:false},proxy:{listening:true,port:18118},policyInstalled:true,environmentOverrides:[],autoUpstreamProxy:'',iwan:{socksAlive:false,managed:false},binary:{path:'mock.exe',kind:'downloaded',installed:true,downloaded:true,version:'v1.0',checking:false,latestVersion:null,updateAvailable:null},download:{state:'idle'},auth:{state:'idle',credentials:{state:'unknown',serverCount:1,revision:'saved'}},log:[]})
export const tick = () => new Promise(setImmediate)
export const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}}
export function fixture(options = {}) {
  let exported,Component,cursor=0,pending=[],tree,server=initial(),fetchOverride=null
  let timerId=0,now=0,mounted=true,staleUpdates=0
  const requests=[];const hooks=[],intervals=new Map(),timeouts=new Map()
  const listeners={window:new Map(),document:new Map()}
  const eventTarget=target=>({
    addEventListener(type,fn){const group=listeners[target];if(!group.has(type))group.set(type,new Set());group.get(type).add(fn)},
    removeEventListener(type,fn){listeners[target].get(type)?.delete(fn)},
  })
  const emit=(type,target='window')=>[...(listeners[target].get(type)??[])].forEach(fn=>fn({type}))
  const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]))
  const React={
    createElement:(type,props,...children)=>({type,props:props??{},children}),
    useState(value){const i=cursor++;if(!(i in hooks))hooks[i]=value;return [hooks[i],v=>{if(!mounted)staleUpdates++;hooks[i]=typeof v==='function'?v(hooks[i]):v}]},
    useId(){return 'mock-id-'+cursor++},
    useRef(value){const i=cursor++;return hooks[i]??(hooks[i]={current:value})},
    useCallback(fn,deps){const i=cursor++;if(!hooks[i]||!same(hooks[i].deps,deps))hooks[i]={deps,fn};return hooks[i].fn},
    useEffect(fn,deps){const i=cursor++;if(!hooks[i]||!same(hooks[i].deps,deps)){hooks[i]?.cleanup?.();pending.push(()=>{hooks[i]={deps,cleanup:fn()}})}},
  }
  const response=value=>({ok:true,status:200,text:async()=>JSON.stringify({ok:true,value})})
  const ctx={window:{...eventTarget('window'),__ModuleLoader__:{load:entry=>{exported=entry.factory(()=>React)}}},document:{...eventTarget('document'),visibilityState:'visible',getElementById:()=>true},navigator:options.navigator,console,AbortController,URL,
    fetch:async(url,init)=>{requests.push({url,init});if(fetchOverride){const handled=fetchOverride(url,init);if(handled)return handled}if(url.endsWith('/settings'))server={...server,settings:{...server.settings,...JSON.parse(init.body)}};if(url.endsWith('/download'))return response({started:true});if(url.endsWith('/update/check'))return response({started:true,...server.binary});return response(server)},
    setInterval:(fn,ms)=>{intervals.set(++timerId,{fn,ms});return timerId},clearInterval:id=>intervals.delete(id),
    setTimeout:(fn,ms)=>{timeouts.set(++timerId,{fn,at:now+ms});return timerId},clearTimeout:id=>timeouts.delete(id),
  }
  vm.runInNewContext(fs.readFileSync(new URL('../../lib/client.js',import.meta.url),'utf8'),ctx)
  exported.apply({slots:{inject:(_,fn)=>fn(),register:(_,C)=>{Component=C}}})
  const render=()=>{cursor=0;tree=Component();const effects=pending;pending=[];effects.forEach(fn=>fn());return tree}
  const nodes=node=>!node||typeof node!=='object'?[]:[node,...(node.children??[]).flat(Infinity).flatMap(nodes)]
  return {requests,element:text=>nodes(tree).find(n=>n.children.includes(text)),render,async mount(){render();await tick();render()},poll:()=>[...intervals.values()].forEach(({fn})=>fn()),
    field:key=>nodes(tree).find(n=>['input','textarea'].includes(n.type)&&n.props.id?.endsWith('-'+key)),
    input:placeholder=>nodes(tree).find(n=>n.type==='input'&&n.props.placeholder===placeholder),
    button:text=>nodes(tree).find(n=>n.type==='button'&&n.children.includes(text)),
    text:()=>nodes(tree).flatMap(n=>n.children.filter(c=>typeof c==='string')).join(' '),
    nodes:()=>nodes(tree),
    emit,visibility(state){ctx.document.visibilityState=state;emit('visibilitychange','document')},
    listenerCount:()=>Object.values(listeners).flatMap(group=>[...group.values()]).reduce((sum,set)=>sum+set.size,0),
    intervalMs:()=>[...intervals.values()].map(({ms})=>ms),timeoutCount:()=>timeouts.size,
    advance(ms){now+=ms;for(const [id,timer] of [...timeouts])if(timer.at<=now){timeouts.delete(id);timer.fn()}},
    unmount(){mounted=false;for(const hook of hooks)hook?.cleanup?.()},staleUpdates:()=>staleUpdates,
    server:()=>server,setServer:s=>{server=s},override:fn=>{fetchOverride=fn},response,
  }
}
