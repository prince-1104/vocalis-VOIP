import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { retireUdpPeer } from '../../../deploy/livekit/udp-peer.mjs';

test('UDP error before bind and duplicate eviction leave the gateway alive', () => {
  const peer = { upstream: createSocket('udp4') }, peers = new Map([['peer', peer]]);
  assert.doesNotThrow(() => retireUdpPeer(peers, 'peer', peer));
  assert.equal(peers.size, 0);
  const replacement = {};
  peers.set('peer', replacement);
  assert.doesNotThrow(() => retireUdpPeer(peers, 'peer', peer));
  assert.equal(peers.get('peer'), replacement, 'late old-socket errors cannot evict a replacement');
});

test('UDP cleanup closes a bound socket only once', async () => {
  const socket = createSocket('udp4');
  await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
  const closed = new Promise(resolve => socket.once('close', resolve));
  const peer = { upstream: socket }, peers = new Map([['peer', peer]]);
  retireUdpPeer(peers, 'peer', peer);
  retireUdpPeer(peers, 'peer', peer);
  await closed;
  assert.equal(peers.size, 0);
});
