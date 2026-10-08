import { DurableObject } from 'cloudflare:workers';
import { MAX_FILE_SIZE, UUID, validEnvelope } from './protocol.js';

const TTL = 24 * 60 * 60 * 1000;
const CUSTOM_LINK_TTL = 30 * TTL;
const MAX_FILE = MAX_FILE_SIZE + 16;
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return json({ error: 'Untrusted origin.' }, 403);
    if (request.method === 'POST' && url.pathname === '/api/maintenance/custom-links') {
      if (!env.ROOM_MIGRATION_TOKEN || env.ROOM_MIGRATION_TOKEN.length < 32 || request.headers.get('Authorization') !== `Bearer ${env.ROOM_MIGRATION_TOKEN}`) return json({ error: 'Not found.' }, 404);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid object ID.' }, 400); }
      if (!/^[a-f0-9]{64}$/.test(body?.id || '')) return json({ error: 'Invalid object ID.' }, 400);
      try { return await env.ROOMS.get(env.ROOMS.idFromString(body.id)).fetch(new Request(`${url.origin}/maintenance/custom-links`, { method: 'POST' })); }
      catch { return json({ error: 'Migration failed; retry this object.' }, 503); }
    }
    if (request.method === 'POST' && url.pathname === '/api/rooms') {
      if (Number(request.headers.get('Content-Length')) > 512) return json({ error: 'Invalid room configuration.' }, 400);
      let config;
      try { config = await request.json(); } catch { return json({ error: 'Encrypted room configuration required.' }, 400); }
      if (!config || typeof config !== 'object' || Array.isArray(config) || config.encryptionVersion !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(config.keyCommitment || '') || Object.keys(config).some(key => !['encryptionVersion', 'keyCommitment', 'customName', 'reusable'].includes(key))) return json({ error: 'Encrypted room configuration required.' }, 400);
      if (config.reusable !== undefined && typeof config.reusable !== 'boolean') return json({ error: 'Invalid reusable option.' }, 400);
      if (config.customName !== undefined && (typeof config.customName !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(config.customName) || /^[a-f0-9]{32}$/.test(config.customName))) return json({ error: 'Use 3-40 lowercase letters, numbers or hyphens; start and end with a letter or number.' }, 400);
      const id = config.customName || crypto.randomUUID().replaceAll('-', '').slice(0, 16);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(id));
      return stub.fetch(new Request(`${url.origin}/initialize/${id}`, { method: 'POST', body: JSON.stringify(config) }));
    }
    const match = url.pathname.match(/^\/api\/rooms\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])(\/.*)?$/);
    if (!match) return json({ error: 'Not found.' }, 404);
    return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(request);
  }
};

