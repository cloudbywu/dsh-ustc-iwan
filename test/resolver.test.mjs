import dns from 'node:dns'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createResolver, parseDnsServer } from '../lib/resolver.js'

test('DNS endpoints use Node IP syntax with strict ports and unambiguous IPv6', () => {
  for (const [input, normalized, expected] of [
    [' 8.8.8.8 ', '8.8.8.8', '8.8.8.8'],
    ['8.8.8.8:0005353', '8.8.8.8:5353', '8.8.8.8:5353'],
    ['::1', '::1', '::1'],
    ['[::1]', '::1', '::1'],
    ['[::1]:1', '[::1]:1', '[::1]:1'],
    ['[2001:db8::1]:65535', '[2001:db8::1]:65535', '[2001:db8::1]:65535'],
    ['2001:db8::1:5353', '2001:db8::1:5353', '2001:db8::1:5353'],
    ['[::ffff:192.0.2.1]:5353', '[::ffff:192.0.2.1]:5353', '[::ffff:192.0.2.1]:5353'],
  ]) {
    const parsed = parseDnsServer(input)
    assert.equal(parsed, normalized, input)
    const node = new dns.promises.Resolver()
    node.setServers([parsed])
    assert.deepEqual(node.getServers(), [expected], input)
  }
  assert.equal(parseDnsServer(' \t '), '')
  for (const input of [
    'dns.example.test', 'https://8.8.8.8', '8.8.8.008', '127.1', '8.8.8.8,1.1.1.1',
    '8.8.8.8:0', '8.8.8.8:', '8.8.8.8:65536', '8.8.8.8:999999999999999999999',
    '8.8.8.8:-53', '8.8.8.8:+53', '8.8.8.8: 53', '8.8.8.8:53e0', '8.8.8.8:53x',
    '[8.8.8.8]:53', '[::1]:0', '[::1]:', '[::1]:65536', '[::1]:junk',
    '[::1]:53/extra', '[::1]extra', '::1:65535', '::1:192.0.2.1:5353',
    'fe80::1%eth0', '[fe80::1%1]:5353', null, 53,
  ]) assert.equal(parseDnsServer(input), null, String(input))
})

test('invalid saved DNS and Node setServers failures use the system resolver without exposing input', async (t) => {
  const warnings = []
  const warn = (msg) => warnings.push(msg)
  const system = t.mock.method(dns.promises, 'resolve4', async () => ['198.18.0.1'])
  const setServers = t.mock.method(dns.promises.Resolver.prototype, 'setServers', () => { throw new Error('sensitive raw input') })
  const bad = createResolver({ dnsServer: 'private.invalid:0', warn })
  assert.equal(setServers.mock.callCount(), 0)
  const unsupported = createResolver({ dnsServer: '[::1]:5353', warn })
  assert.equal(setServers.mock.callCount(), 1)
  const unset = createResolver({ dnsServer: ' ', warn })
  for (const resolve of [bad, unsupported, unset]) {
    assert.deepEqual(await resolve('fake.test'), { ips: ['198.18.0.1'], fake: true, literal: false })
  }
  assert.equal(system.mock.callCount(), 3)
  assert.equal(warnings.length, 2)
  assert(warnings.every((msg) => msg.includes('系统 DNS') && !/private|sensitive/.test(msg)))
})
