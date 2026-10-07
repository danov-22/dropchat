import { DurableObject } from 'cloudflare:workers';

const TTL = 24 * 60 * 60 * 1000;
const MAX_FILE = 25 * 1024 * 1024;
const TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime', 'application/pdf', 'application/zip', 'text/plain', 'text/csv']);
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return json({ error: 'Untrusted origin.' }, 403);
    if (request.method === 'POST' && url.pathname === '/api/rooms') {
      const id = crypto.randomUUID().replaceAll('-', '');
      const stub = env.ROOMS.get(env.ROOMS.idFromName(id));
      return stub.fetch(new Request(`${url.origin}/initialize/${id}`, { method: 'POST' }));
    }
    const match = url.pathname.match(/^\/api\/rooms\/([a-f0-9]{32})(\/.*)?$/);
    if (!match) return json({ error: 'Not found.' }, 404);
    return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(request);
  }
};

export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.serial = Promise.resolve();
  }
  // Keep read/modify/write operations ordered even across storage awaits.
  queue(task) {
    const pending = this.serial.then(task);
    this.serial = pending.catch(() => {});
    return pending;
  }
  ttl() { const value = Number(this.env.ROOM_TTL_SECONDS); return value > 0 ? Math.min(value * 1000, TTL) : TTL; }
  async metadata() { return this.ctx.storage.get('room'); }
  open(room) { return room && room.deadline > Date.now(); }
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
        if (await this.metadata()) return json({ error: 'Already exists.' }, 409);
        const room = { id: url.pathname.split('/').pop(), deadline: Date.now() + this.ttl(), nextGuest: 1, sequence: 0, bytes: 0 };
        await this.ctx.storage.put('room', room);
        await this.ctx.storage.setAlarm(room.deadline);
        return json({ roomId: room.id, secondsRemaining: this.ttl() / 1000 }, 201);
      });
    }
    const room = await this.metadata();
    if (!this.open(room)) return json({ error: 'This room has expired.' }, 404);
    const suffix = url.pathname.slice(`/api/rooms/${room.id}`.length);
    if (suffix === '' && request.method === 'GET') return json({ roomId: room.id, secondsRemaining: Math.max(0, Math.ceil((room.deadline - Date.now()) / 1000)) });
    if (suffix === '/messages' && request.method === 'GET') {
      const stored = await this.ctx.storage.list({ prefix: 'message:' });
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
      if (!(file instanceof File) || !file.size || file.size > MAX_FILE || !TYPES.has(file.type)) return json({ error: 'Unsupported file or size (maximum 25 MB).' }, 400);
      return this.queue(async () => {
        const current = await this.metadata();
        if (!this.open(current)) return json({ error: 'This room has expired.' }, 404);
        if (current.bytes + file.size > 100 * 1024 * 1024) return json({ error: 'This room has reached its 100 MB upload limit.' }, 413);
        const id = crypto.randomUUID();
        const key = `${room.id}/${id}`;
        const attachment = { id, url: `/api/rooms/${room.id}/files/${id}`, originalName: file.name.slice(0, 200), mimeType: file.type, size: file.size, previewable: file.type.startsWith('image/') || file.type.startsWith('video/') };
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
      if (!object || !this.open(await this.metadata())) return json({ error: 'File not found.' }, 404);
      return new Response(object.body, { headers: { 'Content-Type': meta.mimeType, 'Content-Length': String(meta.size), 'Content-Disposition': `${meta.previewable ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(meta.originalName)}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" } });
    }
    return json({ error: 'Not found.' }, 404);
  }
  async webSocketMessage(ws, raw) {
    return this.queue(async () => {
      const room = await this.metadata();
      if (!this.open(room)) { this.send(ws, 'room:expired', {}); ws.close(4004, 'Room expired'); return; }
      if (typeof raw !== 'string' || raw.length > 10000) { ws.close(1009, 'Message too large'); return; }
      let packet;
      try { packet = JSON.parse(raw); } catch { ws.close(1003, 'Invalid message'); return; }
      const identity = ws.deserializeAttachment();
      if (packet.event === 'room:join' && !identity.participantId) {
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
        ws.serializeAttachment({ ...participant, lastSent: 0 });
        this.send(ws, 'chat:ready', { ...participant, displayName: participant.name });
        this.presence();
        return;
      }
      if (packet.event !== 'chat:send' || !identity.participantId) return;
      const fail = (error) => this.send(ws, 'chat:ack', { requestId: packet.requestId, ok: false, error });
      const { text, attachment, clientId } = packet.data || {};
      if (!/^[a-f0-9-]{36}$/.test(clientId || '') || typeof text !== 'string' || text.length > 4000) return fail('Invalid message.');
      const duplicate = await this.ctx.storage.get(`sent:${identity.participantId}:${clientId}`);
      if (duplicate) { this.send(ws, 'chat:ack', { requestId: packet.requestId, ok: true }); return; }
      if (Date.now() - identity.lastSent < 400) return fail('Please wait a moment before sending again.');
      let verified = null;
      if (attachment) {
        verified = await this.ctx.storage.get(`file:${attachment.id}`);
        if (!verified) return fail('Invalid attachment.');
      }
      if (!text.trim() && !verified) return fail('Write a message first.');
      if (room.sequence >= 1000) return fail('This room has reached its 1,000 message limit. Start a new room.');
      const message = { sequence: room.sequence + 1, id: crypto.randomUUID(), senderId: identity.participantId, sender: identity.name, text: text.trim(), attachment: verified, createdAt: new Date().toISOString() };
      room.sequence++;
      await this.ctx.storage.put({ [`message:${String(room.sequence).padStart(6, '0')}`]: message, [`sent:${identity.participantId}:${clientId}`]: message.id, room });
      ws.serializeAttachment({ ...identity, lastSent: Date.now() });
      this.broadcast('chat:message', message);
      this.send(ws, 'chat:ack', { requestId: packet.requestId, ok: true });
    });
  }
  webSocketClose(ws, code, reason) { ws.close(code, reason); this.presence(ws); }
  webSocketError(ws) { ws.close(1011, 'Connection error'); this.presence(ws); }
  async alarm() {
    return this.queue(async () => {
      const room = await this.metadata();
      if (!room) return;
      if (this.open(room)) { await this.ctx.storage.setAlarm(room.deadline); return; }
      this.broadcast('room:expired', {});
      for (const ws of this.ctx.getWebSockets()) ws.close(4004, 'Room expired');
      // List by prefix also catches uploads orphaned by a failed metadata write.
      let cursor;
      do {
        const files = await this.env.FILES.list({ prefix: `${room.id}/`, cursor });
        if (files.objects.length) await this.env.FILES.delete(files.objects.map(file => file.key));
        cursor = files.truncated ? files.cursor : undefined;
      } while (cursor);
      await this.ctx.storage.deleteAll();
    });
  }
}
