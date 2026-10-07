import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions, FormData } from 'miniflare';
import { randomBytes, randomUUID } from 'node:crypto';

const origin = 'https://dropchat.test';
function runtime(bindings = {}) {
  return new Miniflare(convertV4MiniflareOptions({ name: 'dropchat', modules: true, scriptPath: 'worker.js', compatibilityDate: '2026-04-01', durableObjects: { ROOMS: { className: 'ChatRoom', useSQLite: true } }, r2Buckets: ['FILES'], bindings }));
}
function inbox(ws) {
  const packets = [], waiters = [];
  ws.accept();
  ws.addEventListener('message', ({ data }) => {
    const packet = JSON.parse(data);
    const index = waiters.findIndex(w => w.event === packet.event && w.predicate(packet.data));
    if (index < 0) packets.push(packet);
    else { const [waiter] = waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(packet.data); }
  });
  return (event, predicate = () => true) => {
    const index = packets.findIndex(p => p.event === event && predicate(p.data));
    if (index >= 0) return Promise.resolve(packets.splice(index, 1)[0].data);
    return new Promise((resolve, reject) => {
      const entry = { event, predicate, resolve, timer: setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 5000) };
      waiters.push(entry);
    });
  };
}
async function create(mf) { const response = await mf.dispatchFetch(`${origin}/api/rooms`, { method: 'POST' }); assert.equal(response.status, 201); return response.json(); }
async function join(mf, roomId, token = randomBytes(32).toString('hex')) {
  const response = await mf.dispatchFetch(`${origin}/api/rooms/${roomId}/socket`, { headers: { Upgrade: 'websocket', Origin: origin } });
  assert.equal(response.status, 101);
  const ws = response.webSocket, next = inbox(ws);
  ws.send(JSON.stringify({ event: 'room:join', data: { token } }));
  return { ws, next, token, identity: await next('chat:ready') };
}
async function send(client, text, options = {}) {
  const requestId = randomUUID();
  client.ws.send(JSON.stringify({ event: 'chat:send', requestId, data: { text, clientId: randomUUID(), ...options } }));
  return client.next('chat:ack', p => p.requestId === requestId);
}

test('shared links support group chat, isolation, reconnect, uploads and validation', async () => {
  const mf = runtime();
  try {
    const room = await create(mf), other = await create(mf);
    assert.match(room.roomId, /^[a-f0-9]{32}$/);
    const a = await join(mf, room.roomId), b = await join(mf, room.roomId), c = await join(mf, room.roomId), outsider = await join(mf, other.roomId);
    assert.equal(new Set([a.identity.participantId, b.identity.participantId, c.identity.participantId]).size, 3);
    assert.equal((await a.next('room:presence', p => p.participants.length === 3)).participants.length, 3);
    const clientId = randomUUID();
    assert.equal((await send(a, 'Hello group!', { clientId })).ok, true);
    const first = await a.next('chat:message');
    assert.equal((await b.next('chat:message')).id, first.id);
    assert.equal((await c.next('chat:message')).id, first.id);
    assert.equal(first.senderId, a.identity.participantId);
    assert.equal((await send(a, 'Hello group!', { clientId })).ok, true);
    let history = await (await mf.dispatchFetch(`${origin}/api/rooms/${room.roomId}/messages`)).json();
    assert.equal(history.messages.length, 1, 'acknowledgement retry must not duplicate messages');
    const isolated = await (await mf.dispatchFetch(`${origin}/api/rooms/${other.roomId}/messages`)).json();
    assert.equal(isolated.messages.length, 0);
    const rejoined = await join(mf, room.roomId, a.token);
    assert.equal(rejoined.identity.participantId, a.identity.participantId);
    assert.equal(rejoined.identity.displayName, a.identity.displayName);
    b.ws.close(1000, 'Leaving');
    await c.next('room:presence', p => p.participants.length === 2);
    assert.equal((await send(c, 'Group reply')).ok, true);
    assert.equal((await rejoined.next('chat:message', p => p.text === 'Group reply')).senderId, c.identity.participantId);
    assert.equal((await send(outsider, 'x'.repeat(4001))).ok, false);
    assert.equal((await send(outsider, 'Forged file', { attachment: { id: randomUUID(), url: 'javascript:alert(1)' } })).ok, false);
    const form = new FormData(); form.append('file', new File(['group file'], 'hello.txt', { type: 'text/plain' }));
    const uploaded = await mf.dispatchFetch(`${origin}/api/rooms/${room.roomId}/uploads`, { method: 'POST', body: form });
    assert.equal(uploaded.status, 201, uploaded.status === 201 ? '' : await uploaded.text());
    const attachment = await uploaded.json();
    assert.equal(await (await mf.dispatchFetch(`${origin}${attachment.url}`)).text(), 'group file');
    assert.equal((await mf.dispatchFetch(`${origin}/api/rooms/${other.roomId}/files/${attachment.id}`)).status, 404);
    assert.equal((await send(outsider, 'Cross-room file', { attachment })).ok, false);
    assert.equal((await mf.dispatchFetch(`${origin}/api/rooms`, { method: 'POST', headers: { Origin: 'https://evil.test' } })).status, 403);
    const invalid = await mf.dispatchFetch(`${origin}/api/rooms/invalid`); assert.equal(invalid.status, 404);
    for (const client of [a, c, outsider, rejoined]) client.ws.close();
  } finally { await mf.dispose(); }
});

