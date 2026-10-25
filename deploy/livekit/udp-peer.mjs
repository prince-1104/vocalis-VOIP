// UDP DNS/send errors can arrive before bind, or after idle eviction.
export function retireUdpPeer(peers, key, peer) {
  if (peers.get(key) === peer) peers.delete(key);
  if (peer.closed) return;
  peer.closed = true;
  try { peer.upstream.close(); }
  catch (error) { if (error.code !== 'ERR_SOCKET_DGRAM_NOT_RUNNING') throw error; }
}
