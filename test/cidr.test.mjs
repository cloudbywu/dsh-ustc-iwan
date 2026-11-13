import test from 'node:test'
import assert from 'node:assert/strict'
import { ipv4ToInt, parseCidr, parseCidrList, makeCidrMatcher, isFakeIPv4 } from '../lib/cidr.js'

test('CIDR rejects absent/invalid slash prefixes rather than treating them as /0', () => {
  for (const suffix of ['', ' ', '+0', '-0', '1e1', '0x10', '1.0', '33', '-1', '24/0']) {
    assert.equal(parseCidr(`10.0.0.1/${suffix}`), null, suffix)
  }
  assert.deepEqual(parseCidr('10.0.0.1'), { lo: 167772161, hi: 167772161, raw: '10.0.0.1' })
  assert.deepEqual(parseCidr('0.0.0.0/0'), { lo: 0, hi: 0xffffffff, raw: '0.0.0.0/0' })
  assert.equal(makeCidrMatcher('10.0.0.1/')('8.8.8.8'), null)
})

test('CIDR network boundaries and invalid IPv4', () => {
  const match = makeCidrMatcher('10.0.0.17/24, 255.255.255.255/32')
  for (const ip of ['10.0.0.0', '10.0.0.255']) assert.equal(match(ip), '10.0.0.17/24')
  assert.equal(match('10.0.1.0'), null)
  assert.equal(match('255.255.255.255'), '255.255.255.255/32')
  assert.equal(ipv4ToInt('255.255.255.255'), 0xffffffff)
  for (const ip of ['256.0.0.0', '1.2.3', '::1', '1.2.3.4x', '']) assert.equal(ipv4ToInt(ip), null)
  assert.equal(parseCidrList('bad,10.0.0.1/ 10.0.0.0/8').length, 1)
  assert.equal(isFakeIPv4('198.19.255.255'), true)
  assert.equal(isFakeIPv4('198.20.0.0'), false)
})
