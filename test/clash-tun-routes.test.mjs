import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { createRouteHandler, registerRoutes } from '../lib/routes.js'

const root = '/ustc-iwan/api/clash-tun'
const transport = { remoteAddress: '127.0.0.1', localPort: 18777, secure: false }
const base = 'http://127.0.0.1:18777'
const trusted = { host: '127.0.0.1:18777', referer: base + '/', 'sec-fetch-site': 'same-origin', 'x-ustc-iwan-tun': '1' }
function request(path, body, headers = {}, requestBase = base) {
  const init = body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }
  return new Request(requestBase + root + path, { ...init, headers: {
    ...trusted, ...(init.method ? { origin: base, 'content-type': 'application/json' } : {}), ...headers,
  } })
}
function fixture() {
  const state = { state: 'ready', revision: 'r0' }, actions = []
  const manager = {
    async inspect() { actions.push(['inspect']); return state },
    async apply(value) { actions.push(['apply', value]); return state },
    async rollback(value) { actions.push(['rollback', value]); return state },
  }
  return { manager, actions, state, handler: createRouteHandler({ runtime: {} }, { clashTun: manager }) }
}

test('Clash TUN endpoint rejects remote, cross-site, forwarded and unmarked requests before accessing disk', async () => {
  const {handler, actions} = fixture()
  for (const [r, connection] of [
    [request(''), undefined],
    [request(''), { ...transport, remoteAddress: '192.0.2.1' }],
    [request('', undefined, { 'sec-fetch-site': 'same-site' }), transport],
    [request('', undefined, { 'x-ustc-iwan-tun': '' }), transport],
    [request('', undefined, { host: 'example.test:18777' }), transport],
    [request('', undefined, { host: '127.0.0.1:80' }), transport],
    [request('', undefined, { referer: 'http://example.test/settings' }), transport],
    [request('/apply', {mode:'relay',revision:'r0'}, { origin: 'http://localhost:18777' }), transport],
    [request('/rollback', {revision:'r0'}, { origin: '' }), transport],
  ]) assert.equal((await handler(r, connection)).status, 403)
  assert.deepEqual(actions, [])
})

test('Clash TUN accepts a fresh preview and narrow mutation shape and never exposes raw exceptions', async () => {
  const {handler, actions, state, manager} = fixture()
  const view = await handler(request(''), transport)
  assert.equal(view.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await view.json(), {ok:true,value:state})
  for (const body of [{mode:'wide',revision:'r0'}, {mode:'relay'}, {mode:'relay',revision:'r0',path:'config.yaml'}]) {
    assert.equal((await handler(request('/apply', body), transport)).status, 400)
  }
  assert.equal((await handler(request('/rollback', {revision:'r0'}, { 'content-type': 'text/plain' }), transport)).status, 415)
  assert.equal((await handler(request('/apply', {mode:'campus',revision:'r0'}), transport)).status, 200)
  assert.equal((await handler(request('/rollback', {revision:'r0'}), transport)).status, 200)
  assert.deepEqual(actions, [['inspect'], ['apply',{mode:'campus',revision:'r0'}], ['rollback',{revision:'r0'}]])
  manager.apply = async () => { throw Object.assign(new Error('配置已变化'), {status:409}) }
  assert.equal((await handler(request('/apply', {mode:'relay',revision:'r0'}), transport)).status, 409)
  manager.inspect = async () => { throw new Error('private-yaml-data') }
  const failed = await handler(request(''), transport)
  assert.equal(failed.status, 500)
  assert.doesNotMatch(await failed.text(), /private-yaml-data/)
})

