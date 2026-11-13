import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import assert from 'node:assert/strict'

async function load(installer) {
  const env={HTTP_PROXY:'http://old.example.test:7890',NO_PROXY:'custom.test'}
  const context=vm.createContext({process:{env}})
  const mod=new vm.SourceTextModule(fs.readFileSync(new URL('../lib/policy.js',import.meta.url),'utf8'),{context,importModuleDynamically:async()=>{
    if(!installer)throw new Error('optional host package absent')
    const dependency=new vm.SyntheticModule(['installProxyFromEnvironment'],function(){this.setExport('installProxyFromEnvironment',installer)},{context})
    await dependency.link(()=>{});await dependency.evaluate();return dependency
  }})
  await mod.link(()=>{});await mod.evaluate();return {env,install:mod.namespace.installSplitPolicy}
}

test('environment fallback restores all original values and unsets introduced values',async()=>{
  const {env,install}=await load();const original={...env}
  const restore=await install(18118,()=>{})
  assert.equal(env.HTTPS_PROXY,'http://127.0.0.1:18118');assert.equal(env.no_proxy,'localhost,127.0.0.1,::1')
  restore();assert.deepEqual(env,original)
  env.HTTP_PROXY='http://new.example.test:7890';restore();assert.equal(env.HTTP_PROXY,'http://new.example.test:7890')
})

test('official host policy receives case-insensitive lookup and returns its disposer',async()=>{
  let restored=0
  const {env,install}=await load(async(lookup,report)=>{
    assert.equal(lookup.get('HTTPS_PROXY').value,'http://127.0.0.1:18118')
    assert.equal(lookup.get('no_proxy').value,'localhost,127.0.0.1,::1');assert.equal(lookup.get('unknown'),undefined)
    report('installed');return ()=>{restored++}
  })
  const original={...env};const restore=await install(18118,()=>{})
  restore();assert.equal(restored,1);assert.deepEqual(env,original)
})

test('logger exceptions cannot cause a successfully installed policy to be lost',async()=>{
  let restored=0
  const {env,install}=await load(async(_lookup,report)=>{report('installed');return ()=>{restored++}})
  const original={...env};const restore=await install(18118,()=>{throw new Error('logger unavailable')})
  restore();assert.equal(restored,1);assert.deepEqual(env,original)
})
