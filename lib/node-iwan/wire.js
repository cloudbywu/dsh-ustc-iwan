import { isUtf8 } from 'node:buffer'
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { isIPv4 } from 'node:net'

// Public iWAN v26.11.1 app protocol constant; this is not a user's credential.
export const IWAN_APP_SECRET = 'ca6a3532abd2986a03b86b3a'
const DEFAULT_DOMAIN = 'iwan.ustc'
const DEFAULT_PORT = 6001
const OPEN_MTU = 1400
const PROXY_MTU = 1380
const HEADER_LEN = 8
const CONTROL_LEN = 24
const MAX_CONTROL = 4096
const MAX_PENDING = 128
const KEEPALIVE_MS = 10_000
const IDLE_MS = 30_000
const OPEN_TIMEOUT_MS = 15_000
const OPEN_ATTEMPTS = 4
const CLOSE_GRACE_MS = 150
const MAX_FRAGMENT_AGE_MS = 5_000
const MAX_FRAGMENT_IDS = 16
const MAX_FRAGMENTS = 16
const TYPES = {
  reject: 0x11, ack: 0x12, open: 0x13, data: 0x14, echo: 0x15, echoAck: 0x16,
  close: 0x17, encrypted: 0x18, duplicate: 0x19, encryptedDuplicate: 0x20, fragment: 0x22,
}

function failure(code, description, name = 'Error') {
  return Object.assign(new Error(description), { code, name })
}

const abortError = () => failure('ABORT_ERR', 'iWAN 隧道已取消', 'AbortError')
const timeoutError = () => failure('IWAN_OPEN_TIMEOUT', '等待 iWAN 网关认证超时', 'TimeoutError')
const udpError = () => failure('IWAN_UDP_ERROR', 'iWAN UDP 传输失败')
const hash = (algorithm, ...parts) => {
  const h = createHash(algorithm)
  for (const part of parts) h.update(part)
  return h.digest()
}

function aes(operation, key, input) {
  const cipher = operation('aes-128-ecb', key, null)
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(input), cipher.final()])
}

function decodeEnvelope(encoded) {
  if (typeof encoded !== 'string' || encoded.length > 4096 ||
      !/^(?:[A-Za-z0-9_-]+={0,2}|[A-Za-z0-9+/]+={0,2})$/.test(encoded) ||
      (encoded.includes('=') && encoded.length % 4 !== 0)) throw new Error()
  const envelope = Buffer.from(encoded, 'base64url')
  const canonical = encoded.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
  if (envelope.length < 28 || envelope.toString('base64url') !== canonical) throw new Error()
  return envelope
}

