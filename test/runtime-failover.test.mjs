import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { fixture, deferred } from './helpers/runtime-fixture.mjs'
import { startSplitProxy } from '../lib/split-proxy.js'

async function listener(fn) {
  const sockets = new Set()
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    fn(socket)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { port: server.address().port, close() {
    for (const socket of sockets) socket.destroy()
    return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  } }
}

async function setup(t, { autoFailover = true, manageClient = true, healthy = '3', preferred = '1', replyError = false, afterStop, onTunnel = () => {}, rejectStart = () => false, now } = {}) {
  const starts = [], stops = [], dials = [], payloads = []
  let direct = 0, bound
  const target = await listener(() => { direct++ })
  const other = await listener(() => { direct++ })
  t.after(async () => { await Promise.all([target.close(), other.close()]) })
  let externalDials = 0
  const external = manageClient ? null : await listener(socket => {
    externalDials++; socket.once('data', () => socket.write(Buffer.from([5,0])))
  })
  if (external) t.after(() => external.close())
  const {rt, state} = await fixture({
    './credentials.js': { readCredentialRelayPlan: ({server}) => ({ selected:server || '1', candidates:['1','2','3','4'] }) },
    './iwan-client.js': { async ensureIwanClient({server}) {
      const id = server || '1'
      starts.push(id)
      if (rejectStart(id)) throw new Error('synthetic unavailable relay')
      const socks = await listener(socket => {
        let stage = 0
        socket.on('data', data => {
          if (stage++ === 0) return socket.write(Buffer.from([5,0]))
          if (stage === 2) {
            dials.push(id)
            if (id === healthy) socket.write(Buffer.from([5,0,0,1,0,0,0,0,0,0]))
            else if (replyError) socket.write(Buffer.from([5,5,0,1,0,0,0,0,0,0]))
            return
          }
          payloads.push([id, data.toString()]); socket.write('ok')
        })
      })
      let alive = true, exited = false, closing
      return { managed: true, socksHost:'127.0.0.1', socksPort:socks.port, isAlive:()=>alive, hasExited:()=>exited,
        stop() { return closing ??= (async () => { stops.push(id); alive = false; await afterStop?.(id); await socks.close(); exited = true })() } }
    } },
    './split-proxy.js': { async startSplitProxy(options) {
      const proxy = await startSplitProxy({ ...options, port:0, decide:()=>({kind:'iwan'}), timeoutMs:350,
        socksRetryWindowMs:100, failoverTimeoutMs:5000, iwanFailover(host, port) {
          const selected = options.iwanFailover(host, port)
          return selected && (args => { onTunnel(args.signal); return selected(args) })
        } })
      bound = proxy.server.address().port
      return proxy
    } },
    './settings-store.js': {readSettings:()=>({enabled:true,manageClient,autoFailover,listenPort:18118,iwanSocksHost:'127.0.0.1',iwanSocksPort:external?.port ?? target.port,iwanClientPath:'',iwanServer:preferred,upstreamProxy:'',domainSuffixes:'ustc.edu.cn',dnsServer:'',verbose:false})},
  }, { monitoring: { failoverHandshakeMs: 140, now } })
  t.after(()=>rt.dispose())
  await rt.init()
  function request(send, signal, targetPort = target.port) {
    return new Promise((resolve, reject) => {
      const address = '127.0.0.1:' + targetPort
      const req = http.request({host:'127.0.0.1',port:bound,method:'CONNECT',path:address,signal,headers:{host:address}})
      req.setTimeout(5000, () => req.destroy(new Error('test tunnel hung')))
      req.once('error', reject)
      req.once('connect', (res, socket) => {
        socket.on('error', reject)
        if (!send || res.statusCode !== 200) { socket.destroy(); resolve(res.statusCode); return }
        socket.once('data', reply => { socket.destroy(); resolve([res.statusCode, reply.toString()]) })
        socket.write(send)
      })
      req.end()
    })
  }
  return {rt,state,starts,stops,dials,payloads,direct:()=>direct,externalDials:()=>externalDials,request,otherTarget:()=>request(undefined,undefined,other.port)}
}

