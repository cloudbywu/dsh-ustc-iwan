/** DNS A lookups over the iWAN tunnel, never via public/system DNS. */
import { randomInt } from 'node:crypto'
import { domainToASCII } from 'node:url'
import { ipv4Bytes, ipv4Header, ipv4Text, internetChecksum, pseudoHeader, readIpv4 } from './ipv4.js'

const MAX_QUERIES = 64
const UDP = 17
const TRUNCATED = Symbol('DNS truncated')

function labelsFor(name) {
  const host = domainToASCII(name.replace(/\.$/, '')).toLowerCase()
  const labels = host.split('.')
  if (!host || host.length > 253 || labels.some(label => !/^[a-z0-9_-]{1,63}$/.test(label))) throw new Error('DNS 域名无效')
  return { host, bytes: Buffer.concat([...labels.map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0])]) }
}

function readName(message, from) {
  const labels = []
  let next, at = from, length = 0
  for (let remaining = 128; remaining > 0; remaining--) {
    const size = message[at]
    if (size === undefined) break
    if (size === 0) return { name: labels.join('.').toLowerCase(), next: next ?? at + 1 }
    if ((size & 0xc0) === 0xc0) {
      if (at + 1 >= message.length) break
      const ptr = (size & 0x3f) * 256 + message[at + 1]
      if (ptr >= at) break
      next ??= at + 2
      at = ptr
      continue
    }
    if (size > 63 || at + 1 + size > message.length || (length += size + 1) > 254) break
    labels.push(message.toString('latin1', at + 1, at + 1 + size))
    at += 1 + size
  }
  throw new Error('DNS 应答域名无效')
}

function readAnswer(message, query) {
  if (message.length < 12 || message.readUInt16BE(0) !== query.id ||
      (message.readUInt16BE(2) & 0xf800) !== 0x8000 || message.readUInt16BE(4) !== 1) return null
  const question = readName(message, 12)
  let at = question.next
  if (question.name !== query.host || at + 4 > message.length || message.readUInt32BE(at) !== 0x00010001) return null
  at += 4
  if (message[2] & 2) return TRUNCATED
  if (message[3] & 15) return []
  const count = message.readUInt16BE(6)
  if (count > 64) return null
  const answers = [], aliases = new Map()
  for (let i = 0; i < count; i++) {
    const entry = readName(message, at)
    at = entry.next
    if (at + 10 > message.length) return null
    const kind = message.readUInt16BE(at), klass = message.readUInt16BE(at + 2), size = message.readUInt16BE(at + 8)
    at += 10
    if (at + size > message.length) return null
    if (klass === 1 && kind === 1 && size === 4) answers.push([entry.name, ipv4Text(message.subarray(at, at + 4))])
    if (klass === 1 && kind === 5) {
      const alias = readName(message, at)
      if (alias.next !== at + size) return null
      aliases.set(entry.name, alias.name)
    }
    at += size
  }
  let name = query.host
  for (let step = 0; step < 8; step++) {
    const found = [...new Set(answers.filter(([owner]) => owner === name).map(([, address]) => address))]
    if (found.length) return found
    const alias = aliases.get(name)
    if (!alias) return name === query.host ? [] : name
    name = alias
  }
  return []
}

