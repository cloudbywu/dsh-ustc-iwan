import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { createNodeIwanAuthorization } from '../lib/node-iwan/oidc.js'
import { authState, startAuth, submitRedirect, cancelAuth, waitForAuthCleanup } from '../lib/auth.js'
import { readCredentialStatus, readNodeIwanRelay } from '../lib/credentials.js'

const envelope = Buffer.alloc(32, 11).toString('base64url')
const callback = (url, overwrite = '') => 'com.panabit.mobile://oauth2redirect?code=TEST_CODE&state=' + (overwrite || new URL(url).searchParams.get('state'))
const syntheticRows = [{ name:'test', serverName:'192.0.2.6', serverPort:6001, userName:'test-user', passWord:envelope, salt:'test-salt', mtu:1400 }]

test('pure Node PKCE, state validation, and controller provisioning store only compatible encrypted routes', async t => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(),'iwan-node-auth-'))
  t.after(() => fs.rmSync(configDir,{recursive:true,force:true}))
  const calls = []
  const flow = createNodeIwanAuthorization({ configDir, now:() => 1234567890000,
    post:async (address, request) => {
      const target = new URL(address), body = JSON.parse(request.body)
      calls.push({ target, body, headers:request.headers })
      if (target.pathname.endsWith('/access_token')) return { access_token:'PRIVATE_TEST_TOKEN', id_token:'stub.'+Buffer.from('{"name":"test-user"}').toString('base64url')+'.stub' }
      if (target.pathname === '/m/config') {
        const [{mtu: _mtu, ...withoutMtu}] = syntheticRows
        return { serverlist:{serverlist:[withoutMtu]} }
      }
      return {}
    } })
  const authorize = new URL(flow.authorizeUrl)
  assert.equal(authorize.host,'auth.ivpn.ustc.edu.cn')
  assert.equal(authorize.searchParams.get('code_challenge_method'),'S256')
  assert.throws(()=>flow.prepare(callback(flow.authorizeUrl,'wrong')),/会话不匹配/)
  assert.throws(()=>flow.prepare(callback(flow.authorizeUrl)+'&state=extra'),/会话不匹配/)
  assert.throws(()=>flow.prepare(callback(flow.authorizeUrl).replace('oauth2redirect','other')),/不是本次/)
  assert.deepEqual(calls,[])
  const submit = flow.prepare(callback(flow.authorizeUrl))
  assert.throws(()=>flow.prepare(callback(flow.authorizeUrl)),/已结束/)
  await submit() // Direct callers need not supply a cancellation signal.
  assert.deepEqual(calls.map(x=>x.target.pathname),['/api/login/oauth/access_token','/m/auth','/m/keepalive','/m/config'])
  assert.equal(createHash('sha256').update(calls[0].body.code_verifier).digest('base64url'),authorize.searchParams.get('code_challenge'))
  assert.equal(calls[0].body.grant_type,'authorization_code')
  for (const {headers,target,body} of calls.slice(1)) {
    assert.equal(target.origin,'https://crtl.ivpn.ustc.edu.cn')
    assert.equal(headers.Authorization,'Bearer PRIVATE_TEST_TOKEN')
    assert.equal(headers['X-Auth-Timestamp'],'1234567890')
    assert.match(headers['X-Auth-Nonce'],/^[A-F0-9]{32}$/)
    assert.match(headers['X-Auth-Sign'],/^[a-f0-9]{64}$/)
    assert.equal(body.userName,'test-user')
  }
  const disk = fs.readFileSync(path.join(configDir,'servers.json'),'utf8')
  assert.doesNotMatch(disk,/PRIVATE_TEST_TOKEN|TEST_CODE|code_verifier|device_id/)
  assert.equal(readCredentialStatus({ configDir }).serverCount,1)
  assert.deepEqual(readNodeIwanRelay({ configDir, server:'test' }),{host:'192.0.2.6',port:6001,domain:'iwan.ustc',username:'test-user',passWord:envelope,salt:'test-salt',mtu:undefined})
  assert.throws(()=>readNodeIwanRelay({ configDir, server:'auto' }),/不支持测速/)
})

test('external and embedded authentication share the same exclusivity and report validated completion', async () => {
  const logs = []
  let saved, completed = 0
  const created = await startAuth({log:text=>logs.push(text),onComplete:()=>completed++,
    createAuthorization:() => createNodeIwanAuthorization({
      post:async address=>address.includes('access_token') ? {access_token:'TEST_ACCESS'} : {serverlist:{serverlist:syntheticRows}},
      save:data=>{saved=data},
    })})
  assert.equal(created.state,'awaiting')
  await assert.rejects(startAuth({exePath:'synthetic-client'}),/已有/)
  assert.match(submitRedirect(created.id,callback(created.authorizeUrl,'bad')).error,/当前会话/)
  assert.equal(authState().state,'awaiting')
  assert.equal(submitRedirect(created.id,callback(created.authorizeUrl)).id,created.id)
  assert.equal(authState().state,'submitting')
  await setImmediate()
  assert.equal(authState().state,'done'); assert.equal(completed,1)
  assert.equal(saved.servers.length,1)
  assert.ok(logs.every(entry=>!entry.includes('TEST_ACCESS')&&!entry.includes('TEST_CODE')))
})

test('cancelling while controller response is in flight never persists late credentials', async () => {
  let release, saves = 0
  const gate = new Promise(resolve => { release = resolve })
  const created = await startAuth({ createAuthorization:() => createNodeIwanAuthorization({
    post:async address=>address.includes('access_token') ? { access_token:'TEST_ACCESS' } : await gate,
    save:()=>{saves++},
  })})
  submitRedirect(created.id,callback(created.authorizeUrl))
  await setImmediate()
  assert.deepEqual(cancelAuth(created.id),{cancelled:true})
  await assert.rejects(startAuth({exePath:'synthetic-client'}),/上一次认证/)
  release({serverlist:{serverlist:syntheticRows}})
  await waitForAuthCleanup()
  assert.equal(saves,0); assert.equal(authState().state,'failed')
})
