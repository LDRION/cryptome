import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickCard, stillHere } from '../src/net.ts';

test('the way out is the card with a gateway, never the tunnel', () => {
  assert.equal(pickCard('happ-xray|172.19.0.1\r\nEthernet|192.168.0.100\r\n'), '192.168.0.100');
  assert.equal(pickCard('Wi-Fi|10.0.0.7'), '10.0.0.7');
  assert.equal(pickCard('happ-xray|172.19.0.1\nWireGuard Tunnel|10.8.0.2'), null, 'only tunnels: routing is left alone');
  assert.equal(pickCard(''), null);
  assert.equal(pickCard('Ethernet|fe80::1'), null, 'an IPv4 address only');
});

test('an address that left the computer is noticed', () => {
  assert.equal(stillHere('127.0.0.1'), true);
  assert.equal(stillHere('203.0.113.77'), false);
});
