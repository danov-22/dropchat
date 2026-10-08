import { migrateCustomLinks } from '../scripts/migrate-custom-links.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions, FormData } from 'miniflare';
import { randomBytes, randomUUID } from 'node:crypto';
import { generateRoomSecret, roomAccessToken, roomCommitment, deriveRoomKey, encryptMessage, decryptMessage, encryptAttachment, decryptAttachment, fromBase64, toBase64 } from '../encryption.js';

const origin = 'https://dropchat.test';
function runtime(bindings = {}, legacy = false) {
  return new Miniflare(convertV4MiniflareOptions({ name: 'dropchat', modules: [...(legacy ? [{ type: 'ESModule', path: 'tests/fixtures/legacy-worker.js' }] : []), { type: 'ESModule', path: 'worker.js' }, { type: 'ESModule', path: 'protocol.js' }], compatibilityDate: '2026-04-01', durableObjects: { ROOMS: { className: 'ChatRoom', useSQLite: true } }, r2Buckets: ['FILES'], bindings }));
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
  return { ...room, secret, access, key: await deriveRoomKey(secret, room.encryptionContext) };
}
function request(mf, room, suffix = '', init = {}) {
  return mf.dispatchFetch(`${origin}/api/rooms/${room.roomId}${suffix}`, { ...init, headers: { 'X-Room-Access': room.access, ...init.headers } });
}
async function join(mf, room, token = randomBytes(32).toString('hex'), accessToken = room.access, nickname = '') {
  const response = await request(mf, room, '/socket', { headers: { Upgrade: 'websocket', Origin: origin } });
  assert.equal(response.status, 101);
  const ws = response.webSocket, next = inbox(ws);
  ws.send(JSON.stringify({ event: 'room:join', data: { token, accessToken, nickname } }));
  return { ws, next, token, room, identity: await next('chat:ready') };
}
async function emit(client, data) {
  const requestId = randomUUID();
  client.ws.send(JSON.stringify({ event: 'chat:send', requestId, data }));
  return client.next('chat:ack', p => p.requestId === requestId);
}
async function wire(client, text, attachment = null, clientId = randomUUID()) {
  const context = { roomId: client.room.encryptionContext, clientId, senderId: client.identity.participantId, sender: client.identity.displayName };
  const envelope = await encryptMessage(client.room.key, context, { text, attachment });
  return { envelope, clientId, attachmentId: attachment?.id || null };
}
async function upload(mf, room, content = 'private file contents', name = 'private-name.txt') {
  const encrypted = await encryptAttachment(new File([content], name, { type: 'text/plain' }), room.encryptionContext);
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
    assert.equal((await decryptMessage(room.key, room.encryptionContext, first)).text, 'Never send this plaintext to the server');
    assert.ok(!JSON.stringify(first).includes('Never send this plaintext'));
    assert.equal(first.text, undefined); assert.equal(first.attachment, undefined);
    assert.equal((await emit(a, packet)).ok, true);
    const history = await (await request(mf, room, '/messages')).json();
    assert.equal(history.messages.length, 1);
    assert.deepEqual(history.messages[0].envelope, packet.envelope);
    assert.equal((await (await request(mf, other, '/messages')).json()).messages.length, 0);
    await assert.rejects(decryptMessage(other.key, other.encryptionContext, first));
    const rejoined = await join(mf, room, a.token);
    assert.equal(rejoined.identity.participantId, a.identity.participantId);
    b.ws.close(1000, 'Leaving');
    await c.next('room:presence', p => p.participants.length === 2);
    assert.equal((await emit(c, await wire(c, 'Encrypted reply'))).ok, true);
    assert.equal((await decryptMessage(room.key, room.encryptionContext, await rejoined.next('chat:message', p => p.senderId === c.identity.participantId))).text, 'Encrypted reply');
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
    assert.equal(await (await decryptAttachment(bytes, file.attachment, room.encryptionContext)).text(), 'private file contents');
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


test('optional names persist across joins and name changes preserve authenticated message history', async () => {
 const mf = runtime();
 try {
  const room = await create(mf);
  assert.match(room.roomId, /^[a-f0-9]{16}$/);
  const a = await join(mf, room, undefined, room.access, 'Dan');
  assert.equal(a.identity.displayName, 'Dan');
  const before = await wire(a, 'Before name change');
  assert.equal((await emit(a, before)).ok, true);
  const stored = await a.next('chat:message');
  a.ws.close();
  const b = await join(mf, room, a.token, room.access, 'Robin');
  assert.equal(b.identity.participantId, a.identity.participantId);
  assert.equal(b.identity.displayName, 'Robin');
  assert.equal((await decryptMessage(room.key, room.encryptionContext, stored)).text, 'Before name change');
  b.ws.close();
  const c = await join(mf, room, a.token);
  assert.match(c.identity.displayName, /^Guest /);
  c.ws.close();
  const response = await request(mf, room, '/socket', { headers: { Upgrade: 'websocket', Origin: origin } });
  const socket = response.webSocket; socket.accept();
  const closed = new Promise(resolve => socket.addEventListener('close', resolve, { once: true }));
  socket.send(JSON.stringify({ event: 'room:join', data: { token: randomBytes(32).toString('hex'), accessToken: room.access, nickname: 'x'.repeat(31) } }));
  assert.equal((await closed).code, 4003);
 } finally { await mf.dispose(); }
});


test('custom reusable links have a fixed lifetime, release names, and reject old keys after recreation', async () => {
 const mf = runtime({ ROOM_TTL_SECONDS: '1', CUSTOM_LINK_TTL_SECONDS: '3.5' });
 try {
  const secret = generateRoomSecret(), access = await roomAccessToken(secret);
  const config = { encryptionVersion: 1, keyCommitment: await roomCommitment(secret), customName: 'monthly-crew', reusable: true };
  const make = body => mf.dispatchFetch(`${origin}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const first = await make(config); assert.equal(first.status, 201);
  const room = { ...await first.json(), secret, access };
  const deadline = room.linkExpiresAt;
  assert.ok(deadline > Date.now() && deadline <= Date.now() + 3500);
  const guest = await join(mf, room);
  await upload(mf, room);
  await new Promise(resolve => setTimeout(resolve, 1250));
  const renewed = await (await request(mf, room)).json();
  assert.equal(renewed.linkExpiresAt, deadline);
  assert.notEqual(renewed.encryptionContext, room.encryptionContext);
  await upload(mf, { ...room, encryptionContext: renewed.encryptionContext });
  await new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now()) + 250));
  assert.equal((await request(mf, room)).status, 404);
  assert.equal((await (await mf.getR2Bucket('FILES')).list()).objects.length, 0);
  const freshSecret = generateRoomSecret();
  const recreated = await make({ ...config, keyCommitment: await roomCommitment(freshSecret) });
  assert.equal(recreated.status, 201);
  const fresh = await recreated.json();
  assert.notEqual(fresh.keyCommitment, room.keyCommitment);
  assert.notEqual(fresh.encryptionContext, renewed.encryptionContext);
  assert.ok(fresh.linkExpiresAt > deadline);
  assert.equal((await request(mf, room, '/messages')).status, 403);
  const response = await request(mf, room, '/socket', { headers: { Upgrade: 'websocket', Origin: origin } });
  const ws = response.webSocket; ws.accept();
  const closed = new Promise(resolve => ws.addEventListener('close', resolve, { once: true }));
  ws.send(JSON.stringify({ event: 'room:join', data: { token: guest.token, accessToken: access } }));
  assert.equal((await closed).code, 4003);
  guest.ws.close();
 } finally { await mf.dispose(); }
});

test('legacy dormant custom links receive a shared deadline and alarms even without visits', async () => {
 const rollout = Date.now();
 const migrationToken = 'migration-test-token-with-at-least-32-characters';
 const mf = runtime({ CUSTOM_LINK_TTL_SECONDS: '2', CUSTOM_LINK_LEGACY_STARTED_AT: new Date(rollout).toISOString(), ROOM_MIGRATION_TOKEN: migrationToken }, true);
 try {
  const namespace = await mf.getDurableObjectNamespace('ROOMS');
  const id = namespace.idFromName('forgotten-old-name');
  const stub = namespace.get(id);
  const secret = generateRoomSecret();
  const legacy = { id: 'forgotten-old-name', encryptionVersion: 1, reusable: true, keyCommitment: await roomCommitment(secret), deadline: 0, nextGuest: 1, sequence: 0, bytes: 0 };
  await stub.fetch(`${origin}/__fixture/seed`, { method: 'POST', body: JSON.stringify(legacy) });
  const endpoint = `${origin}/api/maintenance/custom-links`;
  assert.equal((await mf.dispatchFetch(endpoint, { method: 'POST', body: JSON.stringify({ id: id.toString() }) })).status, 404);
  const migrate = () => mf.dispatchFetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${migrationToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id.toString() }) });
  assert.equal((await migrate()).status, 200);
  const first = await (await stub.fetch(`${origin}/__fixture/inspect`)).json();
  assert.equal(first.room.linkExpiresAt, rollout + 2000);
  assert.equal(first.alarm, rollout + 2000);
  await migrate();
  assert.equal((await (await stub.fetch(`${origin}/__fixture/inspect`)).json()).room.linkExpiresAt, first.room.linkExpiresAt);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, rollout + 2000 - Date.now()) + 300));
  const after = await (await stub.fetch(`${origin}/__fixture/inspect`)).json();
  assert.equal(after.count, 0); assert.equal(after.alarm, null);
  const config = { encryptionVersion: 1, keyCommitment: await roomCommitment(generateRoomSecret()), customName: legacy.id, reusable: true };
  assert.equal((await mf.dispatchFetch(`${origin}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) })).status, 201);
 } finally { await mf.dispose(); }
});

