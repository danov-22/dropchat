// Small native WebSocket transport for the Cloudflare room protocol.
export function connectRoom(roomId) {
  const listeners = new Map();
  const pending = new Map();
  let stopped = false, retryTimer, retry = 0, ws;
  const key = `dropchat-session:${roomId}`;
  let token;
  try { token = sessionStorage.getItem(key); } catch (_) {}
  if (!/^[a-f0-9]{64}$/.test(token || '')) {
    token = [...crypto.getRandomValues(new Uint8Array(32))].map(n => n.toString(16).padStart(2, '0')).join('');
    try { sessionStorage.setItem(key, token); } catch (_) {}
  }
  const notify = (event, data) => { for (const fn of listeners.get(event) || []) fn(data); };
  const transport = {
    connected: false,
    on(event, callback) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(callback); },
    removeAllListeners() { listeners.clear(); },
    disconnect() { stopped = true; clearTimeout(retryTimer); transport.connected = false; ws?.close(); rejectPending(); },
    timeout(ms) {
      return { emit(event, data, callback) {
        if (!transport.connected) { callback(new Error('Disconnected')); return; }
        const requestId = crypto.randomUUID();
        const timer = setTimeout(() => { pending.delete(requestId); callback(new Error('No acknowledgement')); }, ms);
        pending.set(requestId, { timer, callback });
        ws.send(JSON.stringify({ event, data, requestId }));
      } };
    }
  };
  function rejectPending() {
    for (const { timer, callback } of pending.values()) { clearTimeout(timer); callback(new Error('Disconnected')); }
    pending.clear();
  }
  function open() {
    if (stopped) return;
    const url = new URL(`/api/rooms/${roomId}/socket`, location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(url);
    const joinTimeout = setTimeout(() => ws.close(), 10000);
    ws.onopen = () => {
      notify('connect');
      ws.send(JSON.stringify({ event: 'room:join', data: { token } }));
    };
    ws.onmessage = ({ data }) => {
      let packet;
      try { packet = JSON.parse(data); } catch { return; }
      if (packet.event === 'chat:ready') { clearTimeout(joinTimeout); transport.connected = true; retry = 0; }
      if (packet.event === 'chat:ack') {
        const item = pending.get(packet.data.requestId);
        if (item) { clearTimeout(item.timer); pending.delete(packet.data.requestId); item.callback(null, packet.data); }
      } else notify(packet.event, packet.data);
    };
    ws.onerror = () => notify('connect_error', new Error('Connection failed'));
    ws.onclose = async ({ code, reason }) => {
      clearTimeout(joinTimeout);
      transport.connected = false;
      rejectPending();
      if (stopped) return;
      if (code === 4004) { stopped = true; notify('room:expired'); return; }
      if (code === 4003) { stopped = true; notify('disconnect'); notify('chat:error', { message: reason }); return; }
      notify('disconnect');
      try {
        const status = await fetch(`/api/rooms/${roomId}`, { cache: 'no-store' });
        if (stopped) return;
        if (status.status === 404) { stopped = true; notify('room:expired'); return; }
      } catch (_) {}
      if (stopped) return;
      retryTimer = setTimeout(open, Math.min(1000 * 2 ** retry++, 15000));
    };
  }
  // Give callers time to attach handlers before connection events arrive.
  queueMicrotask(open);
  return transport;
}