test('expiry closes all guests and removes history and private files', async () => {
  const mf = runtime({ ROOM_TTL_SECONDS: '2' });
  try {
    const room = await create(mf);
    const a = await join(mf, room.roomId), b = await join(mf, room.roomId);
    assert.equal((await send(a, 'Temporary message')).ok, true);
    const form = new FormData(); form.append('file', new File(['temporary'], 'expiry.txt', { type: 'text/plain' }));
    const attachment = await (await mf.dispatchFetch(`${origin}/api/rooms/${room.roomId}/uploads`, { method: 'POST', body: form })).json();
    await Promise.all([a.next('room:expired'), b.next('room:expired')]);
    assert.equal((await mf.dispatchFetch(`${origin}/api/rooms/${room.roomId}/messages`)).status, 404);
    assert.equal((await mf.dispatchFetch(`${origin}${attachment.url}`)).status, 404);
    const bucket = await mf.getR2Bucket('FILES');
    // Alarm performs deletion after broadcasting expiry; wait briefly for completion.
    for (let attempt = 0; attempt < 20 && (await bucket.list()).objects.length; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal((await bucket.list()).objects.length, 0);
  } finally { await mf.dispose(); }
});

test('browser transport sends and acknowledges messages using native WebSockets', async () => {
  const mf = runtime();
  const { connectRoom } = await import('../live-room.js');
  const clients = [];
  const previousLocation = globalThis.location;
  const previousStorage = globalThis.sessionStorage;
  try {
    const base = await mf.ready;
    globalThis.location = { href: base.href, protocol: base.protocol, origin: base.origin };
    const room = await (await fetch(new URL('/api/rooms', base), { method: 'POST' })).json();
    const listen = (client, event) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Transport timed out: ${event}`)), 5000);
      client.on(event, value => { clearTimeout(timer); resolve(value); });
    });
    const open = async () => {
      // Simulate separate browser tab storage.
      const stored = new Map();
      globalThis.sessionStorage = { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) };
      const client = connectRoom(room.roomId);
      clients.push(client);
      const identity = await listen(client, 'chat:ready');
      return { client, identity };
    };
    const a = await open(), b = await open();
    assert.notEqual(a.identity.participantId, b.identity.participantId);
    assert.equal(a.client.connected, true);
    const delivered = listen(b.client, 'chat:message');
    const result = await new Promise((resolve, reject) => a.client.timeout(5000).emit('chat:send', { text: 'Native group transport', clientId: randomUUID() }, (error, ack) => error ? reject(error) : resolve(ack)));
    assert.equal(result.ok, true);
    assert.equal((await delivered).text, 'Native group transport');
  } finally {
    clients.forEach(client => client.disconnect());
    globalThis.location = previousLocation;
    globalThis.sessionStorage = previousStorage;
    await mf.dispose();
  }
});