export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.serial = Promise.resolve();
    ctx.blockConcurrencyWhile(async () => { await this.ensurePolicy(); });
  }
  // Keep read/modify/write operations ordered even across storage awaits.
  queue(task) {
    const pending = this.serial.then(task);
    this.serial = pending.catch(() => {});
    return pending;
  }
  ttl() { const value = Number(this.env.ROOM_TTL_SECONDS); return value > 0 ? Math.min(value * 1000, TTL) : TTL; }
  async authorize(token, room) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token || '')) return false;
    try {
      const raw = Uint8Array.from(atob(token.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
      if (raw.length !== 32) return false;
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
      const commitment = btoa(String.fromCharCode(...digest)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
      return commitment === room.keyCommitment;
    } catch (_) { return false; }
  }
  async metadata() { return this.ctx.storage.get('room'); }
  isCustom(room) { return room && (room.custom === true || (room.custom === undefined && !/^[a-f0-9]{32}$/.test(room.id))); }
  linkTtl() { const seconds = Number(this.env.CUSTOM_LINK_TTL_SECONDS); return seconds > 0 ? Math.min(seconds * 1000, CUSTOM_LINK_TTL) : CUSTOM_LINK_TTL; }
  async ensurePolicy() {
    const room = await this.metadata();
    if (!this.isCustom(room) || room.linkExpiresAt) return room;
    // Older versions did not store creation time. One fixed rollout date prevents
    // forgotten objects receiving a new 30-day lease whenever they are discovered.
    const rollout = Date.parse(this.env.CUSTOM_LINK_LEGACY_STARTED_AT || '2026-10-09T00:00:00+08:00');
    if (!Number.isFinite(rollout)) throw new Error('Invalid legacy custom-link rollout date.');
    room.custom = true;
    room.createdAt = room.createdAt || rollout;
    room.linkExpiresAt = room.createdAt + this.linkTtl();
    if (room.deadline > 0) room.deadline = Math.min(room.deadline, room.linkExpiresAt);
    await this.ctx.storage.put('room', room);
    const due = room.deadline > 0 ? Math.min(room.deadline, room.linkExpiresAt) : room.linkExpiresAt;
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, due));
    return room;
  }
  async prepare() {
    const room = await this.ensurePolicy();
    if (this.isCustom(room) && room.linkExpiresAt <= Date.now()) {
      // Revoke access even if physical file cleanup needs an alarm retry.
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      await this.purge(room, true);
      return null;
    }
    return room;
  }
  open(room) { return room && room.deadline > Date.now() && (!room.linkExpiresAt || room.linkExpiresAt > Date.now()); }
  sameRoom(current, previous) { return this.open(current) && current.keyCommitment === previous.keyCommitment && current.sessionId === previous.sessionId; }
  send(ws, event, data) {
    try { ws.send(JSON.stringify({ event, data })); } catch (_) {}
  }
  broadcast(event, data, excluded = null) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== excluded && ws.deserializeAttachment()?.participantId) this.send(ws, event, data);
    }
  }
  presence(excluded = null) {
    const unique = new Map();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === excluded) continue;
      const identity = ws.deserializeAttachment();
      if (identity?.participantId) unique.set(identity.participantId, { id: identity.participantId, name: identity.name });
    }
    this.broadcast('room:presence', { participants: [...unique.values()] }, excluded);
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/initialize/') && request.method === 'POST') {
      return this.queue(async () => {
        if (await this.prepare()) return json({ error: 'This link name is already taken. Choose another name.' }, 409);
        const config = await request.json();
        const room = { encryptionVersion: 1, custom: Boolean(config.customName), reusable: config.reusable === true, keyCommitment: config.keyCommitment, id: url.pathname.split('/').pop(), sessionId: /^[a-f0-9]{32}$/.test(url.pathname.split('/').pop()) ? url.pathname.split('/').pop() : crypto.randomUUID().replaceAll('-', ''), deadline: Date.now() + this.ttl(), nextGuest: 1, sequence: 0, bytes: 0 };
        room.createdAt = Date.now();
        if (room.custom) { room.linkExpiresAt = room.createdAt + this.linkTtl(); room.deadline = Math.min(room.deadline, room.linkExpiresAt); }
        await this.ctx.storage.put('room', room);
        await this.ctx.storage.setAlarm(room.deadline);
        return json({ roomId: room.id, reusable: room.reusable, linkExpiresAt: room.linkExpiresAt || null, encryptionContext: room.sessionId, encryptionVersion: 1, keyCommitment: room.keyCommitment, secondsRemaining: Math.max(0, Math.ceil((room.deadline - Date.now()) / 1000)) }, 201);
      });
    }
    if (url.pathname === '/maintenance/custom-links' && request.method === 'POST') return this.queue(async () => { const room = await this.prepare(); return json({ processed: true, custom: Boolean(this.isCustom(room)), linkExpiresAt: room?.linkExpiresAt || null }); });
    let room = await this.queue(() => this.prepare());
    if (room?.reusable && !room.deleted && !this.open(room) && request.method === 'GET' && url.pathname === `/api/rooms/${room.id}`) {
      room = await this.queue(async () => {
        const current = await this.metadata();
        if (!current?.reusable || current.deleted || this.open(current) || (current.linkExpiresAt && current.linkExpiresAt <= Date.now())) return current;
        await this.purge(current);
        const next = { ...current, sessionId: crypto.randomUUID().replaceAll('-', ''), deadline: Math.min(Date.now() + this.ttl(), current.linkExpiresAt || Infinity), nextGuest: 1, sequence: 0, bytes: 0 };
        await this.ctx.storage.put('room', next);
        await this.ctx.storage.setAlarm(next.deadline);
        return next;
      });
    }
    if (!this.open(room)) return json({ error: 'This room has expired.' }, 404);
    const suffix = url.pathname.slice(`/api/rooms/${room.id}`.length);
    if (suffix === '' && request.method === 'DELETE') {
      const token = request.headers.get('X-Room-Session');
      if (!/^[a-f0-9]{64}$/.test(token || '')) return json({ error: 'Join the room before deleting it.' }, 403);
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))].map(n => n.toString(16).padStart(2, '0')).join('');
      return this.queue(async () => {
        const current = await this.metadata();
        if (!this.open(current)) return json({ error: 'This room has already closed.' }, 404);
        if (!await this.ctx.storage.get(`participant:${digest}`)) return json({ error: 'Join the room before deleting it.' }, 403);
        // Revoke access first. Keep metadata until storage cleanup succeeds so alarms can retry.
        current.deadline = 0;
        current.deleted = true;
        await this.ctx.storage.put('room', current);
        await this.ctx.storage.setAlarm(Date.now() + 1000);
        try {
          await this.purge(current);
          return json({ deleted: true });
        } catch (_) {
          return json({ deleted: true, cleanupPending: true }, 202);
        }
      });
    }
    if (suffix === '' && request.method === 'GET') return json({ roomId: room.id, reusable: room.reusable === true, linkExpiresAt: room.linkExpiresAt || null, encryptionContext: room.sessionId || room.id, encryptionVersion: room.encryptionVersion || 0, keyCommitment: room.keyCommitment, secondsRemaining: Math.max(0, Math.ceil((room.deadline - Date.now()) / 1000)) });
    if (room.encryptionVersion !== 1) return json({ error: 'This older room does not support encryption. Create a new encrypted room.' }, 409);
    if (suffix !== '/socket' && !await this.authorize(request.headers.get('X-Room-Access'), room)) return json({ error: 'A complete encrypted invite is required.' }, 403);
    if (suffix === '/messages' && request.method === 'GET') {
      const stored = await this.ctx.storage.list({ prefix: 'message:' });
      if (!this.sameRoom(await this.metadata(), room)) return json({ error: 'This room has closed.' }, 404);
      return json({ messages: [...stored.values()] });
    }
    if (suffix === '/socket' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      if (this.ctx.getWebSockets().length >= 50) return json({ error: 'This room is full (50 connections).' }, 429);
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ connectedAt: Date.now() });
      return new Response(null, { status: 101, webSocket: client });
    }
    if (suffix === '/uploads' && request.method === 'POST') {
      const length = Number(request.headers.get('Content-Length'));
      if (!Number.isFinite(length) || length > MAX_FILE + 65536) return json({ error: 'File is too large.' }, 413);
      let form;
      try { form = await request.formData(); } catch { return json({ error: 'Invalid upload.' }, 400); }
      const file = form.get('file');
      const id = form.get('id');
      if (!(file instanceof File) || file.size < 17 || file.size > MAX_FILE || file.type !== 'application/octet-stream' || file.name !== 'encrypted.bin' || !UUID.test(id || '')) return json({ error: 'Only encrypted attachments are accepted (maximum 25 MB plus encryption tag).' }, 400);
      return this.queue(async () => {
        const current = await this.metadata();
        if (!this.sameRoom(current, room)) return json({ error: 'This room has expired.' }, 404);
        if (current.bytes + file.size > 100 * 1024 * 1024) return json({ error: 'This room has reached its 100 MB upload limit.' }, 413);
        if (await this.ctx.storage.get(`file:${id}`)) return json({ error: 'Attachment already exists.' }, 409);
        const key = `${room.id}/${id}`;
        const attachment = { id, size: file.size, encryptionVersion: 1 };
        await this.env.FILES.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
        await this.ctx.storage.put(`file:${id}`, attachment);
        current.bytes += file.size;
        await this.ctx.storage.put('room', current);
        return json(attachment, 201);
      });
    }
    if (/^\/files\/[a-f0-9-]{36}$/.test(suffix) && request.method === 'GET') {
      const id = suffix.split('/').pop();
      const meta = await this.ctx.storage.get(`file:${id}`);
      if (!meta) return json({ error: 'File not found.' }, 404);
      const object = await this.env.FILES.get(`${room.id}/${id}`);
      if (!object || !this.sameRoom(await this.metadata(), room)) return json({ error: 'File not found.' }, 404);
      return new Response(object.body, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(meta.size), 'Content-Disposition': 'attachment; filename="encrypted.bin"', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" } });
    }
    return json({ error: 'Not found.' }, 404);
  }
  async webSocketMessage(ws, raw) {
    return this.queue(async () => {
      const room = await this.prepare();
      if (!this.open(room)) { this.send(ws, 'room:expired', {}); ws.close(4004, 'Room expired'); return; }
      if (room.encryptionVersion !== 1) { this.send(ws, 'chat:error', { message: 'Create a new encrypted room.' }); ws.close(4003, 'Encryption required'); return; }
      if (typeof raw !== 'string' || raw.length > 48000) { ws.close(1009, 'Message too large'); return; }
      let packet;
      try { packet = JSON.parse(raw); } catch { ws.close(1003, 'Invalid message'); return; }
      const identity = ws.deserializeAttachment();
      if (packet.event === 'room:join' && !identity.participantId) {
        if (!await this.authorize(packet.data?.accessToken, room)) { ws.close(4003, 'A complete encrypted invite is required.'); return; }
        const nickname = packet.data?.nickname;
        if (nickname !== undefined && (typeof nickname !== 'string' || nickname.trim().length > 30 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(nickname))) { ws.close(4003, 'Use a name of up to 30 characters without control characters.'); return; }
        const token = packet.data?.token;
        if (!/^[a-f0-9]{64}$/.test(token || '')) { ws.close(1008, 'Invalid session'); return; }
        // Store a hash so the private reconnect token is never broadcast or persisted raw.
        const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))].map(n => n.toString(16).padStart(2, '0')).join('');
        let participant = await this.ctx.storage.get(`participant:${digest}`);
        if (!participant) {
          if (room.nextGuest > 500) { ws.close(4003, 'Room guest limit reached'); return; }
          participant = { participantId: crypto.randomUUID(), name: `Guest ${room.nextGuest++}` };
          await this.ctx.storage.put(`participant:${digest}`, participant);
          await this.ctx.storage.put('room', room);
        }
        participant.guestName ||= participant.name;
        participant.name = nickname?.trim() || participant.guestName;
        await this.ctx.storage.put(`participant:${digest}`, participant);
        ws.serializeAttachment({ ...participant, roomSession: room.sessionId || room.id, lastSent: 0 });
        this.send(ws, 'chat:ready', { ...participant, displayName: participant.name });
        this.presence();
        return;
      }
      if (packet.event !== 'chat:send' || !identity.participantId) return;
      if (identity.roomSession && identity.roomSession !== (room.sessionId || room.id)) { ws.close(4004, 'Room expired'); return; }
      const fail = (error) => this.send(ws, 'chat:ack', { requestId: packet.requestId, ok: false, error });
      const { envelope, attachmentId = null, clientId } = packet.data || {};
      if (!UUID.test(clientId || '') || !validEnvelope(envelope) || Object.keys(packet.data).some(key => !['envelope', 'attachmentId', 'clientId'].includes(key))) return fail('Only encrypted messages are accepted.');
      const duplicate = await this.ctx.storage.get(`sent:${identity.participantId}:${clientId}`);
      if (duplicate) { this.send(ws, 'chat:ack', { requestId: packet.requestId, ok: true }); return; }
      if (Date.now() - identity.lastSent < 400) return fail('Please wait a moment before sending again.');
      if (attachmentId !== null && (!UUID.test(attachmentId) || !await this.ctx.storage.get(`file:${attachmentId}`))) return fail('Invalid encrypted attachment.');
      if (room.sequence >= 1000) return fail('This room has reached its 1,000 message limit. Start a new room.');
      const message = { sequence: room.sequence + 1, id: crypto.randomUUID(), senderId: identity.participantId, sender: identity.name, clientId, envelope, attachmentId, createdAt: new Date().toISOString() };
      room.sequence++;
      await this.ctx.storage.put({ [`message:${String(room.sequence).padStart(6, '0')}`]: message, [`sent:${identity.participantId}:${clientId}`]: message.id, room });
      ws.serializeAttachment({ ...identity, lastSent: Date.now() });
      this.broadcast('chat:message', message);
      this.send(ws, 'chat:ack', { requestId: packet.requestId, ok: true });
    });
  }
  webSocketClose(ws, code, reason) { ws.close(code, reason); this.presence(ws); }
  webSocketError(ws) { ws.close(1011, 'Connection error'); this.presence(ws); }
  async purge(room, release = false) {
    this.broadcast(room.deleted ? 'room:deleted' : 'room:expired', { linkExpired: release });
    for (const ws of this.ctx.getWebSockets()) ws.close(4004, release ? 'Invite expired' : room.deleted ? 'Room deleted' : 'Room expired');
    // List by prefix also catches uploads orphaned by a failed metadata write.
    let cursor;
    do {
      const files = await this.env.FILES.list({ prefix: `${room.id}/`, cursor });
      if (files.objects.length) await this.env.FILES.delete(files.objects.map(file => file.key));
      cursor = files.truncated ? files.cursor : undefined;
    } while (cursor);
    await this.ctx.storage.deleteAll();
    // Keep custom reservations only until their fixed 30-day deadline.
    const retain = !release && (room.reusable || this.isCustom(room));
    if (retain) await this.ctx.storage.put('room', { ...room, deadline: 0, nextGuest: 1, sequence: 0, bytes: 0 });
    if (retain && room.linkExpiresAt) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, room.linkExpiresAt));
    else await this.ctx.storage.deleteAlarm();
  }
  async alarm() {
    return this.queue(async () => {
      const room = await this.prepare();
      if (!room) return;
      if (this.open(room)) { await this.ctx.storage.setAlarm(room.deadline); return; }
      await this.purge(room);
    });
  }
}
