'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isBlockedIp, classifyIp, createPinnedLookup } = require('../../src/security/ssrf-protection');

const BLOCKED = [
  ['127.0.0.1', 'loopback'],
  ['127.255.255.254', 'loopback'],
  ['10.0.0.5', 'private'],
  ['10.255.255.255', 'private'],
  ['172.16.0.1', 'private'],
  ['172.31.255.255', 'private'],
  ['192.168.1.1', 'private'],
  ['169.254.169.254', 'link-local'],
  ['0.0.0.0', 'reserved'],
  ['100.64.0.1', 'cgnat'],
  ['192.0.2.1', 'documentation'],
  ['198.18.0.1', 'benchmark'],
  ['240.0.0.1', 'reserved'],
  ['255.255.255.255', 'broadcast'],
  ['::1', 'loopback'],
  ['fd12:3456::1', 'unique-local'],
  ['fe80::1', 'link-local'],
  ['ff02::1', 'multicast'],
  ['::ffff:127.0.0.1', 'loopback'], // IPv4-mapped
  ['::ffff:10.1.2.3', 'private'],
  // NAT64/6to4/mapped forms are unwrapped, so the label names the embedded
  // IPv4 that is actually being connected to — a more useful diagnostic.
  ['64:ff9b::a00:1', 'private'], // 64:ff9b::10.0.0.1
  ['2002:7f00:1::', 'loopback'] // 6to4 for 127.0.0.1
];

const ALLOWED = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '198.20.0.0', '2606:2800:220:1:248:1893:25c8:1946'];

test('every documented blocked range is rejected', () => {
  for (const [ip, kind] of BLOCKED) {
    assert.equal(classifyIp(ip), kind, `${ip} should classify as ${kind}`);
    assert.equal(isBlockedIp(ip), true, `${ip} should be blocked`);
  }
});

test('public addresses are allowed', () => {
  for (const ip of ALLOWED) {
    assert.equal(classifyIp(ip), null, `${ip} should be public`);
    assert.equal(isBlockedIp(ip), false, `${ip} should be allowed`);
  }
});

test('boundary addresses inside/outside 172.16/12', () => {
  assert.equal(isBlockedIp('172.15.255.255'), false);
  assert.equal(isBlockedIp('172.16.0.0'), true);
  assert.equal(isBlockedIp('172.31.255.255'), true);
  assert.equal(isBlockedIp('172.32.0.0'), false);
});

test('loopback can be relaxed, private/link-local never', () => {
  assert.equal(isBlockedIp('127.0.0.1', { allowLoopback: true }), false);
  assert.equal(isBlockedIp('::1', { allowLoopback: true }), false);
  assert.equal(isBlockedIp('10.0.0.1', { allowLoopback: true }), true);
  assert.equal(isBlockedIp('169.254.169.254', { allowLoopback: true }), true);
  assert.equal(isBlockedIp('192.168.0.1', { allowLoopback: true }), true);
});

test('garbage input is treated as blocked (fail closed)', () => {
  assert.equal(classifyIp(''), 'invalid');
  assert.equal(classifyIp('not-an-ip'), 'invalid');
  assert.equal(classifyIp(undefined), 'invalid');
  assert.equal(isBlockedIp('999.999.999.999'), true);
});


test('DNS pin lookup: Node asks with all:true and must get an array back', (t, done) => {
  const pins = new Map([['site.example', { ip: '93.184.216.34', family: 4 }]]);
  const lookup = createPinnedLookup(pins);

  // exactly how net.connect calls it: (host, { hints, all: true }, cb)
  lookup('site.example', { hints: 32, all: true }, (err, addresses) => {
    assert.equal(err, null);
    assert.ok(Array.isArray(addresses), 'all:true requires an array, not a scalar');
    assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]);
    done();
  });
});

test('DNS pin lookup: scalar form and 2-argument form still work', (t, done) => {
  const pins = new Map([['v6.example', { ip: '2606:2800::1', family: 6 }]]);
  const lookup = createPinnedLookup(pins);

  lookup('v6.example', { all: false }, (err, address, family) => {
    assert.equal(err, null);
    assert.equal(address, '2606:2800::1');
    assert.equal(family, 6);

    lookup('v6.example', (err2, address2, family2) => {
      assert.equal(err2, null);
      assert.equal(address2, '2606:2800::1');
      assert.equal(family2, 6);
      done();
    });
  });
});

test('DNS pin lookup fails closed when no pin exists', (t, done) => {
  const lookup = createPinnedLookup(new Map());
  lookup('never-validated.example', { all: true }, (err, addresses) => {
    assert.match(err.message, /No DNS pin/);
    assert.deepEqual(addresses, []);
    done();
  });
});