test('desktop-transformed requests require both the gateway shape and a verified host session', async () => {
  const {handler, actions} = fixture()
  let verifications = 0
  const authenticated = { ...transport, verifyHostSession() { verifications++; return true } }
  const desktop = (suffix = '', body, headers = {}) => new Request(base + root + suffix, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: { host: new URL(base).host, 'x-ustc-iwan-tun': '1', 'x-ustc-iwan-desktop': '1',
      ...(body === undefined ? {} : { 'content-type':'application/json' }), ...headers },
  })
  for (const [req, conn] of [
    [desktop(), transport],
    [desktop('', undefined, { cookie:'dsh-auth-fake=looks-valid' }), { ...transport, verifyHostSession: () => false }],
    [desktop(), { ...transport, verifyHostSession() { throw new Error('private failure') } }],
    [desktop(), { ...authenticated, remoteAddress:'192.0.2.2' }],
    [desktop('', undefined, { host:'127.0.0.1:9999' }), authenticated],
    [desktop('', undefined, { referer:'dsh-app://app.evil.invalid/' }), authenticated],
    [desktop('', undefined, { 'x-ustc-iwan-desktop':'0' }), authenticated],
    [desktop('/apply', {mode:'relay',revision:'r0'}, { origin:'https://evil.invalid' }), authenticated],
    [desktop('/rollback', {revision:'r0'}, { 'sec-fetch-site':'cross-site' }), authenticated],
  ]) assert.equal((await handler(req, conn)).status, 403)
  assert.deepEqual(actions, []); assert.equal(verifications, 0)
  assert.equal((await handler(desktop('', undefined, {referer:'dsh-app://app/settings'}), authenticated)).status, 200)
  assert.equal((await handler(desktop('/apply', {mode:'relay',revision:'r0'}), authenticated)).status, 200)
  assert.equal((await handler(desktop('/rollback', {revision:'r0'}), authenticated)).status, 200)
  assert.equal(verifications, 3)
  assert.deepEqual(actions, [['inspect'], ['apply',{mode:'relay',revision:'r0'}], ['rollback',{revision:'r0'}]])
})

test('loopback adapter verifies desktop requests against the active connection service', async t => {
  let handler
  const { handler: route, actions } = fixture()
  let connection, calls = 0
  t.after(registerRoutes({inject(_services, mount) {
    mount({get(key) { assert.equal(key, 'connection'); return connection }, webServer:{register(entry) { handler = entry.handler }}})
  }}, route))
  const server = http.createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const address = 'http://127.0.0.1:' + server.address().port
  // Use Node's HTTP transport like the desktop forwarder's peer, without generated Fetch Metadata.
  const info = (cookie, suffix = '', body) => new Promise((resolve, reject) => {
    const headers = { 'x-ustc-iwan-tun': '1', 'x-ustc-iwan-desktop': '1', cookie }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const req = http.request(address + root + suffix, { method: body === undefined ? 'GET' : 'POST', headers }, res => {
      const status = res.statusCode; res.resume(); res.once('end', () => resolve(status))
    })
    req.once('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
  assert.equal(await info('session=accepted-test-session'), 403)
  connection = { admit(req) {
    calls++
    assert.ok(req instanceof http.IncomingMessage)
    assert.equal(req.headers.host, new URL(address).host)
    return req.headers.cookie === 'session=accepted-test-session' ? { peer: {} } : { rejection: 401 }
  } }
  assert.equal(await info('session=made-up'), 403)
  assert.equal(await info('session=accepted-test-session'), 200)
  assert.equal(await info('session=accepted-test-session', '/apply', {mode:'relay',revision:'r0'}), 200)
  assert.equal(await info('session=accepted-test-session', '/rollback', {revision:'r0'}), 200)
  assert.equal(calls, 4)
  assert.deepEqual(actions, [['inspect'], ['apply',{mode:'relay',revision:'r0'}], ['rollback',{revision:'r0'}]])
})

test('real loopback adapter passes transport identity to Clash TUN endpoint', async t => {
  let handler
  const {handler: route} = fixture()
  t.after(registerRoutes({inject(_services, mount) { mount({webServer:{register(entry) { handler = entry.handler }}}) }}, route))
  const server = http.createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const address = 'http://127.0.0.1:' + server.address().port
  const response = await fetch(address + root + '/apply', {
    method: 'POST', headers: { origin: address, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-ustc-iwan-tun': '1' },
    body: JSON.stringify({mode:'relay',revision:'r0'}),
  })
  assert.equal(response.status, 200)
})
