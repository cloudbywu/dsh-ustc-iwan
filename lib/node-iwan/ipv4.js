import { isIPv4 } from 'node:net'

export function ipv4Bytes(address) {
  if (!isIPv4(address)) throw new TypeError('无效的 IPv4 地址')
  return Buffer.from(address.split('.').map(Number))
}

export const ipv4Text = bytes => Array.from(bytes).join('.')

// The slices supplied to checksum need not share alignment.
export function internetChecksum(...slices) {
  let sum = 0, first = -1
  for (const bytes of slices) for (const byte of bytes) {
    if (first === -1) first = byte
    else { sum += (first << 8) | byte; first = -1 }
  }
  if (first !== -1) sum += first << 8
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16)
  return (~sum) & 0xffff
}

export function ipv4Header(source, destination, protocol, payloadLength, id = 0) {
  if (!Buffer.isBuffer(source) || !Buffer.isBuffer(destination) || source.length !== 4 || destination.length !== 4 ||
      !Number.isInteger(payloadLength) || payloadLength < 0 || payloadLength > 65515) throw new RangeError('无效的 IPv4 报文长度或地址')
  const header = Buffer.alloc(20)
  header[0] = 0x45
  header.writeUInt16BE(20 + payloadLength, 2)
  header.writeUInt16BE(id & 0xffff, 4)
  header.writeUInt16BE(0x4000, 6) // Prefer segmentation to IPv4 fragmentation.
  header[8] = 64
  header[9] = protocol
  source.copy(header, 12)
  destination.copy(header, 16)
  header.writeUInt16BE(internetChecksum(header), 10)
  return header
}

export function readIpv4(packet, protocol) {
  if (!Buffer.isBuffer(packet) || packet.length < 20 || packet[0] >>> 4 !== 4 || packet[9] !== protocol) return null
  const headerSize = (packet[0] & 15) * 4
  const size = packet.readUInt16BE(2)
  if (headerSize < 20 || headerSize > size || size > packet.length ||
      (packet.readUInt16BE(6) & 0xbfff) || internetChecksum(packet.subarray(0, headerSize)) !== 0) return null
  return { source: packet.subarray(12, 16), destination: packet.subarray(16, 20), payload: packet.subarray(headerSize, size) }
}

export function pseudoHeader(source, destination, protocol, length) {
  const tail = Buffer.alloc(4)
  tail[1] = protocol
  tail.writeUInt16BE(length, 2)
  return Buffer.concat([source, destination, tail])
}
