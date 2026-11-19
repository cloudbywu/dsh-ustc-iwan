import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultSettings, readSettings, readSettingsUpdate, settingsPath, writeSettings } from '../lib/settings-store.js'

function home(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'iwan-settings-'))
  const previous=process.env.DSH_HOME;process.env.DSH_HOME=dir
  t.after(()=>{if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;fs.rmSync(dir,{recursive:true,force:true})})
  return dir
}

test('fresh settings enable plugin management and prefer a high port by default',t=>{
  home(t);assert.equal(defaultSettings().manageClient,true);assert.equal(readSettings().manageClient,true)
  assert.equal(readSettings().iwanSocksPort,21080)
})

test('an explicitly saved management opt-out is preserved',t=>{
  home(t);writeSettings({...defaultSettings(),manageClient:false,iwanSocksPort:1080})
  assert.equal(readSettings().manageClient,false)
  assert.equal(readSettings().iwanSocksPort,1080)
})

test('older partial settings inherit management default without losing other values',t=>{
  home(t);fs.mkdirSync(path.dirname(settingsPath()),{recursive:true});fs.writeFileSync(settingsPath(),JSON.stringify({listenPort:19001}))
  const settings=readSettings();assert.equal(settings.manageClient,true);assert.equal(settings.listenPort,19001)
})

test('settings patches accept blank DNS and IPv4 CIDR lists; any invalid entry rejects the whole patch',()=>{
  const patch={dnsServer:'',cidrs:'202.38.64.0/19\n 010.0.0.1, 0.0.0.0/0'}
  assert.deepEqual(readSettingsUpdate(patch),{patch})
  assert.deepEqual(readSettingsUpdate({cidrs:''}),{patch:{cidrs:''}})
  assert.equal(readSettingsUpdate({dnsServer:'[::1]:5353'}).error,undefined)
  for(const cidrs of ['202.38.64.0/19, 10.0.0.0/33','1.2.3.4/', 'not-an-ip', '::1/128']) {
    const update=readSettingsUpdate({verbose:true,cidrs})
    assert.match(update.error,/cidrs/)
    assert.equal(update.patch,undefined)
  }
  assert.match(readSettingsUpdate({dnsServer:'dns.example.test'}).error,/dnsServer/)
})
