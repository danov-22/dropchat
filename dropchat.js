import { connectRoom } from "./live-room.js";

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
  const toast = document.getElementById("toast");

  const MAX_FILE_SIZE = 25 * 1024 * 1024;
  let roomId = null;
  let displayName = "";
  let participantId = "";
  let generation = 0;
  let sending = false;
  let retryMessage = null;
  let socket = null;
  let roomDeadline = 0;
  let countdownTimer = null;
  let toastTimer = null;
  let activeUpload = null;
  let selectedFile = null;
  let expired = false;
  const seenMessages = new Set();

  // The API tells us how many seconds remain; use that value as the clock baseline.
  function setRoomDeadline(room) {
    const seconds = Number(room.secondsRemaining);
    roomDeadline = Date.now() + Math.max(0, seconds) * 1000;
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
    if (secondsLeft === 0) showExpired();
  }

  function showState(view) {
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
    const response = await fetch(url, options);
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
    createButton.disabled = true;
    createButton.querySelector("span:first-child").textContent = "Making your room…";
    homeStatus.textContent = "A moment while we set things up.";
    try {
      const room = await apiRequest("/api/rooms", { method: "POST" });
      if (!room.roomId) throw new Error("The server did not return a room link.");
      history.pushState({}, "", `/?room=${encodeURIComponent(room.roomId)}`);
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
    history.forEach(addMessage);
    scrollMessagesToEnd();
  }

  // Rejoin the shared room and refresh missed history on each native WebSocket connection.
  function connectSocket(id) {
    socket = connectRoom(id);
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
    socket.on("room:expired", showExpired);
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
    if (!message || message.id == null || seenMessages.has(String(message.id))) return;
    seenMessages.add(String(message.id));
    hideMessageState();
    const row = document.createElement("article");
    row.className = "message-row";
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

  // Attachments are links to the server's room-scoped URL; preview only opted-in media.
  function makeAttachment(attachment) {
    const link = document.createElement("a");
    link.className = "message-attachment";
    const url = new URL(attachment.url, location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith(`/api/rooms/${roomId}/files/`)) return document.createTextNode('Unavailable attachment');
    link.href = url.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const name = attachment.originalName || "Attached file";
    const type = (attachment.mimeType || "").toLowerCase();
    const previewAllowed = attachment.previewable === true;
    if (previewAllowed && type.startsWith("image/")) {
      const image = document.createElement("img");
      image.className = "attachment-preview";
      image.src = attachment.url;
      image.alt = name;
      image.loading = "lazy";
      link.append(image);
    } else if (previewAllowed && type.startsWith("video/")) {
      const video = document.createElement("video");
      video.className = "attachment-preview";
      video.src = attachment.url;
      video.controls = true;
      video.preload = "metadata";
      video.setAttribute("aria-label", name);
      link.addEventListener("click", (event) => event.preventDefault());
      link.append(video);
    } else {
      const card = document.createElement("span");
      card.className = "file-card";
      const symbol = document.createElement("span");
      symbol.className = "file-symbol";
      symbol.setAttribute("aria-hidden", "true");
      symbol.textContent = "↗";
      const label = document.createElement("span");
      label.className = "file-label";
      const title = document.createElement("strong");
      title.textContent = name;
      const size = document.createElement("small");
      size.textContent = formatSize(attachment.size);
      label.append(title, size);
      card.append(symbol, label);
      link.append(card);
    }
    return link;
  }

  function scrollMessagesToEnd() {
    messages.scrollTop = messages.scrollHeight;
  }

  function cleanupRoom() {
    generation++;
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
    roomDeadline = 0;
    selectedFile = null;
    messageInput.value = "";
    fileInput.value = "";
    removeAttachmentButton.disabled = false;
    uploadStatus.classList.add("is-hidden");
    attachmentPending.classList.add("is-hidden");
  }

  function showExpired() {
    if (expired) return;
    expired = true;
    cleanupRoom();
    setConnection("disconnected", "Room closed");
    showState("expired");
  }

  async function shareInvite() {
    const url = window.location.href;
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

  function uploadFile(file) {
    const uploadGeneration = generation;
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.timeout = 120000;
      activeUpload = request;
      uploadFilename.textContent = file.name;
      uploadPercent.textContent = "0%";
      uploadProgress.style.width = "0%";
      uploadStatus.classList.remove("is-hidden");
      attachmentPending.classList.add("is-hidden");
      request.open("POST", `/api/rooms/${encodeURIComponent(roomId)}/uploads`);
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
      data.append("file", file);
      request.send(data);
    });
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (sending) return;
    if (!socket || !socket.connected || !displayName || expired) {
      showToast("Reconnecting. Your message hasn’t been sent.");
      return;
    }
    const text = messageInput.value.trim();
    if (!text && !selectedFile) return;
    const currentGeneration = generation;
    const sendingSocket = socket;
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
      if (file && !attachment) attachment = draft.attachment = await uploadFile(file);
      if (generation !== currentGeneration) return;
      if (!socket || !socket.connected || expired) throw new Error("Connection lost. Rejoin and try sending again.");
      await new Promise((resolve, reject) => {
        sendingSocket.timeout(8000).emit("chat:send", { text, attachment, clientId: draft.clientId }, (error, result) => {
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
  window.addEventListener("popstate", () => {
    const requestedRoom = new URLSearchParams(window.location.search).get("room");
    if (/^[a-z\d_-]{32}$/i.test(requestedRoom || "")) openRoom(requestedRoom);
    else {
      cleanupRoom();
      roomId = null;
      expired = false;
      showState("home");
    }
  });

  // A malformed or absent room link lands on the simple create-room home state.
  const initialRoomId = new URLSearchParams(window.location.search).get("room");
  if (/^[a-z\d_-]{32}$/i.test(initialRoomId || "")) openRoom(initialRoomId);
  else showState("home");
})();
