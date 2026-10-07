import { ENCRYPTION_VERSION, MAX_FILE_SIZE, UUID, validEnvelope } from './protocol.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const SAFE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime', 'application/pdf', 'application/zip', 'text/plain', 'text/csv']);
function requireCrypto() {
  if (globalThis.isSecureContext === false || !globalThis.crypto?.subtle) throw new Error('Encrypted chat needs HTTPS and a browser with Web Crypto support.');
}
export function toBase64(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function fromBase64(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encryption data.');
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if ((length !== undefined && bytes.length !== length) || toBase64(bytes) !== value) throw new Error('Invalid encryption data.');
  return bytes;
}
export function generateRoomSecret() {
  requireCrypto();
  return toBase64(crypto.getRandomValues(new Uint8Array(32)));
}
// Separate access capability: the relay sees this value, never the message key/root secret.
export async function roomAccessToken(secret) {
  requireCrypto();
  const material = await crypto.subtle.importKey('raw', fromBase64(secret, 32), 'HKDF', false, ['deriveBits']);
  return toBase64(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('DropChat access salt v1'), info: encoder.encode('DropChat room access v1') }, material, 256));
}
export async function roomCommitment(secret) {
  return toBase64(await crypto.subtle.digest('SHA-256', fromBase64(await roomAccessToken(secret), 32)));
}
export async function deriveRoomKey(secret, roomId) {
  requireCrypto();
  if (!/^[a-f0-9]{32}$/.test(roomId)) throw new Error('Invalid room.');
  const material = await crypto.subtle.importKey('raw', fromBase64(secret, 32), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(roomId), info: encoder.encode('DropChat message encryption v1') }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
function messageContext(roomId, clientId, senderId, sender) {
  if (!/^[a-f0-9]{32}$/.test(roomId) || !UUID.test(clientId || '') || !UUID.test(senderId || '') || typeof sender !== 'string') throw new Error('Invalid message context.');
  return encoder.encode(JSON.stringify(['DropChat message v1', roomId, clientId, senderId, sender]));
}
function attachmentContext(roomId, id) { return encoder.encode(JSON.stringify(['DropChat file v1', roomId, id])); }
function validateAttachment(file) {
  if (!file || !UUID.test(file.id || '') || typeof file.originalName !== 'string' || file.originalName.length > 200 || !SAFE_TYPES.has(file.mimeType) || !Number.isInteger(file.size) || file.size < 1 || file.size > MAX_FILE_SIZE) throw new Error('Invalid encrypted attachment.');
  fromBase64(file.key, 32); fromBase64(file.iv, 12);
  return file;
}
function validatePayload(payload) {
  if (!payload || typeof payload.text !== 'string' || payload.text.length > 4000 || (!payload.text.trim() && !payload.attachment)) throw new Error('Invalid message.');
  if (payload.attachment) validateAttachment(payload.attachment);
  return { text: payload.text, attachment: payload.attachment || null };
}
export async function encryptMessage(key, context, payload) {
  const bytes = encoder.encode(JSON.stringify(validatePayload(payload)));
  if (bytes.length > 24560) throw new Error('This message is too large.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: messageContext(context.roomId, context.clientId, context.senderId, context.sender), tagLength: 128 }, key, bytes);
  return { version: ENCRYPTION_VERSION, iv: toBase64(iv), ciphertext: toBase64(ciphertext) };
}
export async function decryptMessage(key, roomId, message) {
  if (!validEnvelope(message.envelope)) throw new Error('Invalid encrypted message.');
  const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(message.envelope.iv, 12), additionalData: messageContext(roomId, message.clientId, message.senderId, message.sender), tagLength: 128 }, key, fromBase64(message.envelope.ciphertext));
  const payload = validatePayload(JSON.parse(decoder.decode(bytes)));
  if ((payload.attachment?.id || null) !== (message.attachmentId || null)) throw new Error('Attachment reference was changed.');
  return payload;
}
export async function encryptAttachment(file, roomId) {
  requireCrypto();
  if (!SAFE_TYPES.has(file.type) || file.size < 1 || file.size > MAX_FILE_SIZE) throw new Error('Unsupported file type or size (maximum 25 MB).');
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey('raw', secret, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const id = crypto.randomUUID();
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: attachmentContext(roomId, id), tagLength: 128 }, key, await file.arrayBuffer());
  return { blob: new Blob([ciphertext], { type: 'application/octet-stream' }), attachment: { id, originalName: file.name.slice(0, 200), mimeType: file.type, size: file.size, key: toBase64(secret), iv: toBase64(iv) } };
}
export async function decryptAttachment(bytes, attachment, roomId) {
  requireCrypto();
  validateAttachment(attachment);
  if (bytes.byteLength !== attachment.size + 16) throw new Error('Encrypted file size does not match.');
  const key = await crypto.subtle.importKey('raw', fromBase64(attachment.key, 32), 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(attachment.iv, 12), additionalData: attachmentContext(roomId, attachment.id), tagLength: 128 }, key, bytes);
  return new Blob([plaintext], { type: attachment.mimeType });
}