function getRelay(relay = {}) {
  const { host, port = DEFAULT_PORT, domain = DEFAULT_DOMAIN, username, passWord, salt = '', mtu } = relay ?? {}
  if (typeof host !== 'string' || !isIPv4(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw failure('IWAN_BAD_RELAY', 'iWAN 线路必须提供有效的 IPv4 地址和 UDP 端口')
  }
  if (typeof username !== 'string' || !username || Buffer.byteLength(username) > 253 ||
      typeof domain !== 'string' || !domain || Buffer.byteLength(domain) > 1024 ||
      typeof salt !== 'string' || Buffer.byteLength(salt) > 1024) {
    throw failure('IWAN_BAD_CREDENTIAL', 'iWAN 线路凭据格式无效')
  }
  const clientMtu = mtu == null || mtu === 0 ? OPEN_MTU : mtu
  if (!Number.isInteger(clientMtu) || clientMtu < 576 || clientMtu > 9000) {
    throw failure('IWAN_BAD_RELAY', 'iWAN 线路 MTU 无效')
  }
  let gcmKey, credentialKey, plaintext, last
  const block = Buffer.alloc(16)
  try {
    const envelope = decodeEnvelope(passWord)
    const aad = domain + '|' + username
    gcmKey = hash('sha256', IWAN_APP_SECRET, '|', aad)
    const gcm = createDecipheriv('aes-256-gcm', gcmKey, envelope.subarray(0, 12), { authTagLength: 16 })
    gcm.setAAD(Buffer.from(aad))
    gcm.setAuthTag(envelope.subarray(-16))
    plaintext = gcm.update(envelope.subarray(12, -16))
    last = gcm.final()
    if (!plaintext.length || !isUtf8(plaintext)) throw new Error()
    plaintext.copy(block, 0, 0, 16)
    credentialKey = hash('md5', 'mw', username, salt)
    const password = aes(createCipheriv, credentialKey, block)
    const key = hash('md5', username, plaintext)
    return { host, port, clientMtu, username: Buffer.from(username), password, key }
  } catch {
    throw failure('IWAN_BAD_CREDENTIAL', '无法解密 iWAN 线路凭据，请重新获取线路配置')
  } finally {
    for (const buffer of [gcmKey, credentialKey, plaintext, last, block]) buffer?.fill(0)
  }
}

function header(type, mode, sid = 0, token = 0) {
  const frame = Buffer.alloc(HEADER_LEN)
  frame[0] = type
  frame[1] = mode
  frame.writeUInt16BE(sid, 2)
  frame.writeUInt32BE(token, 4)
  return frame
}

function control(type, mode, sid, token, payload = Buffer.alloc(0)) {
  const head = header(type, mode, sid, token)
  return Buffer.concat([head, hash('md5', head, 'mw'), payload])
}

const isControl = frame => frame.length >= CONTROL_LEN && frame.length <= MAX_CONTROL &&
  timingSafeEqual(hash('md5', frame.subarray(0, HEADER_LEN), 'mw'), frame.subarray(HEADER_LEN, CONTROL_LEN))

function attribute(type, value) {
  return Buffer.concat([Buffer.from([type, value.length + 2]), value])
}

function openFrame(relay, nonce) {
  const mtu = Buffer.alloc(2)
  mtu.writeUInt16BE(relay.clientMtu)
  const attrs = [attribute(3, mtu), attribute(1, relay.username), attribute(2, relay.password), attribute(8, Buffer.from([1]))]
  if (nonce) attrs.push(attribute(15, nonce))
  return control(TYPES.open, 1, 0, 0, Buffer.concat(attrs))
}

function readAck(frame, nonce) {
  const result = { sid: frame.readUInt16BE(2), token: frame.readUInt32BE(4), ip: null, dns: null, mtu: OPEN_MTU, mode: 1, duplicate: false }
  for (let i = CONTROL_LEN; i < frame.length;) {
    const size = frame[i + 1]
    if (size == null || size < 2 || i + size > frame.length) return null
    const v = frame.subarray(i + 2, i + size)
    switch (frame[i]) {
      case 4: if (v.length >= 4) result.ip = v.subarray(0, 4).join('.'); break
      case 5: if (v.length >= 4) result.dns = v.subarray(0, 4).join('.'); break
      case 3: if (v.length >= 2) result.mtu = v.readUInt16BE(); break
      case 8: if (v.length) result.mode = v[0]; break
      case 9: if (v.length) result.duplicate = v[0] !== 0; break
      case 15: if (v.length !== nonce.length || !timingSafeEqual(nonce, v)) return null; break
    }
    i += size
  }
  if (result.dns === '0.0.0.0') result.dns = null
  if (result.mtu < 576 || result.mtu > 9000) result.mtu = OPEN_MTU
  result.mtu = Math.min(result.mtu, PROXY_MTU)
  return result
}

function ipv4Length(packet, mtu) {
  if (packet.length < 20 || packet[0] >> 4 !== 4) return 0
  const headerSize = (packet[0] & 15) * 4
  const length = packet.readUInt16BE(2)
  return headerSize >= 20 && length >= headerSize && length <= mtu && length <= packet.length ? length : 0
}

const paddedLength = length => Math.ceil(length / 16) * 16

function transform(packet, mode, key, outbound) {
  if (mode === 0) return packet
  if (mode === 1) {
    const copy = Buffer.allocUnsafe(packet.length)
    for (let i = 0; i < copy.length; i++) copy[i] = packet[i] ^ key[i % 8]
    return copy
  }
  if (!outbound) return aes(createDecipheriv, key, packet)
  const padded = Buffer.alloc(paddedLength(packet.length))
  packet.copy(padded)
  return aes(createCipheriv, key, padded)
}

function receiveFragment(frame, mtu, entries, now) {
  if (frame.length <= 16 || frame[1] !== 0) return null
  const id = frame.readUInt32LE(8)
  const layout = frame.readUInt32LE(12)
  const offset = (layout >>> 2) & 0x1fff
  const size = (layout >>> 15) & 0x7ff
  const end = offset + size
  const last = (layout & 1) !== 0
  if (size !== frame.length - 16 || end > mtu) return null
  for (const [oldId, entry] of entries) {
    if (now - entry.started >= MAX_FRAGMENT_AGE_MS) entries.delete(oldId)
  }
  if (!entries.has(id)) {
    if (entries.size >= MAX_FRAGMENT_IDS) entries.delete(entries.keys().next().value)
    entries.set(id, { started: now, end: null, parts: new Map() })
  }
  const entry = entries.get(id)
  if (entry.parts.has(offset)) return null
  if (entry.parts.size >= MAX_FRAGMENTS || (entry.end != null && (end > entry.end || (last && end !== entry.end))) ||
      [...entry.parts].some(([start, bytes]) => (start < end && start + bytes.length > offset) || (last && start + bytes.length > end))) {
    entries.delete(id)
    return null
  }
  entry.parts.set(offset, frame.subarray(16))
  if (last) entry.end = end
  if (entry.end === null) return null
  let next = 0
  const parts = []
  while (entry.parts.has(next)) {
    const part = entry.parts.get(next)
    parts.push(part)
    next += part.length
  }
  if (next !== entry.end) return null
  entries.delete(id)
  const packet = Buffer.concat(parts, next)
  return ipv4Length(packet, mtu) === next ? packet : null
}

/** Own a connected UDP session. The signal also cancels the established tunnel. */
export async function openIwanTunnel({ relay, signal, timeoutMs = OPEN_TIMEOUT_MS, log = () => {} } = {}) {
  if (signal?.aborted) throw abortError()
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw failure('IWAN_BAD_TIMEOUT', 'iWAN 认证超时设置无效')
  }
  const prepared = getRelay(relay)
  const report = message => { try { log(message) } catch {} }
  let nonce, socket
  try {
    if (signal?.aborted) throw abortError()
    nonce = randomBytes(4)
    socket = createSocket('udp4')
  } catch (error) {
    prepared.password.fill(0)
    prepared.key.fill(0)
    if (error?.name === 'AbortError') throw error
    throw udpError()
  }

  return new Promise((resolve, reject) => {
    let session, attempts = 0, legacy = false, pending = 0, closing = false, reason = null
    let deadline, retry, echoTimer, grace
    let stoppingSocket = false, lastEcho = 0
    const retryMs = Math.min(4000, Math.ceil(timeoutMs / OPEN_ATTEMPTS))
    const packets = new Set()
    const closes = new Set()
    const fragments = new Map()
    let didClose
    const closed = new Promise(done => { didClose = done })

    function notify(fn, value) {
      try { fn(value) } catch { report('iWAN 隧道回调失败') }
    }

    function socketClosed() {
      clearTimeout(grace)
      if (!closing) finish(udpError(), false, true)
      socket.off('message', message)
      socket.off('connect', attemptOpen)
      socket.off('error', socketError)
      socket.off('close', socketClosed)
      didClose()
      // Startup callers await this rejection to know the UDP socket is closed.
      if (!session) reject(reason ?? udpError())
    }

    function stopSocket() {
      if (stoppingSocket) return
      stoppingSocket = true
      clearTimeout(grace)
      try { socket.close() } catch { socketClosed() }
    }

    function finish(error, graceful = false, alreadyClosed = false) {
      if (closing) return closed
      closing = true
      reason = error
      clearTimeout(retry)
      clearTimeout(deadline)
      clearTimeout(echoTimer)
      signal?.removeEventListener('abort', onAbort)
      prepared.password.fill(0)
      prepared.key.fill(0)
      fragments.clear()
      packets.clear()
      if (!alreadyClosed) {
        if (graceful && session) {
          grace = setTimeout(stopSocket, CLOSE_GRACE_MS)
          try { socket.send(control(TYPES.close, session.mode, session.sid, session.token), stopSocket) }
          catch { stopSocket() }
        } else stopSocket()
      }
      for (const fn of closes) notify(fn, reason)
      closes.clear()
      return closed
    }

    function onAbort() { finish(abortError(), true) }
    function socketError() { finish(udpError()) }

    function transmit(frame, sensitive = false) {
      if (closing || pending >= MAX_PENDING) {
        if (sensitive) frame.fill(0)
        return false
      }
      pending++
      try {
        socket.send(frame, error => {
          if (sensitive) frame.fill(0)
          pending--
          if (error) socketError()
        })
        return true
      } catch {
        if (sensitive) frame.fill(0)
        pending--
        socketError()
        return false
      }
    }

    function attemptOpen() {
      if (closing || session || attempts >= OPEN_ATTEMPTS) return
      attempts++
      if (!transmit(openFrame(prepared, legacy ? null : nonce), true) || closing) return
      if (attempts < OPEN_ATTEMPTS) retry = setTimeout(attemptOpen, retryMs)
    }

    function echo() {
      if (closing) return
      if (performance.now() - lastEcho >= IDLE_MS) {
        finish(failure('IWAN_IDLE_TIMEOUT', 'iWAN 网关探活超时'))
        return
      }
      const payload = Buffer.alloc(36)
      payload.writeBigUInt64LE(BigInt(Date.now()) * 1000n)
      transmit(control(TYPES.echo, session.mode, session.sid, session.token, payload))
      if (!closing) echoTimer = setTimeout(echo, KEEPALIVE_MS)
    }

    function subscribe(set, fn, replay = false) {
      if (typeof fn !== 'function') throw new TypeError('iWAN callback must be a function')
      if (!closing) {
        set.add(fn)
        return () => { set.delete(fn) }
      }
      let active = replay
      if (active) queueMicrotask(() => { if (active) notify(fn, reason) })
      return () => { active = false }
    }

    function send(packet) {
      if (closing || pending >= MAX_PENDING - 1 || !(packet instanceof Uint8Array) || packet.length > session.mtu) return false
      const data = Buffer.from(packet.buffer, packet.byteOffset, packet.byteLength)
      if (ipv4Length(data, session.mtu) !== data.length || data.length === 0) return false
      const { mode, sid, token, duplicate } = session
      const payload = transform(data, mode, prepared.key, true)
      const type = mode ? TYPES.encrypted : TYPES.data
      if (!transmit(Buffer.concat([header(type, mode, sid, token), payload]))) return false
      if (duplicate) {
        const second = mode ? TYPES.encryptedDuplicate : TYPES.duplicate
        transmit(Buffer.concat([header(second, mode, sid, token), payload]))
      }
      return true
    }

    function handshake(frame) {
      const type = frame[0]
      if ((type !== TYPES.ack && type !== TYPES.reject) || !isControl(frame)) return
      if (type === TYPES.reject) {
        finish(failure('IWAN_OPEN_REJECTED', 'iWAN 网关拒绝了线路认证'))
        return
      }
      const ack = readAck(frame, nonce)
      if (!ack) return
      if (!ack.ip && !legacy && attempts < OPEN_ATTEMPTS) {
        legacy = true
        clearTimeout(retry)
        report('iWAN 网关未返回隧道地址，改用兼容握手')
        attemptOpen()
        return
      }
      if (!ack.ip || ack.ip === '0.0.0.0' || ack.ip === '255.255.255.255') {
        finish(failure('IWAN_BAD_ACK', 'iWAN 网关未提供可用的隧道 IPv4 地址'))
        return
      }
      if (ack.mode > 2) {
        finish(failure('IWAN_BAD_ACK', 'iWAN 网关选择了不支持的加密模式'))
        return
      }
      session = ack
      clearTimeout(retry)
      clearTimeout(deadline)
      prepared.password.fill(0)
      lastEcho = performance.now()
      resolve(Object.freeze({
        ip: ack.ip, mtu: ack.mtu, dns: ack.dns, send,
        onPacket: fn => subscribe(packets, fn),
        onClose: fn => subscribe(closes, fn, true),
        close: () => finish(null, true),
      }))
      echo()
    }

    function message(frame) {
      if (closing || frame.length < HEADER_LEN) return
      if (!session) { handshake(frame); return }
      const { sid, token, mtu, mode } = session
      if (frame.readUInt16BE(2) !== sid || frame.readUInt32BE(4) !== token) return
      const type = frame[0]
      if (type === TYPES.echo || type === TYPES.echoAck || type === TYPES.close) {
        if (!isControl(frame)) return
        if (type === TYPES.echo) transmit(control(TYPES.echoAck, frame[1], sid, token, frame.subarray(CONTROL_LEN)))
        else if (type === TYPES.echoAck) lastEcho = performance.now()
        else finish(failure('IWAN_PEER_CLOSED', 'iWAN 网关已关闭隧道'))
        return
      }
      let packet
      if (type === TYPES.fragment) packet = receiveFragment(frame, mtu, fragments, performance.now())
      else if (type === TYPES.data || type === TYPES.duplicate || type === TYPES.encrypted || type === TYPES.encryptedDuplicate) {
        const encrypted = type === TYPES.encrypted || type === TYPES.encryptedDuplicate
        const packetMode = encrypted ? mode : 0
        const payload = frame.subarray(HEADER_LEN)
        const maxWire = packetMode === 2 ? paddedLength(mtu) : mtu
        if (payload.length < 20 || payload.length > maxWire || (packetMode === 2 && payload.length % 16)) return
        const plain = transform(payload, packetMode, prepared.key, false)
        const len = ipv4Length(plain, mtu)
        // Some gateways retain Ethernet minimum-payload padding in the UDP frame.
        // The IPv4 length is authoritative; never pass trailing bytes to TCP or UDP.
        if (len && (packetMode !== 2 || paddedLength(len) === payload.length)) packet = plain.subarray(0, len)
      }
      if (packet) for (const fn of packets) notify(fn, packet)
    }

    socket.on('error', socketError)
    socket.once('close', socketClosed)
    socket.on('message', message)
    socket.once('connect', attemptOpen)
    signal?.addEventListener('abort', onAbort, { once: true })
    deadline = setTimeout(() => finish(timeoutError()), timeoutMs)
    if (signal?.aborted) { onAbort(); return }
    try { socket.connect(prepared.port, prepared.host) } catch { socketError() }
  })
}
