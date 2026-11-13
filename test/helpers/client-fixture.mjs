import fs from 'node:fs'
import vm from 'node:vm'

export const initial = () => ({settings:{enabled:true,listenPort:18118,iwanSocksHost:'127.0.0.1',iwanSocksPort:1080,manageClient:false,iwanClientPath:'',iwanServer:'',upstreamProxy:'',cidrs:'',domainSuffixes:'ustc.edu.cn',dnsServer:'',verbose:false},proxy:{listening:true,port:18118},policyInstalled:true,iwan:{socksAlive:false,managed:false},binary:{path:'mock.exe',kind:'downloaded',installed:true,downloaded:true,version:'v1.0',checking:false,latestVersion:null,updateAvailable:null},download:{state:'idle'},auth:{state:'idle',credentials:{state:'unknown',serverCount:1,revision:'saved'}},log:[]})
export const tick = () => new Promise(setImmediate)
export const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}}
export function fixture() {
  let exported,Component,cursor=0,pending=[],tree,server=initial(),fetchOverride=null
  const requests=[];const hooks=[],intervals=new Map();let timerId=0
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
    fetch:async(url,init)=>{requests.push({url,init});if(fetchOverride){const handled=fetchOverride(url,init);if(handled)return handled}if(url.endsWith('/settings'))server={...server,settings:JSON.parse(init.body)};if(url.endsWith('/download'))return response({started:true});if(url.endsWith('/update/check'))return response({started:true,...server.binary});return response(server)},
    setInterval:fn=>{intervals.set(++timerId,fn);return timerId},clearInterval:id=>intervals.delete(id),
  }
  vm.runInNewContext(fs.readFileSync(new URL('../../lib/client.js',import.meta.url),'utf8'),ctx)
  exported.apply({slots:{inject:(_,fn)=>fn(),register:(_,C)=>{Component=C}}})
  const render=()=>{cursor=0;tree=Component();const effects=pending;pending=[];effects.forEach(fn=>fn());return tree}
  const nodes=node=>!node||typeof node!=='object'?[]:[node,...(node.children??[]).flat(Infinity).flatMap(nodes)]
  return {requests,element:text=>nodes(tree).find(n=>n.children.includes(text)),render,async mount(){render();await tick();render()},poll:()=>[...intervals.values()].forEach(fn=>fn()),
    input:placeholder=>nodes(tree).find(n=>n.type==='input'&&n.props.placeholder===placeholder),
    button:text=>nodes(tree).find(n=>n.type==='button'&&n.children.includes(text)),
    text:()=>nodes(tree).flatMap(n=>n.children.filter(c=>typeof c==='string')).join(' '),
    server:()=>server,setServer:s=>{server=s},override:fn=>{fetchOverride=fn},response,
  }
}
