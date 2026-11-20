import assert from 'node:assert/strict'
import test from 'node:test'
import net from 'node:net'
import { Duplex, PassThrough } from 'node:stream'
import { setImmediate, setTimeout } from 'node:timers/promises'
import { once } from 'node:events'
import { createTunnelDns } from '../lib/node-iwan/dns.js'
import { ipv4Bytes, ipv4Header, internetChecksum, pseudoHeader } from '../lib/node-iwan/ipv4.js'
import { startNodeSocks } from '../lib/node-iwan/socks-server.js'
import { socksConnect } from '../lib/socks.js'

function dnsAnswer(question, { address = '192.0.2.9', changeQuestion = false, truncated = false } = {}) {
  const dns = Buffer.from(question)
  dns.writeUInt16BE(truncated ? 0x8380 : 0x8180,2); dns.writeUInt16BE(1,6)
  if (changeQuestion) dns[13] = 0x7a
  if (truncated) return dns
  return Buffer.concat([dns, Buffer.from([0xc0,12,0,1,0,1,0,0,0,30,0,4]), ipv4Bytes(address)])
}

function dnsReply(sent, { address, source = '192.0.2.53', sourcePort = 53, changeQuestion, truncated } = {}) {
  const dns = dnsAnswer(sent.subarray(28), { address, changeQuestion, truncated })
  const sourceIp = ipv4Bytes(source), destIp = Buffer.from(sent.subarray(12,16))
  const udp = Buffer.alloc(8)
  udp.writeUInt16BE(sourcePort,0); udp.writeUInt16BE(sent.readUInt16BE(20),2)
  const length = udp.length + dns.length
  udp.writeUInt16BE(length,4)
  udp.writeUInt16BE(internetChecksum(pseudoHeader(sourceIp,destIp,17,length),udp,dns) || 0xffff,6)
  return Buffer.concat([ipv4Header(sourceIp,destIp,17,length),udp,dns])
}

test('tunnel DNS uses IPv4 UDP and ignores unsolicited source, wrong question and corrupt replies', async () => {
  let sent
  const dns = createTunnelDns({ address:'198.18.0.2',server:'192.0.2.53',send:x=>{sent=x} })
  try {
    let done = false
    const resolved = dns.resolve('example.test').then(value=>{done=true;return value})
    assert.equal(sent[9],17); assert.equal(internetChecksum(sent.subarray(0,20)),0)
    dns.receive(dnsReply(sent,{source:'192.0.2.54'}))
    dns.receive(dnsReply(sent,{sourcePort:54}))
    dns.receive(dnsReply(sent,{changeQuestion:true}))
    const corrupt = dnsReply(sent); corrupt[corrupt.length-1] ^= 1; dns.receive(corrupt)
    await Promise.resolve(); assert.equal(done,false)
    dns.receive(dnsReply(sent)); assert.deepEqual(await resolved,['192.0.2.9'])
    const pending = dns.resolve('late.test')
    dns.close(); await assert.rejects(pending,/已关闭/)
  } finally { dns.close() }
})

test('tunnel DNS switches once to the same IPv4 resolver over TCP and reads split frames', async t => {
  let sent, sendCount = 0
  const connects = []
  const stream = new Duplex({ read() {}, write(bytes, _encoding, done) {
    this.emit('question', bytes)
    done()
  } })
  const dns = createTunnelDns({ address:'198.18.0.2', server:'192.0.2.53', port:5353,
    send:packet => { sent = packet; sendCount++ },
    connectTcp:async (host, port) => { connects.push([host, port]); return stream },
  })
  t.after(() => { dns.close(); stream.destroy() })
  const request = once(stream, 'question')
  const resolved = dns.resolve('fallback.test')
  const truncated = dnsReply(sent, { sourcePort:5353, truncated:true })
  dns.receive(dnsReply(sent, { sourcePort:5353, changeQuestion:true, truncated:true }))
  assert.deepEqual(connects, [])
  dns.receive(truncated)
  dns.receive(truncated)
  dns.receive(dnsReply(sent, { sourcePort:5353, address:'192.0.2.10' }))
  const [question] = await request
  assert.equal(question.readUInt16BE(0), question.length - 2)
  assert.deepEqual(question.subarray(2), sent.subarray(28))
  assert.deepEqual(connects, [['192.0.2.53',5353]])
  assert.equal(sendCount, 1)
  const answer = dnsAnswer(question.subarray(2))
  const frame = Buffer.alloc(answer.length+2)
  frame.writeUInt16BE(answer.length)
  answer.copy(frame,2)
  stream.push(frame.subarray(0,1))
  await setImmediate()
  stream.push(frame.subarray(1,9))
  await setImmediate()
  stream.push(frame.subarray(9))
  assert.deepEqual(await resolved, ['192.0.2.9'])
  assert.equal(stream.destroyed, true)
})

