import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions, FormData } from 'miniflare';
import { randomBytes, randomUUID } from 'node:crypto';
import { generateRoomSecret, roomAccessToken, roomCommitment, deriveRoomKey, encryptMessage, decryptMessage, encryptAttachment, decryptAttachment, fromBase64, toBase64 } from '../encryption.js';

const origin = 'https://dropchat.test';
function runtime(bindings = {}) {
  return new Miniflare(convertV4MiniflareOptions({ name: 'dropchat', modules: [{ type: 'ESModule', path: 'worker.js' }, { type: 'ESModule', path: 'protocol.js' }], compatibilityDate: '2026-04-01', durableObjects: { ROOMS: { className: 'ChatRoom', useSQLite: true } }, r2Buckets: ['FILES'], bindings }));
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
    return new Promise((resolve, reject) => { waiters.push({ event, predicate, resolve, timer: setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 5000) }); });
  };
}
async function create(mf) {
  const secret = generateRoomSecret(), access = await roomAccessToken(secret);
  const response = await mf.dispatchFetch(`${origin}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ encryptionVersion: 1, keyCommitment: await roomCommitment(secret) }) });
  assert.equal(response.status, 201);
  const room = await response.json();
  return { ...room, secret, access, key: await deriveRoomKey(secret, room.roomId) };
}
function request(mf, room, suffix = '', init = {}) {
  return mf.dispatchFetch(`${origin}/api/rooms/${room.roomId}${suffix}`, { ...init, headers: { 'X-Room-Access': room.access, ...init.headers } });
}
async function join(mf, room, token = randomBytes(32).toString('hex'), accessToken = room.access) {
  const response = await request(mf, room, '/socket', { headers: { Upgrade: 'websocket', Origin: origin } });
  assert.equal(response.status, 101);
  const ws = response.webSocket, next = inbox(ws);
  ws.send(JSON.stringify({ event: 'room:join', data: { token, accessToken } }));
  return { ws, next, token, room, identity: await next('chat:ready') };
}
async function emit(client, data) {
  const requestId = randomUUID();
  client.ws.send(JSON.stringify({ event: 'chat:send', requestId, data }));
  return client.next('chat:ack', p => p.requestId === requestId);
}
async function wire(client, text, attachment = null, clientId = randomUUID()) {
  const context = { roomId: client.room.roomId, clientId, senderId: client.identity.participantId, sender: client.identity.displayName };
  const envelope = await encryptMessage(client.room.key, context, { text, attachment });
  return { envelope, clientId, attachmentId: attachment?.id || null };
}
async function upload(mf, room, content = 'private file contents', name = 'private-name.txt') {
  const encrypted = await encryptAttachment(new File([content], name, { type: 'text/plain' }), room.roomId);
  const form = new FormData(); form.append('id', encrypted.attachment.id); form.append('file', encrypted.blob, 'encrypted.bin');
  const response = await request(mf, room, '/uploads', { method: 'POST', body: form });
  assert.equal(response.status, 201);
  return encrypted;
}

test('AES-GCM round trips, fresh IVs and binding reject wrong keys and tampering', async () => {
  const secret = generateRoomSecret(), roomId = randomUUID().replaceAll('-', '');
  assert.equal(fromBase64(secret, 32).length, 32);
  const key = await deriveRoomKey(secret, roomId);
  assert.equal(key.extractable, false);
  const context = { roomId, clientId: randomUUID(), senderId: randomUUID(), sender: 'Guest 1' };
  const payload = { text: 'Private conversation with unicode: \u2728\u4f60\u597d', attachment: null };
  const envelope = await encryptMessage(key, context, payload);
  const message = { ...context, envelope, attachmentId: null };
  assert.deepEqual(await decryptMessage(key, roomId, message), payload);
  assert.notEqual((await encryptMessage(key, context, payload)).iv, envelope.iv);
  await assert.rejects(decryptMessage(await deriveRoomKey(generateRoomSecret(), roomId), roomId, message));
  await assert.rejects(decryptMessage(key, randomUUID().replaceAll('-', ''), message));
  await assert.rejects(decryptMessage(key, roomId, { ...message, sender: 'Guest 2' }));
  await assert.rejects(decryptMessage(key, roomId, { ...message, clientId: randomUUID() }));
  const changed = fromBase64(envelope.ciphertext); changed[0] ^= 1;
  await assert.rejects(decryptMessage(key, roomId, { ...message, envelope: { ...envelope, ciphertext: toBase64(changed) } }));
  await assert.rejects(encryptMessage(key, context, { text: 'x'.repeat(4001) }));
  const file = await encryptAttachment(new File(['secret file'], 'secret.txt', { type: 'text/plain' }), roomId);
  const bytes = await file.blob.arrayBuffer();
  assert.equal(await (await decryptAttachment(bytes, file.attachment, roomId)).text(), 'secret file');
  await assert.rejects(decryptAttachment(bytes, file.attachment, randomUUID().replaceAll('-', '')));
  const corrupt = new Uint8Array(bytes); corrupt[0] ^= 1;
  await assert.rejects(decryptAttachment(corrupt, file.attachment, roomId));
});

test('encrypted group chat preserves history, isolation, identity, presence and deduplication', async () => {
  const mf = runtime();
  try {
    const room = await create(mf), other = await create(mf);
    const a = await join(mf, room), b = await join(mf, room), c = await join(mf, room), outsider = await join(mf, other);
    assert.equal(new Set([a.identity.participantId, b.identity.participantId, c.identity.participantId]).size, 3);
    await a.next('room:presence', p => p.participants.length === 3);
    const packet = await wire(a, 'Never send this plaintext to the server');
    assert.equal((await emit(a, packet)).ok, true);
    const first = await a.next('chat:message');
    assert.equal((await b.next('chat:message')).id, first.id);
    assert.equal((await c.next('chat:message')).id, first.id);
    assert.equal((await decryptMessage(room.key, room.roomId, first)).text, 'Never send this plaintext to the server');
    assert.ok(!JSON.stringify(first).includes('Never send this plaintext'));
    assert.equal(first.text, undefined); assert.equal(first.attachment, undefined);
    assert.equal((await emit(a, packet)).ok, true);
    const history = await (await request(mf, room, '/messages')).json();
    assert.equal(history.messages.length, 1);
    assert.deepEqual(history.messages[0].envelope, packet.envelope);
    assert.equal((await (await request(mf, other, '/messages')).json()).messages.length, 0);
    await assert.rejects(decryptMessage(other.key, other.roomId, first));
    const rejoined = await join(mf, room, a.token);
    assert.equal(rejoined.identity.participantId, a.identity.participantId);
    b.ws.close(1000, 'Leaving');
    await c.next('room:presence', p => p.participants.length === 2);
    assert.equal((await emit(c, await wire(c, 'Encrypted reply'))).ok, true);
    assert.equal((await decryptMessage(room.key, room.roomId, await rejoined.next('chat:message', p => p.senderId === c.identity.participantId))).text, 'Encrypted reply');
    assert.equal((await emit(outsider, { text: 'Plaintext rejected', clientId: randomUUID() })).ok, false);
    const invalidFile = await wire(outsider, 'Forged file'); invalidFile.attachmentId = randomUUID();
    assert.equal((await emit(outsider, invalidFile)).ok, false);
    for (const client of [a, c, outsider, rejoined]) client.ws.close();
  } finally { await mf.dispose(); }
});

test('only encrypted files and complete-invite access are accepted; ciphertext has no filename', async () => {
  const mf = runtime();
  try {
    const room = await create(mf), other = await create(mf);
    const a = await join(mf, room);
    const file = await upload(mf, room);
    const response = await request(mf, room, `/files/${file.attachment.id}`);
    assert.equal(response.headers.get('Content-Type'), 'application/octet-stream');
    assert.ok(!response.headers.get('Content-Disposition').includes('private-name'));
    const bytes = await response.arrayBuffer();
    assert.ok(!new TextDecoder().decode(bytes).includes('private file contents'));
    assert.equal(await (await decryptAttachment(bytes, file.attachment, room.roomId)).text(), 'private file contents');
    const bucket = await mf.getR2Bucket('FILES');
    const object = await bucket.get(`${room.roomId}/${file.attachment.id}`);
    assert.deepEqual(new Uint8Array(await object.arrayBuffer()), new Uint8Array(bytes));
    assert.equal((await emit(a, await wire(a, 'Encrypted file attached', file.attachment))).ok, true);
    const historyText = await (await request(mf, room, '/messages')).text();
    for (const secret of ['private-name.txt', 'private file contents', file.attachment.key, file.attachment.iv]) assert.ok(!historyText.includes(secret));
    assert.equal((await request(mf, other, `/files/${file.attachment.id}`)).status, 404);
    assert.equal((await mf.dispatchFetch(`${origin}/api/rooms/${room.roomId}/messages`)).status, 403);
    assert.equal((await request(mf, room, '/messages', { headers: { 'X-Room-Access': other.access } })).status, 403);
    const form = new FormData(); form.append('id', randomUUID()); form.append('file', new File(['plaintext'], 'secret.txt', { type: 'text/plain' }));
    assert.equal((await request(mf, room, '/uploads', { method: 'POST', body: form })).status, 400);
    assert.equal((await mf.dispatchFetch(`${origin}/api/rooms`, { method: 'POST' })).status, 400);
    const denied = await request(mf, room, '/socket', { headers: { Upgrade: 'websocket' } });
    const next = inbox(denied.webSocket);
    const closed = new Promise(resolve => denied.webSocket.addEventListener('close', resolve));
    denied.webSocket.send(JSON.stringify({ event: 'room:join', data: { token: randomBytes(32).toString('hex'), accessToken: other.access } }));
    assert.equal((await closed).code, 4003);
    a.ws.close();
  } finally { await mf.dispose(); }
});

test('expiry and confirmed deletion remove encrypted history/files and revoke every guest', async () => {
  for (const manual of [false, true]) {
    const mf = runtime(manual ? {} : { ROOM_TTL_SECONDS: '2' });
    try {
      const room = await create(mf), other = await create(mf);
      const a = await join(mf, room), b = await join(mf, room), outsider = await join(mf, other);
      await emit(a, await wire(a, 'Temporary encrypted message'));
      const file = await upload(mf, room);
      if (manual) {
        assert.equal((await request(mf, room, '', { method: 'DELETE' })).status, 403);
        assert.equal((await request(mf, room, '', { method: 'DELETE', headers: { 'X-Room-Session': outsider.token } })).status, 403);
        assert.equal((await request(mf, room, '', { method: 'DELETE', headers: { Origin: 'https://evil.test', 'X-Room-Session': b.token } })).status, 403);
        const response = await request(mf, room, '', { method: 'DELETE', headers: { 'X-Room-Session': b.token } });
        assert.equal(response.status, 200); assert.deepEqual(await response.json(), { deleted: true });
      }
      await Promise.all([a.next(manual ? 'room:deleted' : 'room:expired'), b.next(manual ? 'room:deleted' : 'room:expired')]);
      for (const suffix of ['', '/messages', `/files/${file.attachment.id}`]) assert.equal((await request(mf, room, suffix)).status, 404);
      const bucket = await mf.getR2Bucket('FILES');
      for (let i = 0; i < 20 && (await bucket.list({ prefix: `${room.roomId}/` })).objects.length; i++) await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal((await bucket.list({ prefix: `${room.roomId}/` })).objects.length, 0);
      if (manual) assert.equal((await request(mf, other)).status, 200);
      outsider.ws.close();
    } finally { await mf.dispose(); }
  }
});


test('custom reusable invites reset history and keys per chat, reserve names and stay disabled after deletion', async () => {
  const mf = runtime({ ROOM_TTL_SECONDS: '1' });
  try {
    const secret = generateRoomSecret(), access = await roomAccessToken(secret);
    const config = { encryptionVersion: 1, keyCommitment: await roomCommitment(secret), customName: 'weekend-crew', reusable: true };
    const make = body => mf.dispatchFetch(`${origin}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    for (const customName of ['ab', '../escape', 'UPPER', 'ends-', 'a'.repeat(41), 'a'.repeat(32)]) assert.equal((await make({ ...config, customName })).status, 400);
    assert.equal((await make({ ...config, reusable: 'yes' })).status, 400);
    const created = await make(config);
    assert.equal(created.status, 201);
    const metadata = await created.json();
    const room = { ...metadata, secret, access, key: await deriveRoomKey(secret, metadata.encryptionContext) };
    assert.equal(room.roomId, 'weekend-crew');
    const first = await join(mf, room);
    const priorId = randomUUID();
    const prior = { clientId: priorId, attachmentId: null, envelope: await encryptMessage(room.key, { roomId: room.encryptionContext, clientId: priorId, senderId: first.identity.participantId, sender: first.identity.displayName }, { text: 'old private chat', attachment: null }) };
    assert.equal((await emit(first, prior)).ok, true);
    const file = await upload(mf, room);
    assert.equal((await make(config)).status, 409);
    await new Promise(resolve => setTimeout(resolve, 1250));
    const responses = await Promise.all([request(mf, room), request(mf, room)]);
    const [next, concurrent] = await Promise.all(responses.map(r => r.json()));
    assert.equal(next.reusable, true);
    assert.equal(next.encryptionContext, concurrent.encryptionContext);
    assert.notEqual(next.encryptionContext, room.roomId);
    assert.equal(next.keyCommitment, config.keyCommitment);
    assert.deepEqual((await (await request(mf, room, '/messages')).json()).messages, []);
    assert.equal((await request(mf, room, `/files/${file.attachment.id}`)).status, 404);
    assert.equal((await (await mf.getR2Bucket('FILES')).list()).objects.length, 0);
    const key = await deriveRoomKey(secret, next.encryptionContext);
    await assert.rejects(decryptMessage(key, next.encryptionContext, { ...prior, senderId: first.identity.participantId, sender: first.identity.displayName }));
    const second = await join(mf, room);
    const clientId = randomUUID();
    const envelope = await encryptMessage(key, { roomId: next.encryptionContext, clientId, senderId: second.identity.participantId, sender: second.identity.displayName }, { text: 'fresh private chat', attachment: null });
    assert.equal((await emit(second, { envelope, clientId, attachmentId: null })).ok, true);
    const fresh = await second.next('chat:message');
    assert.equal((await decryptMessage(key, next.encryptionContext, fresh)).text, 'fresh private chat');
    assert.equal((await request(mf, room, '', { method: 'DELETE', headers: { 'X-Room-Session': second.token } })).status, 200);
    assert.equal((await request(mf, room)).status, 404);
    assert.equal((await make(config)).status, 409);
    first.ws.close(); second.ws.close();
  } finally { await mf.dispose(); }
});

test('custom one-time names remain reserved after expiry', async () => {
  const mf = runtime({ ROOM_TTL_SECONDS: '1' });
  try {
    const body = JSON.stringify({ encryptionVersion: 1, keyCommitment: await roomCommitment(generateRoomSecret()), customName: 'one-time-room', reusable: false });
    const make = () => mf.dispatchFetch(`${origin}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal((await make()).status, 201);
    await new Promise(resolve => setTimeout(resolve, 1250));
    assert.equal((await mf.dispatchFetch(`${origin}/api/rooms/one-time-room`)).status, 404);
    assert.equal((await make()).status, 409);
  } finally { await mf.dispose(); }
});
