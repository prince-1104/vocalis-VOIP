// Fixed-destination ingress only. Provider-bearing services remain on an internal
// network with no default route; this process has no credentials or HTTP resolver.
import { createServer, connect } from 'node:net';
import { createSocket } from 'node:dgram';
for (const [port, host, target] of [[3003, 'fixture-api', 3003], [5173, 'frontend', 5173],
  [7880, 'livekit', 7880], [7881, 'livekit', 7881], [55439, 'fixture-db', 5432]]) {
  createServer(client => {
    const upstream = connect({ host, port: target });
    const close = () => { client.destroy(); upstream.destroy(); };
    upstream.on('error', close); client.on('error', close);
    client.on('close', close); upstream.on('close', close);
    client.pipe(upstream).pipe(client);
  }).listen(port, '0.0.0.0');
}
const udp = createSocket('udp4');
const peers = new Map();
udp.on('message', (message, source) => {
  const key = `${source.address}:${source.port}`;
  let peer = peers.get(key);
  if (!peer) {
    if (peers.size >= 32) return;
    const upstream = createSocket('udp4');
    peer = { upstream, seen: Date.now() }; peers.set(key, peer);
    upstream.on('message', data => { udp.send(data, source.port, source.address); });
    upstream.on('error', () => { upstream.close(); peers.delete(key); });
  }
  peer.seen = Date.now(); peer.upstream.send(message, 7882, 'livekit');
});
udp.bind(7882, '0.0.0.0');
setInterval(() => { for (const [key, peer] of peers) if (Date.now() - peer.seen > 30000) { peer.upstream.close(); peers.delete(key); } }, 10000).unref();
