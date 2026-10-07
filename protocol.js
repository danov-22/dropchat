// Versioned wire-format checks shared by the browser and relay. No secret keys here.
export const ENCRYPTION_VERSION = 1;
export const MAX_FILE_SIZE = 25 * 1024 * 1024;
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function validEnvelope(value) {
  return value && Object.keys(value).every(key => ['version', 'iv', 'ciphertext'].includes(key)) &&
    value.version === ENCRYPTION_VERSION && /^[A-Za-z0-9_-]{16}$/.test(value.iv || '') &&
    typeof value.ciphertext === 'string' && value.ciphertext.length >= 22 && value.ciphertext.length <= 32768 && /^[A-Za-z0-9_-]+$/.test(value.ciphertext);
}