test('past-due legacy deleted names are released on creation and stale keys remain invalid', async () => {
 const mf = runtime({ CUSTOM_LINK_TTL_SECONDS: '1', CUSTOM_LINK_LEGACY_STARTED_AT: new Date(Date.now() - 5000).toISOString() }, true);
 try {
  const namespace = await mf.getDurableObjectNamespace('ROOMS');
  const stub = namespace.get(namespace.idFromName('old-deleted-name'));
  const oldSecret = generateRoomSecret();
  await stub.fetch(`${origin}/__fixture/seed`, { method: 'POST', body: JSON.stringify({ id: 'old-deleted-name', encryptionVersion: 1, reusable: true, deleted: true, keyCommitment: await roomCommitment(oldSecret), deadline: 0 }) });
  const config = { encryptionVersion: 1, keyCommitment: await roomCommitment(generateRoomSecret()), customName: 'old-deleted-name', reusable: true };
  const response = await mf.dispatchFetch(`${origin}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
  assert.equal(response.status, 201);
  const room = await response.json();
  assert.equal((await request(mf, { ...room, access: await roomAccessToken(oldSecret) }, '/messages')).status, 403);
 } finally { await mf.dispose(); }
});


test('legacy migration enumerates dormant objects across pages and forwards only authenticated IDs', async () => {
 const env = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'private-cloudflare-token', ROOM_MIGRATION_TOKEN: 'm'.repeat(40), DROPCHAT_URL: 'https://dropchat.test' };
 const objectIds = ['1'.repeat(64), '2'.repeat(64)];
 const migrated = [], logs = [];
 await migrateCustomLinks({ env, log: text => logs.push(text), fetchImpl: async (input, options) => {
  const url = new URL(input);
  if (url.origin === origin) {
   assert.equal(options.headers.Authorization, `Bearer ${env.ROOM_MIGRATION_TOKEN}`);
   assert.equal(url.pathname, '/api/maintenance/custom-links');
   migrated.push(JSON.parse(options.body).id);
   return Response.json({ custom: true });
  }
  assert.equal(url.origin, 'https://api.cloudflare.com');
  assert.equal(options.headers.Authorization, `Bearer ${env.CLOUDFLARE_API_TOKEN}`);
  if (url.pathname.endsWith('/namespaces')) return Response.json({ success: true, result: [{ id: 'b'.repeat(32), script: 'dropchat', class: 'ChatRoom' }], result_info: { total_pages: 1 } });
  assert.ok(url.pathname.endsWith(`${'b'.repeat(32)}/objects`));
  return url.searchParams.has('cursor') ? Response.json({ success: true, result: [{ id: objectIds[1], hasStoredData: true }], result_info: {} }) : Response.json({ success: true, result: [{ id: objectIds[0], hasStoredData: true }, { id: '3'.repeat(64), hasStoredData: false }], result_info: { cursor: 'page-two' } });
 } });
 assert.deepEqual(migrated, objectIds);
 assert.ok(logs.at(-1).includes('Migration complete'));
 assert.ok(!logs.join('').includes(env.ROOM_MIGRATION_TOKEN));
 assert.ok(!logs.join('').includes(env.CLOUDFLARE_API_TOKEN));
});
