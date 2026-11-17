import fs from 'node:fs'
import vm from 'node:vm'

export const defaults = { enabled:true,listenPort:18118,iwanSocksHost:'127.0.0.1',iwanSocksPort:1080,manageClient:false,iwanClientPath:'',iwanServer:'',upstreamProxy:'',cidrs:'202.38.64.0/19',domainSuffixes:'ustc.edu.cn',dnsServer:'',verbose:false }
export const deferred = () => { let resolve; const promise=new Promise(r=>{resolve=r}); return {promise,resolve} }
export async function fixture(overrides={}, options={}) {
  const state={ starts:[], closes:0, installs:0, restores:0, writes:[], clients:[], authCancelled:0, downloadCancelled:0 }
  const registry={
    './cidr.js':{makeCidrMatcher:()=>ip=>ip==='202.38.64.1'?'202.38.64.0/19':null},
    './resolver.js':{createResolver:()=>async host=>({ips:host==='campus.test'?['202.38.64.1']:[],fake:false})},
    './split-proxy.js':{startSplitProxy:async opts=>{state.starts.push(opts);return {close(){state.closes++}}}},
    './iwan-client.js':{isPortOpen:async()=>true,ensureIwanClient:async opts=>{state.clients.push(opts);return {managed:true,stop(){},isAlive:()=>true}},DEFAULT_IWAN_DNS:'202.38.64.1'},
    './policy.js':{installSplitPolicy:async()=>{state.installs++;return ()=>{state.restores++}}},
    './binary.js':{resolveBinary:()=>({path:'mock.exe'}),binaryState:()=>({path:'mock.exe',kind:'downloaded',installed:true,downloaded:true,version:'1.0',latestVersion:null}),downloadState:()=>({state:'done'}),startDownload:async()=>({started:true}),waitForDownload:async()=>{},cancelDownload:()=>{state.downloadCancelled++},checkForUpdates:async()=>({started:true}),cancelUpdateCheck:async()=>{}},
    './credentials.js':{readCredentialStatus:()=>({state:'unknown',serverCount:1,revision:'initial',expiresAt:null})},
    './auth.js':{startAuth:()=>{},submitRedirect:()=>{},cancelAuth:()=>{},authState:()=>({}),waitForAuthCleanup:async()=>{},cancelAllAuth:()=>{state.authCancelled++}},
    './settings-store.js':{readSettings:()=>({...defaults}),writeSettings:s=>state.writes.push(s)},
    './defaults.js':{DEFAULT_CIDRS:defaults.cidrs},
    './reconnect-monitor.js':{createReconnectMonitor:opts=>{state.monitor=opts;return {start(){state.monitorStarted=true},stop:async()=>{state.monitorStopped=true},reset(){state.monitorReset=(state.monitorReset||0)+1},status:()=>({state:'idle'})}}},
  }
  for(const [spec, values] of Object.entries(overrides)) Object.assign(registry[spec],values)
  const mod=new vm.SourceTextModule(fs.readFileSync(new URL('../../lib/runtime.js',import.meta.url),'utf8'),{context:vm.createContext({AbortController,console})})
  await mod.link(async spec=>{const values=registry[spec];return new vm.SyntheticModule(Object.keys(values),function(){for(const [key,value] of Object.entries(values))this.setExport(key,value)},{context:mod.context})})
  await mod.evaluate()
  return {rt:mod.namespace.createRuntime(options),state}
}
