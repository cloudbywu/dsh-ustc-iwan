import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDnsServer } from '../lib/resolver.js'
import { httpProxyOrigin } from '../lib/runtime.js'

async function fixture(env={}) {
  const state={options:null,initialized:0,disposed:0,mounted:0,unmounted:0,warnings:[]}
  const rt={runtime:{settings:null},refreshDerived(){},async init(){state.initialized++;env.HTTPS_PROXY='http://127.0.0.1:18118'},async dispose(){state.disposed++}}
  const context=vm.createContext({process:{env}})
  const modules={
    './runtime.js':{httpProxyOrigin,createRuntime:options=>{state.options=options;rt.runtime.settings={cidrs:'',domainSuffixes:'',iwanSocksPort:1080,upstreamProxy:'',...options.overrides};return rt}},
    './resolver.js':{parseDnsServer},
    './routes.js':{createRouteHandler:()=>()=>{},registerRoutes:()=>{state.mounted++;return ()=>{state.unmounted++}}},
  }
  const mod=new vm.SourceTextModule(fs.readFileSync(new URL('../lib/index.js',import.meta.url),'utf8'),{context})
  await mod.link(async spec=>{const values=modules[spec];return new vm.SyntheticModule(Object.keys(values),function(){for(const [key,value] of Object.entries(values))this.setExport(key,value)},{context})})
  await mod.evaluate()
  const dispose=mod.namespace.apply({logger:{info(){},warn:message=>state.warnings.push(message)}})
  return {state,rt,dispose}
}

test('disabled environment does not initialize runtime or routes',async()=>{
  const {state}=await fixture({USTC_IWAN_DISABLED:'1'});assert.equal(state.options,null);assert.equal(state.mounted,0)
})

test('valid environment overrides are passed to runtime and disposal is awaitable',async()=>{
  const {state,rt,dispose}=await fixture({USTC_IWAN_SOCKS_PORT:'2080',USTC_IWAN_DNS:'202.38.64.1'})
  assert.equal(state.options.overrides.iwanSocksPort,2080);assert.equal(rt.runtime.settings.dnsServer,'202.38.64.1')
  assert.equal(state.initialized,1);assert.equal(typeof dispose,'function')
  const cleanup=dispose();assert.equal(state.unmounted,1);assert.equal(typeof cleanup.then,'function')
  await cleanup;assert.equal(state.disposed,1)
})

test('invalid environment port is ignored without dropping other overrides',async()=>{
  const {state,rt}=await fixture({USTC_IWAN_SOCKS_PORT:'NaN',USTC_IWAN_DNS:'202.38.64.1'})
  assert.equal(rt.runtime.settings.iwanSocksPort,1080);assert.equal(rt.runtime.settings.dnsServer,'202.38.64.1')
  assert.equal(state.warnings.length,1)
})

test('invalid environment DNS is ignored without logging its value',async()=>{
  const {state}=await fixture({USTC_IWAN_DNS:'https://sensitive.example.test',USTC_IWAN_SOCKS_PORT:'2080'})
  assert.equal(state.options.overrides.iwanSocksPort,2080)
  assert.equal(Object.hasOwn(state.options.overrides,'dnsServer'),false)
  assert.equal(state.warnings.length,1)
  assert.match(state.warnings[0],/USTC_IWAN_DNS/)
  assert.doesNotMatch(state.warnings[0],/sensitive/)
})

test('startup snapshots HTTPS upstream before policy and leaves settings untouched',async()=>{
  const {state,rt}=await fixture({https_proxy:'https:// ',HTTPS_PROXY:'https://proxy.example.test:443'})
  assert.equal(rt.runtime.settings.cidrs,'');assert.equal(rt.runtime.settings.domainSuffixes,'')
  assert.equal(rt.runtime.settings.upstreamProxy,'')
  assert.equal(state.options.detectedUpstreamProxy,'https://proxy.example.test:443')
})
