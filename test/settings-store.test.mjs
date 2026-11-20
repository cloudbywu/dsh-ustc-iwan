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

test('iWAN backend selection preserves native default and accepts only explicit known backends',t=>{
  home(t);assert.equal(readSettings().iwanBackend,'native')
  assert.deepEqual(readSettingsUpdate({iwanBackend:'node'}),{patch:{iwanBackend:'node'}})
  assert.match(readSettingsUpdate({iwanBackend:'unknown'}).error,/native 或 node/)
  writeSettings({...defaultSettings(),iwanBackend:'node'})
  assert.equal(readSettings().iwanBackend,'node')
  writeSettings({...defaultSettings(),iwanBackend:'unknown'})
  assert.equal(readSettings().iwanBackend,'native')
})

test('Node tunnel DNS is separate and accepts only IPv4 with an optional port', t => {
  home(t); assert.equal(readSettings().iwanTunnelDns,'')
  const patch = { dnsServer: '[2001:db8::1]:53', iwanTunnelDns:'202.38.64.1:5353' }
  assert.deepEqual(readSettingsUpdate(patch), {patch})
  assert.deepEqual(readSettingsUpdate({iwanTunnelDns:''}),{patch:{iwanTunnelDns:''}})
  for (const server of ['[2001:db8::1]:53','202.38.64.1:0','202.38.64.1:65536','dns.example.org'])
    assert.match(readSettingsUpdate({iwanTunnelDns:server}).error,/iwanTunnelDns/)
  writeSettings({...defaultSettings(),...patch}); assert.equal(readSettings().iwanTunnelDns,'202.38.64.1:5353')
  writeSettings({...defaultSettings(),iwanTunnelDns:'2001:db8::1'}); assert.equal(readSettings().iwanTunnelDns,'')
})

test('rejects malformed API proxy addresses without rejecting legacy valid addresses', () => {
  assert.deepEqual(readSettingsUpdate({iwanSocksHost:' ::1 ',upstreamProxy:' https://user:pass@localhost:7777/ '}),
    {patch:{iwanSocksHost:'::1',upstreamProxy:'https://user:pass@localhost:7777/'}})
  for (const value of ['','127.0.0.1:1234','http://localhost','host with spaces','localhost/path'])
    assert.match(readSettingsUpdate({iwanSocksHost:value}).error,/iwanSocksHost/)
  for (const value of ['socks5://localhost:1234','localhost:1234','http:localhost','http://localhost/path','http://localhost/foo/..','http://localhost/#bad','http://%X@localhost'])
    assert.match(readSettingsUpdate({upstreamProxy:value}).error,/upstreamProxy/)
})

test('exit failover is opt-in and persists only a boolean',t=>{
  home(t);assert.equal(readSettings().autoFailover,false)
  assert.deepEqual(readSettingsUpdate({autoFailover:true}),{patch:{autoFailover:true}})
  assert.match(readSettingsUpdate({autoFailover:'true'}).error,/boolean/)
  writeSettings({...defaultSettings(),autoFailover:true})
  assert.equal(readSettings().autoFailover,true)
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
