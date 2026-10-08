import { connectRoom } from "./live-room.js";
import { generateRoomSecret, roomAccessToken, roomCommitment, deriveRoomKey, encryptMessage, decryptMessage, encryptAttachment, decryptAttachment } from "./encryption.js";

/* DropChat's small client: URL state, REST room lifecycle, uploads, and live messages. */
(() => {
  "use strict";

  const homeView = document.getElementById("home-view");
  const roomView = document.getElementById("room-view");
  const expiredView = document.getElementById("expired-view");
  const createButton = document.getElementById("create-room");
  const newRoomButton = document.getElementById("new-room");
  const homeStatus = document.getElementById("home-status");
  const shareButton = document.getElementById("share-room");
  const leaveButton = document.getElementById("leave-room");
  const countdown = document.getElementById("countdown");
  const roomCode = document.getElementById("room-code");
  const messages = document.getElementById("messages");
  const messageState = document.getElementById("message-state");
  const connectionDot = document.getElementById("connection-dot");
  const connectionLabel = document.getElementById("connection-label");
  const messageForm = document.getElementById("message-form");
  const messageInput = document.getElementById("message-input");
  const sendButton = document.getElementById("send-message");
  const attachButton = document.getElementById("attach-file");
  const fileInput = document.getElementById("file-input");
  const attachmentPending = document.getElementById("attachment-pending");
  const pendingName = document.getElementById("pending-name");
  const removeAttachmentButton = document.getElementById("remove-attachment");
  const uploadStatus = document.getElementById("upload-status");
  const uploadFilename = document.getElementById("upload-filename");
  const uploadPercent = document.getElementById("upload-percent");
  const uploadProgress = document.getElementById("upload-progress");
  const cancelUploadButton = document.getElementById("cancel-upload");
  const deleteButton = document.getElementById("delete-room");
  const deleteDialog = document.getElementById("delete-dialog");
  const confirmDelete = document.getElementById("confirm-delete");
  const cancelDelete = document.getElementById("cancel-delete");
  const deleteError = document.getElementById("delete-error");
  let deleting = false;
  const toast = document.getElementById("toast");

  // Keep the most recent invite only in this tab. Never send its key to the relay.
  let lastInvite = null;
  let preferredName = '';
  try { lastInvite = sessionStorage.getItem('dropchat-last-invite'); preferredName = sessionStorage.getItem('dropchat-name') || ''; } catch (_) {}
  const nameInput = document.getElementById('display-name');
  nameInput.value = preferredName;
  function saveName(value) {
    preferredName = value.trim();
    nameInput.value = preferredName;
    try { sessionStorage.setItem('dropchat-name', preferredName); } catch (_) {}
  }
  function parseInvite(value) {
    const url = new URL(value, location.origin);
    if (url.origin !== location.origin || url.pathname !== '/') throw new Error('Use a complete invite for this DropChat site.');
    const compact = url.hash.slice(1).match(/^([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\.([A-Za-z0-9_-]{43})$/);
    const id = compact?.[1] || url.searchParams.get('room');
    const secret = compact?.[2] || new URLSearchParams(url.hash.slice(1)).get('key');
    if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(id || '')) throw new Error('Paste a valid room invite.');
    return { id, secret };
  }
  function compactInvite(id, secret) { return `${location.origin}/#${id}.${secret}`; }
  function rememberInvite(id, secret) {
    lastInvite = compactInvite(id, secret);
    try { sessionStorage.setItem('dropchat-last-invite', lastInvite); } catch (_) {}
    updateRejoin();
  }
  function updateRejoin() {
    let valid = false;
    try { valid = Boolean(lastInvite && parseInvite(lastInvite).secret); } catch (_) {}
    document.getElementById('rejoin-room').classList.toggle('is-hidden', !valid);
    document.getElementById('rejoin-note').classList.toggle('is-hidden', !valid);
  }
  updateRejoin();
  const MAX_FILE_SIZE = 25 * 1024 * 1024;
  let roomId = null;
  let encryptionContext = null;
  let reusableRoom = false;
  let linkDeadline = 0;
  let roomKey = null;
  let roomAccess = null;
  let receiveQueue = Promise.resolve();
  const decryptedUrls = new Set();
  let displayName = "";
  let participantId = "";
  let generation = 0;
  let sending = false;
  let retryMessage = null;
  let socket = null;
  let roomDeadline = 0;
  let countdownTimer = null;
  let linkExpiryTimer = null;
  let toastTimer = null;
  let activeUpload = null;
  let selectedFile = null;
  let expired = false;
  const seenMessages = new Set();

  // The API tells us how many seconds remain; use that value as the clock baseline.
  function watchLinkExpiry() {
    clearTimeout(linkExpiryTimer);
    if (!linkDeadline) return;
    // Browsers cap setTimeout near 24.8 days; a 30-day invite needs a second hop.
    linkExpiryTimer = window.setTimeout(() => {
      if (Date.now() >= linkDeadline) showExpired('link-expired');
      else watchLinkExpiry();
    }, Math.min(Math.max(1, linkDeadline - Date.now()), 2147483647));
  }

  function setRoomDeadline(room) {
    const seconds = Number(room.secondsRemaining);
    roomDeadline = Date.now() + Math.max(0, seconds) * 1000;
    watchLinkExpiry();
    renderCountdown();
    clearInterval(countdownTimer);
    countdownTimer = window.setInterval(renderCountdown, 1000);
  }

  function renderCountdown() {
    if (!roomDeadline || expired) return;
    const secondsLeft = Math.max(0, Math.ceil((roomDeadline - Date.now()) / 1000));
    const hours = Math.floor(secondsLeft / 3600);
    const minutes = Math.floor((secondsLeft % 3600) / 60);
    const seconds = secondsLeft % 60;
    countdown.textContent = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    if (secondsLeft === 0) showExpired(linkDeadline && Date.now() >= linkDeadline ? 'link-expired' : 'expired');
  }

  function updateViewport() {
    document.documentElement.style.setProperty('--chat-viewport-height', `${window.visualViewport?.height || window.innerHeight}px`);
    document.documentElement.style.setProperty('--chat-viewport-top', `${window.visualViewport?.offsetTop || 0}px`);
  }
  window.addEventListener('resize', updateViewport);
  window.visualViewport?.addEventListener('resize', updateViewport);
  window.visualViewport?.addEventListener('scroll', updateViewport);
  updateViewport();

  function showState(view) {
    document.body.classList.toggle('is-chat-room', view === 'room');
    updateViewport();
    homeView.classList.toggle("is-hidden", view !== "home");
    roomView.classList.toggle("is-hidden", view !== "room");
    expiredView.classList.toggle("is-hidden", view !== "expired");
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("show"), 2600);
  }

  async function apiRequest(url, options = {}) {
    const requestGeneration = generation;
    const headers = new Headers(options.headers);
    if (roomAccess && /\/(messages|uploads|files)(\/|$)/.test(url)) headers.set("X-Room-Access", roomAccess);
    const response = await fetch(url, { ...options, headers });
    if (response.status === 404 && generation === requestGeneration && roomId && url.includes(`/api/rooms/${roomId}`)) {
      showExpired();
      throw new Error("This room has expired.");
    }
    if (!response.ok) {
      let detail = "";
      try {
        const body = await response.json();
        detail = body.error || body.message || "";
      } catch (_) { /* A response does not always include JSON. */ }
      throw new Error(detail || `Request failed (${response.status}).`);
    }
    return response.json();
  }

  // Create first, then place the server-issued room ID in the shareable URL.
  async function createRoom() {
    const customName = document.getElementById('custom-name').value.trim().toLowerCase();
    const reusable = document.getElementById('reusable-link').checked;
    if (customName && (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(customName) || /^[a-f0-9]{32}$/.test(customName))) {
      homeStatus.textContent = 'Use 3-40 letters, numbers or hyphens; start and end with a letter or number. Choose a name rather than a room ID.';
      document.getElementById('custom-name').focus();
      return;
    }
    saveName(nameInput.value);
    createButton.disabled = true;
    createButton.querySelector("span:first-child").textContent = "Making your room…";
    homeStatus.textContent = "A moment while we set things up.";
    try {
      const secret = generateRoomSecret();
      const keyCommitment = await roomCommitment(secret);
      const room = await apiRequest("/api/rooms", { method: "POST", headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ encryptionVersion: 1, keyCommitment, reusable, ...(customName ? { customName } : {}) }) });
      if (!room.roomId) throw new Error("The server did not return a room link.");
      history.pushState({}, "", compactInvite(room.roomId, secret));
      await openRoom(room.roomId, room);
    } catch (error) {
      homeStatus.textContent = error.message || "Could not create a room. Please try again.";
      showToast(homeStatus.textContent);
    } finally {
      createButton.disabled = false;
      createButton.querySelector("span:first-child").textContent = "Create a room";
    }
  }

  async function openRoom(id, knownRoom = null) {
    cleanupRoom();
    reusableRoom = false;
    linkDeadline = 0;
    document.getElementById('reuse-room').classList.add('is-hidden');
    const currentGeneration = generation;
    roomId = id;
    expired = false;
    displayName = "";
    participantId = "";
    seenMessages.clear();
    showState("room");
    roomCode.textContent = `${id.slice(0, 6)}…${id.slice(-4)}`;
    setConnection("connecting", "Connecting");
    messages.replaceChildren();
    messageState.classList.remove("is-hidden");
    messageState.innerHTML = '<span class="loading-mark"></span><p>Opening your room…</p>';
    messages.append(messageState);
    setComposerEnabled(false);

    try {
      // Always re-check the room: cached create data is not proof it remains open.
      const room = await apiRequest(`/api/rooms/${encodeURIComponent(id)}`);
      if (generation !== currentGeneration) return;
      if (room.encryptionVersion !== 1) { showRoomIssue('This room predates encryption. Create a new room to start an encrypted conversation.'); return; }
      reusableRoom = room.reusable === true;
      linkDeadline = room.linkExpiresAt || 0;
      const linkExpiryText = linkDeadline ? `This custom invite expires on ${new Date(linkDeadline).toLocaleString()}. Its name becomes available again. A new invite key will be required.` : 'This invite has no separate 30-day custom-name deadline.';
      document.getElementById('link-expiry-info').textContent = linkExpiryText;
      encryptionContext = room.encryptionContext || id;
      document.querySelector('.expiry-chip').title = reusableRoom ? `This chat clears when the timer ends. ${linkExpiryText}` : 'This room automatically closes when the timer ends';
      document.getElementById('room-lifetime').textContent = reusableRoom ? (linkDeadline ? '24-hour chats. This custom invite lasts 30 days.' : 'Chat clears after 24 hours. This invite can be reused.') : 'Auto-deletes after 24 hours.';
      document.querySelector('.room-subtitle').textContent = reusableRoom ? 'One invite. Fresh chats every 24 hours.' : 'A temporary room for your people.';
      roomCode.textContent = /^[a-f0-9]{32}$/.test(id) ? `${id.slice(0, 6)}...${id.slice(-4)}` : id;
      const secret = parseInvite(location.href).secret;
      if (!secret) { showRoomIssue('This invite is missing its encryption key. Ask someone in the room to share the complete invite link, including the part after #.'); return; }
      try {
        if (await roomCommitment(secret) !== room.keyCommitment) throw new Error('Wrong key');
        const key = await deriveRoomKey(secret, encryptionContext);
        const access = await roomAccessToken(secret);
        if (generation !== currentGeneration) return;
        roomKey = key;
        roomAccess = access;
      } catch (_) { if (generation === currentGeneration) showRoomIssue('This invite has an invalid encryption key, or this browser cannot use encryption. Open the complete invite on HTTPS with a supported browser.'); return; }
      rememberInvite(id, secret);
      document.getElementById('encryption-status').textContent = 'End-to-end encrypted';
      setRoomDeadline(room || knownRoom);
      if (!expired) connectSocket(id);
    } catch (error) {
      if (!expired && generation === currentGeneration) {
        setConnection("disconnected", "Couldn’t open room");
        setMessageState("Could not load this room. Check your connection and try again.");
        const retry = document.createElement("button");
        retry.className = "retry-button";
        retry.type = "button";
        retry.textContent = "Try again";
        retry.addEventListener("click", () => openRoom(id));
        messageState.append(retry);
      }
    }
  }

  async function loadHistory(id) {
    const currentGeneration = generation;
    const result = await apiRequest(`/api/rooms/${encodeURIComponent(id)}/messages`);
    if (generation !== currentGeneration || roomId !== id || expired) return;
    const history = Array.isArray(result.messages) ? result.messages : [];
    if (!history.length && !messages.querySelector(".message-row")) {
      setMessageState("A quiet room. Say hello when you’re ready.");
      return;
    }
    await Promise.all(history.map(addMessage));
    if (generation !== currentGeneration) return;
    scrollMessagesToEnd();
  }

  // Rejoin the shared room and refresh missed history on each native WebSocket connection.
  function connectSocket(id) {
    socket = connectRoom(id, roomAccess, preferredName);
    socket.on("connect", () => setConnection("connecting", "Joining room"));
    socket.on("chat:ready", (payload) => {
      displayName = payload.displayName;
      participantId = payload.participantId;
      setConnection("connected", "Connected");
      setComposerEnabled(true);
      // REST history was loaded on entry; reconnect may have missed messages.
      // Reload history and deduplicate, so no message is lost across disconnections.
      loadHistory(id).catch((error) => {
        if (!expired) showToast(error.message || "Could not refresh messages.");
      });
    });
    socket.on("room:presence", ({ participants }) => {
      document.getElementById("participant-count").textContent = `${participants.length} online`;
      document.getElementById("participant-list").textContent = participants.map(p => p.id === participantId ? `${p.name} (you)` : p.name).join(", ");
    });
    socket.on("chat:message", (message) => addMessage(message));
    socket.on("room:expired", (payload) => showExpired(payload?.linkExpired ? "link-expired" : "expired"));
    socket.on("room:link-expired", () => showExpired("link-expired"));
    socket.on("room:deleted", () => showExpired("deleted"));
    socket.on("chat:error", (payload) => {
      if (payload && payload.message) showToast(payload.message);
    });
    socket.on("disconnect", () => {
      setConnection("disconnected", "Reconnecting");
      setComposerEnabled(false);
    });
    socket.on("connect_error", (error) => {
      setConnection("disconnected", "Reconnecting");
      if (error && /404|expired|not found/i.test(error.message || "")) showExpired();
    });
  }

  function setConnection(state, label) {
    connectionDot.className = `presence-dot ${state}`;
    connectionLabel.textContent = label;
  }

  function setComposerEnabled(enabled) {
    deleteButton.disabled = !enabled || deleting;
    messageInput.disabled = !enabled || sending;
    sendButton.disabled = !enabled || sending;
    attachButton.disabled = !enabled || sending;
  }

  function setMessageState(text) {
    messages.replaceChildren();
    messageState.classList.remove("is-hidden");
    messageState.replaceChildren();
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    messageState.append(paragraph);
    messages.append(messageState);
  }

  function hideMessageState() {
    if (messageState.parentNode === messages) messageState.remove();
  }

  function formatTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
  }

  function formatSize(bytes) {
    if (!Number.isFinite(Number(bytes))) return "File";
    const size = Number(bytes);
    return size >= 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;
  }

  function addMessage(message) {
    const currentGeneration = generation;
    const key = roomKey;
    const id = encryptionContext;
    receiveQueue = receiveQueue.then(async () => {
      if (generation !== currentGeneration || !key || !message || seenMessages.has(String(message.id))) return;
      let payload;
      try { payload = await decryptMessage(key, id, message); }
      catch (_) { payload = { text: 'Unable to decrypt this message. It may have been changed or sent with a different key.', attachment: null }; }
      if (generation !== currentGeneration) return;
      renderMessage({ ...message, ...payload });
    }).catch(() => { if (generation === currentGeneration) showToast('Could not display an encrypted message.'); });
    return receiveQueue;
  }

  function renderMessage(message) {
    if (!message || message.id == null || seenMessages.has(String(message.id))) return;
    seenMessages.add(String(message.id));
    hideMessageState();
    const row = document.createElement("article");
    row.className = "message-row";
    let colorHash = 0;
    for (const char of (message.senderId || 'guest')) colorHash = (colorHash * 31 + char.charCodeAt(0)) >>> 0;
    row.dataset.color = String(colorHash % 6);
    row.dataset.sequence = String(message.sequence || 0);
    if (participantId && message.senderId === participantId) row.classList.add("own");

    const meta = document.createElement("div");
    meta.className = "message-meta";
    const sender = document.createElement("strong");
    sender.textContent = message.sender || "Guest";
    const time = document.createElement("time");
    time.textContent = formatTime(message.createdAt);
    meta.append(sender, time);

    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    if (typeof message.text === "string" && message.text.length) {
      const text = document.createElement("span");
      text.textContent = message.text;
      bubble.append(text);
    }
    if (message.attachment) bubble.append(makeAttachment(message.attachment));
    row.append(meta, bubble);
    const later = [...messages.querySelectorAll(".message-row")].find(item => Number(item.dataset.sequence) > Number(row.dataset.sequence));
    messages.insertBefore(row, later || null);
    scrollMessagesToEnd();
  }

  // Download ciphertext, authenticate/decrypt locally, then offer a browser-local file.
  function makeAttachment(attachment) {
    const container = document.createElement('div');
    container.className = 'message-attachment';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'file-card encrypted-file-button';
    const label = document.createElement('span');
    label.className = 'file-label';
    const title = document.createElement('strong');
    title.textContent = attachment.originalName;
    const detail = document.createElement('small');
    detail.textContent = `${formatSize(attachment.size)} / Decrypt & open`;
    label.append(title, detail);
    button.append(label);
    container.append(button);
    const currentGeneration = generation;
    const id = roomId;
    const access = roomAccess;
    const context = encryptionContext;
    button.addEventListener('click', async () => {
      button.disabled = true;
      detail.textContent = 'Decrypting...';
      try {
        const response = await fetch(`/api/rooms/${id}/files/${attachment.id}`, { cache: 'no-store', headers: { 'X-Room-Access': access }, signal: AbortSignal.timeout(120000) });
        if (!response.ok) throw new Error('This encrypted file is no longer available.');
        const length = Number(response.headers.get('Content-Length'));
        if (!Number.isFinite(length) || length !== attachment.size + 16) throw new Error('Encrypted file size does not match.');
        const blob = await decryptAttachment(await response.arrayBuffer(), attachment, context);
        if (generation !== currentGeneration) return;
        const url = URL.createObjectURL(blob);
        decryptedUrls.add(url);
        const download = document.createElement('a');
        download.href = url;
        download.download = attachment.originalName;
        download.className = 'decrypted-download';
        download.textContent = `Save ${attachment.originalName}`;
        if (attachment.mimeType.startsWith('image/')) {
          const preview = document.createElement('img');
          preview.src = url; preview.alt = attachment.originalName; preview.className = 'attachment-preview';
          container.append(preview);
        } else if (attachment.mimeType.startsWith('video/')) {
          const preview = document.createElement('video');
          preview.src = url; preview.controls = true; preview.preload = 'metadata'; preview.className = 'attachment-preview';
          preview.setAttribute('aria-label', attachment.originalName);
          container.append(preview);
        }
        button.remove();
        container.append(download);
      } catch (error) {
        if (generation !== currentGeneration) return;
        detail.textContent = 'Could not decrypt / Tap to retry';
        button.disabled = false;
        showToast(error.message || 'Could not decrypt the attachment.');
      }
    });
    return container;
  }

  function scrollMessagesToEnd() {
    messages.scrollTop = messages.scrollHeight;
  }

  function cleanupRoom() {
    if (document.getElementById('name-dialog').open) document.getElementById('name-dialog').close();
    if (deleteDialog.open) deleteDialog.close();
    document.getElementById("encryption-dialog").close();
    deleting = false;
    confirmDelete.disabled = false;
    confirmDelete.textContent = 'Delete for everyone';
    cancelDelete.disabled = false;
    generation++;
    roomKey = null;
    roomAccess = null;
    receiveQueue = Promise.resolve();
    for (const url of decryptedUrls) URL.revokeObjectURL(url);
    decryptedUrls.clear();
    messages.replaceChildren();
    document.getElementById('encryption-status').textContent = 'Checking encryption...';
    sending = false;
    retryMessage = null;
    document.getElementById("participant-count").textContent = 'Connecting';
    document.getElementById("participant-list").textContent = '';
    setComposerEnabled(false);
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
      socket = null;
    }
    if (activeUpload) {
      activeUpload.abort();
      activeUpload = null;
    }
    clearInterval(countdownTimer);
    clearTimeout(linkExpiryTimer);
    roomDeadline = 0;
    selectedFile = null;
    messageInput.value = "";
    fileInput.value = "";
    removeAttachmentButton.disabled = false;
    uploadStatus.classList.add("is-hidden");
    attachmentPending.classList.add("is-hidden");
  }

  function showRoomIssue(detail) {
    document.getElementById('reuse-room').classList.add('is-hidden');
    expired = true;
    cleanupRoom();
    expiredView.querySelector('.eyebrow').textContent = 'Encrypted invite required';
    expiredView.querySelector('h1').textContent = 'Keep the key with the link.';
    expiredView.querySelector('.intro').textContent = detail;
    showState('expired');
  }

  function showExpired(reason = "expired") {
    if (expired && reason !== 'link-expired') return;
    expired = true;
    if (reason === 'deleted' || reason === 'link-expired' || !reusableRoom) {
      try { if (lastInvite && parseInvite(lastInvite).id === roomId) { lastInvite = null; sessionStorage.removeItem('dropchat-last-invite'); } } catch (_) {}
      updateRejoin();
    }
    cleanupRoom();
    // Remove already-rendered copies as soon as the room is closed.
    messages.replaceChildren();
    seenMessages.clear();
    expiredView.querySelector('h1').innerHTML = 'A good moment.<br>Now, a new one.';
    expiredView.querySelector('.eyebrow').textContent = reason === 'deleted' ? 'This chat was deleted' : 'This room has closed';
    expiredView.querySelector('.intro').textContent = reason === 'deleted'
      ? 'This room was deleted for everyone. Its conversation is no longer available, and the invite link no longer works.'
      : 'This temporary room has expired, so its conversation is no longer available.';
    const canReuse = reusableRoom && reason !== 'deleted' && reason !== 'link-expired';
    if (reason === 'link-expired') {
      expiredView.querySelector('.eyebrow').textContent = 'This custom invite has expired';
      expiredView.querySelector('.intro').textContent = 'Its 30-day lifetime has ended. The chat and invite have been deleted, and the name can be created again with a new encryption key. Your old invite cannot open the new room.';
    }
    document.getElementById('reuse-room').classList.toggle('is-hidden', !canReuse);
    if (canReuse) watchLinkExpiry();
    if (canReuse) expiredView.querySelector('.intro').textContent = 'This chat has expired and its history is gone. Your invite still works: start a fresh 24-hour chat with the same link.';
    setConnection("disconnected", "Room closed");
    showState("expired");
  }

  async function shareInvite() {
    const parsed = parseInvite(location.href);
    const url = compactInvite(parsed.id, parsed.secret);
    try {
      if (navigator.share) await navigator.share({ title: "Join my DropChat room", url });
      else if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(url);
        showToast("Invite link copied.");
      } else {
        const temporary = document.createElement("textarea");
        temporary.value = url;
        temporary.style.position = "fixed";
        temporary.style.opacity = "0";
        document.body.append(temporary);
        temporary.select();
        const copied = document.execCommand("copy");
        temporary.remove();
        showToast(copied ? "Invite link copied." : "Copy this link from your address bar.");
      }
    } catch (error) {
      if (error && error.name !== "AbortError") showToast("Could not share the invite link.");
    }
  }

  function chooseFile(file) {
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) {
      showToast("That file is larger than 25 MB.");
      fileInput.value = "";
      return;
    }
    selectedFile = file;
    pendingName.textContent = `${file.name} · ${formatSize(file.size)}`;
    attachmentPending.classList.remove("is-hidden");
  }

  function uploadFile(encrypted, originalName) {
    const uploadGeneration = generation;
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.timeout = 120000;
      activeUpload = request;
      uploadFilename.textContent = originalName;
      uploadPercent.textContent = "0%";
      uploadProgress.style.width = "0%";
      uploadStatus.classList.remove("is-hidden");
      attachmentPending.classList.add("is-hidden");
      request.open("POST", `/api/rooms/${encodeURIComponent(roomId)}/uploads`);
      request.setRequestHeader("X-Room-Access", roomAccess);
      request.upload.addEventListener("progress", (event) => {
        if (generation !== uploadGeneration || !event.lengthComputable) return;
        const progress = Math.round((event.loaded / event.total) * 100);
        uploadPercent.textContent = `${progress}%`;
        uploadProgress.style.width = `${progress}%`;
      });
      request.addEventListener("load", () => {
        if (generation !== uploadGeneration) { reject(new Error("Upload cancelled.")); return; }
        activeUpload = null;
        uploadStatus.classList.add("is-hidden");
        if (request.status === 404) {
          showExpired();
          reject(new Error("This room has expired."));
        } else if (request.status < 200 || request.status >= 300) {
          let reason = "The file could not be uploaded.";
          try {
            const body = JSON.parse(request.responseText);
            reason = body.error || body.message || reason;
          } catch (_) { /* Keep the friendly fallback. */ }
          reject(new Error(reason));
        } else {
          try { resolve(JSON.parse(request.responseText)); }
          catch (_) { reject(new Error("The upload response was not valid.")); }
        }
      });
      request.addEventListener("timeout", () => {
        if (generation === uploadGeneration) { activeUpload = null; uploadStatus.classList.add("is-hidden"); }
        reject(new Error("Upload timed out. Please try again."));
      });
      request.addEventListener("error", () => {
        if (generation !== uploadGeneration) { reject(new Error("Upload cancelled.")); return; }
        activeUpload = null;
        uploadStatus.classList.add("is-hidden");
        reject(new Error("Upload interrupted. Check your connection and try again."));
      });
      request.addEventListener("abort", () => {
        if (generation === uploadGeneration) { activeUpload = null; uploadStatus.classList.add("is-hidden"); }
        reject(new Error("Upload cancelled."));
      });
      const data = new FormData();
      data.append("id", encrypted.attachment.id);
      data.append("file", encrypted.blob, "encrypted.bin");
      request.send(data);
    });
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (sending) return;
    if (!socket || !socket.connected || !displayName || !roomKey || expired) {
      showToast("Reconnecting. Your message hasn’t been sent.");
      return;
    }
    const text = messageInput.value.trim();
    if (!text && !selectedFile) return;
    const currentGeneration = generation;
    const sendingSocket = socket;
    const encryptionKey = roomKey;
    const sendingRoom = encryptionContext;
    const sendingIdentity = { roomId: encryptionContext, senderId: participantId, sender: displayName };
    const file = selectedFile;
    const draft = retryMessage && retryMessage.text === text && retryMessage.file === file ? retryMessage : { text, file, clientId: crypto.randomUUID(), attachment: null };
    retryMessage = draft;
    sending = true;
    messageInput.disabled = true;
    removeAttachmentButton.disabled = true;
    sendButton.disabled = true;
    attachButton.disabled = true;
    let attachment = draft.attachment;
    try {
      if (file && !attachment) {
        const encrypted = await encryptAttachment(file, sendingRoom);
        if (generation !== currentGeneration) return;
        await uploadFile(encrypted, file.name);
        attachment = draft.attachment = encrypted.attachment;
      }
      if (generation !== currentGeneration) return;
      if (!socket || !socket.connected || expired) throw new Error("Connection lost. Rejoin and try sending again.");
      const envelope = await encryptMessage(encryptionKey, { ...sendingIdentity, clientId: draft.clientId }, { text, attachment });
      if (generation !== currentGeneration) return;
      await new Promise((resolve, reject) => {
        sendingSocket.timeout(8000).emit("chat:send", { envelope, attachmentId: attachment?.id || null, clientId: draft.clientId }, (error, result) => {
          if (error) {
            reject(new Error("The server did not confirm your message. Please try again."));
          } else if (!result || result.ok !== true) {
            reject(new Error(result && result.error ? result.error : "Your message could not be sent."));
          } else {
            resolve(result);
          }
        });
      });
      if (generation !== currentGeneration) return;
      retryMessage = null;
      messageInput.value = "";
      messageInput.style.height = "auto";
      selectedFile = null;
      fileInput.value = "";
      attachmentPending.classList.add("is-hidden");
    } catch (error) {
      if (generation === currentGeneration && error.message !== "Upload cancelled.") showToast(error.message || "Message could not be sent.");
    } finally {
      if (generation === currentGeneration) {
        sending = false;
        removeAttachmentButton.disabled = false;
        messageInput.disabled = expired || !socket?.connected;
        sendButton.disabled = !socket || !socket.connected;
        attachButton.disabled = !socket || !socket.connected;
      }
    }
  }

  const encryptionDialog = document.getElementById('encryption-dialog');
  document.getElementById('encryption-info').addEventListener('click', () => encryptionDialog.showModal());
  document.getElementById('close-encryption-info').addEventListener('click', () => encryptionDialog.close());

  deleteButton.addEventListener('click', () => {
    deleteError.textContent = '';
    deleteDialog.showModal();
    cancelDelete.focus();
  });
  cancelDelete.addEventListener('click', () => deleteDialog.close());
  deleteDialog.addEventListener('cancel', event => { if (deleting) event.preventDefault(); });
  deleteDialog.addEventListener('click', event => { if (event.target === deleteDialog && !deleting) deleteDialog.close(); });
  confirmDelete.addEventListener('click', async () => {
    if (deleting || !socket || expired) return;
    const currentGeneration = generation;
    const currentSocket = socket;
    deleting = true;
    confirmDelete.disabled = cancelDelete.disabled = deleteButton.disabled = true;
    confirmDelete.textContent = 'Deleting...';
    deleteError.textContent = '';
    try {
      const result = await currentSocket.deleteRoom();
      if (generation === currentGeneration) showExpired('deleted');
      if (result.cleanupPending) showToast('Room closed. File cleanup will retry automatically.');
    } catch (error) {
      if (generation !== currentGeneration) return;
      deleteError.textContent = error.message || 'Could not delete the chat. Please try again.';
    } finally {
      if (generation === currentGeneration) {
        deleting = false;
        confirmDelete.disabled = cancelDelete.disabled = false;
        confirmDelete.textContent = 'Delete for everyone';
        deleteButton.disabled = !socket?.connected;
      }
    }
  });

  document.getElementById('rejoin-room').addEventListener('click', () => {
    if (!lastInvite) return;
    saveName(nameInput.value);
    history.pushState({}, '', lastInvite);
    routeFromUrl();
  });
  document.getElementById('join-invite-form').addEventListener('submit', event => {
    event.preventDefault();
    try {
      const invite = parseInvite(document.getElementById('join-invite').value.trim());
      if (!invite.secret) throw new Error('The full invite must include its encryption key after #.');
      saveName(nameInput.value);
      history.pushState({}, '', compactInvite(invite.id, invite.secret));
      routeFromUrl();
    } catch (error) { homeStatus.textContent = error.message; }
  });
  document.getElementById('edit-name').addEventListener('click', () => {
    document.getElementById('chat-name').value = preferredName;
    document.getElementById('name-dialog').showModal();
  });
  document.getElementById('cancel-name').addEventListener('click', () => document.getElementById('name-dialog').close());
  document.getElementById('name-form').addEventListener('submit', event => {
    event.preventDefault();
    const name = document.getElementById('chat-name').value.trim();
    if (name.length > 30 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(name)) { showToast('Use up to 30 characters without control characters.'); return; }
    saveName(name);
    document.getElementById('name-dialog').close();
    openRoom(roomId);
  });
  document.getElementById('reuse-room').addEventListener('click', () => openRoom(roomId));
  createButton.addEventListener("click", createRoom);
  newRoomButton.addEventListener("click", () => {
    history.pushState({}, "", "/");
    roomId = null;
    expired = false;
    showState("home");
    homeStatus.textContent = "One link brings the whole group together.";
  });
  shareButton.addEventListener("click", shareInvite);
  leaveButton.addEventListener("click", () => {
    cleanupRoom();
    roomId = null;
    expired = false;
    history.pushState({}, "", "/");
    showState("home");
  });
  messageForm.addEventListener("submit", sendMessage);
  messageInput.addEventListener("input", () => {
    messageInput.style.height = "auto";
    messageInput.style.height = `${Math.min(messageInput.scrollHeight, 110)}px`;
  });
  messageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      messageForm.requestSubmit();
    }
  });
  attachButton.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => chooseFile(fileInput.files && fileInput.files[0]));
  removeAttachmentButton.addEventListener("click", () => {
    selectedFile = null;
    fileInput.value = "";
    attachmentPending.classList.add("is-hidden");
  });
  cancelUploadButton.addEventListener("click", () => {
    if (activeUpload) activeUpload.abort();
  });
  function routeFromUrl() {
    let requestedRoom;
    try { requestedRoom = parseInvite(location.href).id; } catch (_) {}
    if (requestedRoom) openRoom(requestedRoom);
    else {
      cleanupRoom();
      roomId = null;
      expired = false;
      showState('home');
      updateRejoin();
    }
  }
  window.addEventListener("popstate", routeFromUrl);
  window.addEventListener("hashchange", routeFromUrl);

  routeFromUrl();
})();
