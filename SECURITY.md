# DropChat encryption and security

Messages, attachments and filenames are encrypted and decrypted in browsers. The Worker, Durable Object and private R2 bucket receive ciphertext rather than message content. This is a shared-secret group protocol, not Signal or MLS, and has not received an independent security audit.

## Invite and keys

Creating a room generates a cryptographically random 32-byte root secret using Web Crypto. The complete invite is `/?room=ROOM_ID#key=SECRET`. Browsers do not send the fragment in HTTP requests. The app keeps the secret in the invite/browser history, derives keys in memory and does not save it to localStorage. Browser history, screenshots, copied links, browser sync and extensions can expose an invite. Anyone with the complete invite can read retained room history and share access onward. Losing the secret cannot be recovered by the server.

HKDF-SHA-256 derives a 256-bit AES-GCM message key with room-specific salt and a protocol-specific domain. The imported message key is nonextractable. A separate HKDF domain derives a room-access capability sent to the server; its SHA-256 commitment is stored with the room. Knowing this capability does not reveal the root secret or content key. The capability gates joins and file/history requests; it is still a credential and must not be logged. Per-tab session tokens identify reconnecting guests and authorize confirmed room deletion.

## Authenticated encryption

Each message uses AES-GCM-256, a fresh random 96-bit nonce and a 128-bit authentication tag. Associated data binds it to the room, client message ID, sender ID and guest label. The encrypted JSON contains the message text and attachment descriptor. Modified ciphertext or mismatched context fails authentication; the interface reports a decryption failure without showing an unauthenticated plaintext fallback.

Each file gets a fresh random 256-bit AES-GCM key and 96-bit nonce. File associated data binds it to the room and file ID. The original filename, MIME type, plaintext size, file key and nonce are inside the encrypted message descriptor. Uploads contain an opaque file ID and encrypted bytes named encrypted.bin. Files are authenticated and decrypted locally before previews/downloads. Declared MIME types are not proof of safe contents.

## What this protects, and its limits

- A passive network observer or a copy of server-side stored ciphertext does not have the content key. HTTPS remains mandatory outside local loopback development.
- The server can see room and guest identifiers, connection times, IP addresses through hosting infrastructure, message counts, ciphertext sizes and traffic patterns. Encryption does not provide anonymity or hide metadata.
- Guest identities are anonymous and server assigned, without identity verification. Every key holder can create valid encrypted content. There is no safety-number verification, member approval, member removal or key rotation.
- There is no forward secrecy or ratchet. A leaked invite can decrypt previously captured ciphertext and retained history. Create a new room with a new invite if a key is compromised; this does not protect old captured messages.
- Browsers trust the JavaScript delivered by the hosting origin. A compromised or malicious host serving modified code, compromised device, browser extension or script injection can steal secrets or plaintext. The included Content-Security-Policy reduces injection exposure but cannot remove this trust requirement.
- Encryption does not prevent a guest from copying content, forwarding an invite, uploading a harmful file or deleting the room. Every joined guest can delete it for everyone after confirmation.
- Expiry/deletion revokes API access and removes active room storage with retryable cleanup. Downloaded copies, screenshots, provider backups and logs are outside that guarantee.

## Deployment and verification

Deploy client and Worker together, over HTTPS. Existing plaintext rooms are rejected by the encrypted protocol and expire on their original schedule; they are not retroactively encrypted. Start new rooms after upgrading. Never log invite fragments, room-access capabilities, session tokens or plaintext. Avoid URL-capturing analytics and third-party runtime scripts.

`npm test` checks authenticated encryption and tamper rejection, encrypted group fan-out/history, encrypted file handling, room/access isolation, plaintext rejection, expiry and deletion. Local browser checks also exercised two-browser decryption, reload, file download, wrong/missing keys, invite correction, network payloads and the security dialog. These checks are not an independent cryptographic audit or a guarantee against implementation vulnerabilities. Obtain a specialist review before relying on this implementation for sensitive communications.
