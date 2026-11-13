import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultSettings, readSettings, settingsPath, writeSettings } from '../lib/settings-store.js'

function home(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'iwan-settings-'))
  const previous=process.env.DSH_HOME;process.env.DSH_HOME=dir
  t.after(()=>{if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;fs.rmSync(dir,{recursive:true,force:true})})
  return dir
}

test('fresh settings enable plugin management by default',t=>{
  home(t);assert.equal(defaultSettings().manageClient,true);assert.equal(readSettings().manageClient,true)
})

test('an explicitly saved management opt-out is preserved',t=>{
  home(t);writeSettings({...defaultSettings(),manageClient:false})
  assert.equal(readSettings().manageClient,false)
})

test('older partial settings inherit management default without losing other values',t=>{
  home(t);fs.mkdirSync(path.dirname(settingsPath()),{recursive:true});fs.writeFileSync(settingsPath(),JSON.stringify({listenPort:19001}))
  const settings=readSettings();assert.equal(settings.manageClient,true);assert.equal(settings.listenPort,19001)
})