export function createTunnelDns({ address, server, port = 53, send, connectTcp, timeoutMs = 2500 }) {
  const source = ipv4Bytes(address), destination = ipv4Bytes(server)
  const pending = new Map()
  let closed = false

  // On validated UDP truncation only, send one length-prefixed A/IN question to
  // the same IPv4 resolver/port, with no system DNS or connection reuse. The
  // limit of 64 answer records still applies; one timeout covers connect and read.
  async function queryTcp(question, query, signal) {
    const stream = await connectTcp(server, port, { signal, timeoutMs })
    try {
      signal.throwIfAborted()
      const prefix = Buffer.alloc(2)
      prefix.writeUInt16BE(question.length)
      stream.write(Buffer.concat([prefix, question]))
      let frame = prefix, length = 0
      for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
        for (let offset = 0; offset < chunk.length;) {
          const copied = chunk.copy(frame, length, offset)
          offset += copied
          length += copied
          if (length < frame.length) break
          if (frame === prefix) {
            const size = prefix.readUInt16BE(0)
            if (size < 12) throw new Error('校内 DNS TCP 应答长度无效')
            frame = Buffer.alloc(size)
            length = 0
          } else {
            const answer = readAnswer(frame, query)
            if (answer === null || answer === TRUNCATED) throw new Error('校内 DNS TCP 应答无效或仍被截断')
            return answer
          }
        }
      }
      throw new Error('校内 DNS TCP 应答不完整')
    } finally { stream.destroy() }
  }

  function queryOne(name, signal) {
    signal?.throwIfAborted()
    if (closed || pending.size >= MAX_QUERIES) throw new Error('隧道 DNS 暂不可用')
    const { host, bytes } = labelsFor(name)
    const head = Buffer.alloc(12)
    const id = randomInt(65536)
    head.writeUInt16BE(id, 0); head.writeUInt16BE(0x100, 2); head.writeUInt16BE(1, 4)
    const question = Buffer.concat([head, bytes, Buffer.from([0,1,0,1])])
    let srcPort
    do { srcPort = randomInt(49152, 65536) } while (pending.has(srcPort))
    const udp = Buffer.alloc(8)
    udp.writeUInt16BE(srcPort, 0); udp.writeUInt16BE(port, 2); udp.writeUInt16BE(udp.length + question.length, 4)
    udp.writeUInt16BE(internetChecksum(pseudoHeader(source, destination, UDP, udp.length + question.length), udp, question) || 0xffff, 6)
    const packet = Buffer.concat([ipv4Header(source, destination, UDP, udp.length + question.length, id), udp, question])
    return new Promise((resolve, reject) => {
      let count = 0, timer, tcp
      const finish = (error, value) => {
        if (!pending.delete(srcPort)) return
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        if (value === undefined) {
          tcp?.abort(error)
          reject(error)
        } else resolve(value)
      }
      const abort = () => finish(signal.reason)
      const transmit = () => {
        if (++count > 2) return finish(new Error('校内 DNS 查询超时'))
        timer = setTimeout(transmit, timeoutMs).unref()
        try { send(packet) } catch (error) { finish(error) }
      }
      const item = { id, host, finish, accept(answer) {
        if (tcp) return // Ignore further UDP responses once this query has switched transports.
        if (answer !== TRUNCATED) return finish(null, answer)
        if (!connectTcp) return finish(null, [])
        clearTimeout(timer)
        tcp = new AbortController()
        timer = setTimeout(() => finish(new Error('校内 DNS TCP 查询超时')), timeoutMs).unref()
        queryTcp(question, item, tcp.signal).then(value => finish(null, value), error => finish(error))
      } }
      pending.set(srcPort, item)
      signal?.addEventListener('abort', abort, { once: true })
      transmit()
    })
  }
  return {
    async resolve(name, signal) {
      for (let step = 0; step < 4; step++) {
        const answer = await queryOne(name, signal)
        if (Array.isArray(answer)) return answer
        name = answer
      }
      return []
    },
    receive(packet) {
      const ip = readIpv4(packet, UDP)
      if (!ip?.source.equals(destination) || !ip.destination.equals(source)) return
      let udp = ip.payload
      if (udp.length < 8 || udp.readUInt16BE(0) !== port) return
      const size = udp.readUInt16BE(4)
      if (size < 8 || size > udp.length) return
      udp = udp.subarray(0, size)
      if (udp.readUInt16BE(6) && internetChecksum(pseudoHeader(ip.source, ip.destination, UDP, size), udp) !== 0) return
      const item = pending.get(udp.readUInt16BE(2))
      if (!item) return
      let answer
      try { answer = readAnswer(udp.subarray(8), item) } catch { return }
      if (answer !== null) item.accept(answer)
    },
    close() {
      closed = true
      for (const item of pending.values()) item.finish(new Error('隧道 DNS 已关闭'))
    },
  }
}
