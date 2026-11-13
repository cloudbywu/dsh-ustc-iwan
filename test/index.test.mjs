import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import assert from 'node:assert/strict'

async function fixture(env={}) {
  const state={options:null,initialized:0,disposed:0,mounted:0,warnings:[],hooks:{}}
  const rt={runtime:{settings:null},refreshDerived(){},async init(){state.initialized++},async dispose(){state.disposed++}}
  const context=vm.createContext({process:{env}})
  const modules={
    './runtime.js':{createRuntime:options=>{state.options=options;rt.runtime.settings={cidrs:'',domainSuffixes:'',iwanSocksPort:1080,upstreamProxy:'',...options.overrides};return rt}},
    './routes.js':{createRouteHandler:()=>()=>{},registerRoutes:()=>{state.mounted++}},
  }
  const mod=new vm.SourceTextModule(fs.readFileSync(new URL('../lib/index.js',import.meta.url),'utf8'),{context})
  await mod.link(async spec=>{const values=modules[spec];return new vm.SyntheticModule(Object.keys(values),function(){for(const [key,value] of Object.entries(values))this.setExport(key,value)},{context})})
  await mod.evaluate()
  mod.namespace.apply({logger:{info(){},warn:message=>state.warnings.push(message)},on:(event,fn)=>{state.hooks[event]=fn}})
  return {state,rt}
}

test('disabled environment does not initialize runtime or routes',async()=>{
  const {state}=await fixture({USTC_IWAN_DISABLED:'1'});assert.equal(state.options,null);assert.equal(state.mounted,0)
})

test('valid environment overrides are passed to runtime and disposal is awaitable',async()=>{
  const {state,rt}=await fixture({USTC_IWAN_SOCKS_PORT:'2080',USTC_IWAN_DNS:'202.38.64.1'})
  assert.equal(state.options.overrides.iwanSocksPort,2080);assert.equal(rt.runtime.settings.dnsServer,'202.38.64.1')
  assert.equal(state.initialized,1);await state.hooks.dispose();assert.equal(state.disposed,1)
})

test('invalid environment port is ignored without dropping other overrides',async()=>{
  const {state,rt}=await fixture({USTC_IWAN_SOCKS_PORT:'NaN',USTC_IWAN_DNS:'202.38.64.1'})
  assert.equal(rt.runtime.settings.iwanSocksPort,1080);assert.equal(rt.runtime.settings.dnsServer,'202.38.64.1')
  assert.equal(state.warnings.length,1)
})

test('startup preserves intentionally empty routing lists and detects HTTPS upstream',async()=>{
  const {rt}=await fixture({HTTPS_PROXY:'https://proxy.example.test:443'})
  assert.equal(rt.runtime.settings.cidrs,'');assert.equal(rt.runtime.settings.domainSuffixes,'')
  assert.equal(rt.runtime.settings.upstreamProxy,'https://proxy.example.test:443')
})
