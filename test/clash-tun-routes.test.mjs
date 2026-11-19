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