test('managed timeout changes to the next viable exit, keeps configured preference, and does not replay bytes', async t => {
  const f = await setup(t)
  assert.deepEqual(await f.request('first request'), [200,'ok'])
  assert.deepEqual(f.starts,['1','2','3']); assert.deepEqual(f.stops,['1','2'])
  assert.deepEqual(f.dials,['1','2','3']); assert.deepEqual(f.payloads,[['3','first request']])
  assert.deepEqual(f.rt.status().iwan.failover,{state:'switched',server:'3',attempt:3,total:4})
  assert.equal(f.rt.status().settings.iwanServer,'1'); assert.deepEqual(f.state.writes,[])
  assert.equal(await f.request(),200); assert.deepEqual(f.starts,['1','2','3']); assert.equal(f.direct(),0)
  await f.rt.connect()
  assert.deepEqual(f.starts,['1','2','3']); assert.equal(f.rt.status().iwan.failover.server,'3')
  await f.rt.reconnect()
  assert.deepEqual(f.starts,['1','2','3','1']); assert.equal(f.rt.status().iwan.failover,null)
})

test('concurrent timeouts share one four-exit cycle, then reject without direct fallback', async t => {
  const f = await setup(t,{healthy:null,preferred:'3'})
  assert.deepEqual(await Promise.all([f.request(),f.request(),f.request()]),[502,502,502])
  assert.deepEqual(f.starts,['3','4','1','2']); assert.deepEqual(f.stops,['3','4','1'])
  assert.deepEqual(f.rt.status().iwan.failover,{state:'exhausted',server:'2',attempt:4,total:4})
  assert.equal(await f.request(),502); assert.deepEqual(f.starts,['3','4','1','2']); assert.equal(f.direct(),0)
})

test('a different iWAN target cannot fall back to direct while a failed sweep left no managed endpoint', async t => {
  let recovered = false, time = 0
  const f = await setup(t,{healthy:'2',rejectStart:id=>id !== '1' && !recovered,now:()=>time})
  assert.equal(await f.request(),502)
  assert.deepEqual(f.starts,['1','2','3','4']); assert.equal(f.rt.status().iwan.managed,false)
  assert.equal(await f.otherTarget(),502)
  time += 21_000
  assert.equal(await f.otherTarget(),502)
  assert.equal(f.direct(),0)
  recovered = true
  assert.equal(await f.state.monitor.recover({reason:'socks-unreachable'}),true)
  assert.equal(await f.otherTarget(),200)
  assert.equal(f.direct(),0)
})

test('opt-out and non-timeout SOCKS refusal retain direct fallback without switching',async t=>{
  const off = await setup(t,{autoFailover:false})
  assert.equal(await off.request(),200); assert.deepEqual(off.starts,['1']); assert.equal(off.direct(),1)
  const rejected = await setup(t,{replyError:true})
  assert.equal(await rejected.request(),200); assert.deepEqual(rejected.starts,['1']); assert.equal(rejected.direct(),1)
})

test('external client is not restarted or rotated even with the switch saved',async t=>{
  const f = await setup(t,{manageClient:false})
  assert.equal(await f.request(),200); assert.deepEqual(f.starts,[]); assert.deepEqual(f.stops,[])
  assert.equal(f.externalDials(),1); assert.equal(f.direct(),1)
  assert.equal(f.rt.status().iwan.failover,null)
})

test('disconnecting the first request leaves a shared switch active for another caller',async t=>{
  const stopping = deferred(), release = deferred(), follower = deferred(), firstAborted = deferred()
  let entered = 0
  const f = await setup(t,{healthy:'2',afterStop:async id=>{if(id==='1'){stopping.resolve();await release.promise}},
    onTunnel(signal) {
      if (++entered === 1) signal.addEventListener('abort',firstAborted.resolve,{once:true})
      else follower.resolve()
    } })
  const controller = new AbortController()
  const dropped = assert.rejects(f.request(undefined,controller.signal),{name:'AbortError'})
  await stopping.promise
  const following = f.request('only surviving request'); await follower.promise
  controller.abort(); await dropped; await firstAborted.promise; release.resolve()
  assert.deepEqual(await following,[200,'ok']); assert.deepEqual(f.starts,['1','2']); assert.equal(f.direct(),0)
  assert.deepEqual(f.payloads,[['2','only surviving request']])
})

test('manual stop supersedes an in-flight switch before starting the next exit',async t=>{
  const stopping = deferred(), release = deferred()
  const f = await setup(t,{afterStop:async id=>{if(id==='1'){stopping.resolve();await release.promise}}})
  const request = f.request(); await stopping.promise
  const disconnect = f.rt.disconnect(); release.resolve(); await disconnect
  assert.equal(await request,502); assert.deepEqual(f.starts,['1']); assert.equal(f.direct(),0)
  assert.equal(f.rt.status().iwan.failover,null); assert.equal(f.rt.status().iwan.paused,true)
})