for (const stop of ['caller abort', 'resolver close']) {
  test('tunnel DNS cleans up in-flight TCP on ' + stop, async () => {
    let sent, tcpSignal
    const stream = new Duplex({ read() {}, write(_bytes, _encoding, done) {
      this.emit('question')
      done()
    } })
    const dns = createTunnelDns({ address:'198.18.0.2', server:'192.0.2.53',
      send:packet => { sent = packet },
      connectTcp:async (_host, _port, { signal }) => {
        tcpSignal = signal
        signal.addEventListener('abort', () => stream.destroy(), { once:true })
        return stream
      },
    })
    const caller = new AbortController()
    const asked = once(stream, 'question')
    const failed = assert.rejects(dns.resolve('pending.test', caller.signal),
      stop === 'caller abort' ? { name:'AbortError' } : /DNS 已关闭/)
    dns.receive(dnsReply(sent, { truncated:true }))
    await asked
    if (stop === 'caller abort') caller.abort()
    else dns.close()
    await failed
    assert.equal(tcpSignal.aborted, true)
    assert.equal(stream.destroyed, true)
    dns.close()
  })
}

test('Node SOCKS uses only loopback and finds a safe port if preferred port is occupied', async t => {
  await assert.rejects(startNodeSocks({host:'0.0.0.0',port:0}),/回环/)
  const busy = net.createServer(() => {})
  busy.listen(0,'127.0.0.1'); await once(busy,'listening')
  t.after(()=>new Promise(resolve=>busy.close(resolve)))
  const calls = []
  const endpoint = await startNodeSocks({host:'localhost',port:busy.address().port,connect:async (host,port)=>{
    calls.push([host,port]); return new PassThrough()
  }})
  t.after(()=>endpoint.stop())
  assert.equal(endpoint.host,'127.0.0.1'); assert.notEqual(endpoint.port,busy.address().port)
  const s = await socksConnect({proxyHost:endpoint.host,proxyPort:endpoint.port,targetHost:'test.example',targetPort:443})
  const got = once(s,'data')
  s.resume(); s.write('payload'); assert.equal((await got)[0].toString(),'payload')
  assert.deepEqual(calls,[['test.example',443]])
  const closed = once(s,'close')
  await endpoint.stop(); await closed
})

for (const tail of ['', 'pipelined body']) {
  test('Node SOCKS forwards early CONNECT half-close ' + (tail ? 'after its pipelined tail' : 'without payload'), { timeout:3000 }, async t => {
    const writes = []
    const endpoint = await startNodeSocks({ host:'127.0.0.1', port:0, connect:async () => {
      // Keep the upstream pending after the loopback socket has sent its FIN.
      await setTimeout(50)
      return new Duplex({ read() {}, write(bytes, _encoding, done) {
        writes.push(bytes.toString())
        done()
      }, final(done) {
        this.push(Buffer.from('reply after FIN'))
        this.push(null)
        done()
      } })
    } })
    t.after(() => endpoint.stop())
    const client = net.createConnection({ host:endpoint.host, port:endpoint.port, allowHalfOpen:true })
    t.after(() => client.destroy())
    const response = []
    client.end(Buffer.concat([Buffer.from([5,1,0,5,1,0,1,192,0,2,9,1,187]), Buffer.from(tail)]))
    for await (const bytes of client) response.push(bytes)
    assert.deepEqual(Buffer.concat(response), Buffer.concat([
      Buffer.from([5,0,5,0,0,1,0,0,0,0,0,0]), Buffer.from('reply after FIN'),
    ]))
    assert.equal(writes.join(''), tail)
  })
}
