# DropChat group chat: run and deploy

## What is implemented

One invite link opens one shared group room across devices. The backend now uses a Cloudflare Worker, one SQLite-backed Durable Object per room, native WebSockets and a private R2 bucket. It replaces the earlier frontend-only Socket.IO setup. Deploy the whole Worker app: uploading only `dist` to Pages will not run group chat.

Features: full-window chat with a compact header, independently scrolling messages and a pinned composer; confirmed room deletion for every guest; optional display names with server-assigned Guest defaults; sender-colored bubbles; per-tab Rejoin shortcut and paste-to-join; online participant list/count; persisted encrypted shared message history; per-tab reconnect identity; automatic reconnect and history refresh; server-side message acknowledgements and duplicate-send protection; validated room-scoped attachments; fixed 24-hour room expiry and retryable storage cleanup. Landing-page logo/favicon and dark mode are included.

Current limits: 50 simultaneous connections, 500 guest identities over the room lifetime, 1,000 messages, 25 MiB per file, 100 MiB total files per room. A participant is a browser-tab guest identity, not a verified person. Refresh/reconnect preserves identity when sessionStorage is available; another device/tab normally gets a new identity. Some browsers copy sessionStorage when duplicating a tab, so duplicated tabs may share identity. Nobody needs an account. Anyone who receives the room link can read the room history and files until expiry. Any guest who has joined can also delete the room for everyone through the confirmation dialog. Deletion requires that room's private session token; it is not a creator-only action. The current chat closes before cleanup; reusable invites can open a new chat after expiry, while manual deletion permanently disables them. Server access is revoked before cleanup, all connected guests are notified, and messages/files are removed. If cleanup fails, the room remains closed and an alarm retries cleanup; already downloaded copies cannot be recalled. Messages, attachments and filenames are end-to-end encrypted in the browser. The complete invite includes a secret in its URL fragment; anyone holding it can decrypt the history. Read SECURITY.md for the security model and limitations. Existing plaintext rooms cannot be converted: deploy this version and create new rooms.

## Custom and reusable invites

On the home screen, enter an optional custom name (3-40 lowercase letters, numbers or hyphens) and optionally enable reuse. For example, the resulting invite is `/#weekend-crew.SECRET`. Names are first come, first served. The name is public and is not an encryption password; the full fragment is required. Taken names show an error without replacing the existing room.

Every chat still expires after 24 hours. For reusable invites, the next opening starts a fresh 24-hour chat only after clearing the previous chat's messages, files and guest identities. Concurrent openings join the same new chat. Each chat gets a new encryption context and derived message key; the shared invite secret remains the same. Anyone holding the original complete invite can join future chats. There is no member revocation or forward secrecy.

Custom invites have a fixed 30-day lifetime from creation, covering both reusable links and one-time name reservations. Chat resets, visits and reconnects do not extend it. At the deadline, server access closes, storage/files are cleaned up and the name is released for a newly created room with a new key. Delete now disables the current invite immediately; its custom name remains reserved only until the original 30-day deadline. A reservation record remains between chat resets/deletion and that deadline. Random generated reusable links retain their previous behavior and have no separate 30-day name deadline. Custom links are configured when creating a room; existing links cannot be renamed or switched to reusable.

New generated room IDs are 16 hexadecimal characters and remain independent of the 256-bit encryption secret. Compact links save URL characters without shortening that secret. The root page handles these fragment links; no URL shortener or external redirect service is used. Sharing an older invite produces its compact equivalent.

Display names are optional and can be changed with Your name inside a chat; old messages keep their original labels. Names are visible to the server and are not unique or verified. The latest successfully opened full invite is saved in this tab's sessionStorage for Rejoin after returning home or refreshing. Closing the tab can lose this shortcut; keep a private copy of reusable invites. A full invite can also be pasted on the home page to join. The custom name by itself is not sufficient, and custom names are released after their fixed 30-day lifetime, and lost encryption keys cannot be recovered.

## Apply the 30-day policy to existing custom links

New custom links start their 30 days at creation. Old versions did not store a creation timestamp. Existing custom links and dormant reservations therefore use the fixed transition start `CUSTOM_LINK_LEGACY_STARTED_AT` in wrangler.jsonc: October 9, 2026 at 00:00 Asia/Makassar, expiring November 8, 2026 at 00:00 in that timezone. This is a transition grace period, not a claim about their original creation dates. Do not advance the setting on later deployments; doing so could extend undiscovered old reservations. Already migrated records preserve their stored deadline. If rollout occurs after that deadline, old names are released on migration/access rather than receiving another 30 days.

Deploy the updated Worker and client together. Access, name creation and alarms enforce the policy automatically. However, dormant old reservations may have no alarm and cannot all be discovered from a room's own code. Run the one-time migration below to schedule cleanup on **every existing stored room**, including those never opened again:

1. Generate a random migration token locally, for example with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Keep it private.
2. Run `npx wrangler secret put ROOM_MIGRATION_TOKEN` and paste that value into Wrangler's prompt. The protected maintenance endpoint is disabled when this secret is absent.
3. In the shell used for migration, set `ROOM_MIGRATION_TOKEN` to that same value, `DROPCHAT_URL` to the deployed HTTPS origin, `CLOUDFLARE_ACCOUNT_ID` to the intended account, and `CLOUDFLARE_API_TOKEN` to a token with Workers Scripts Read permission for that account. Use environment variables rather than committing values. PowerShell uses `$env:NAME = 'value'`.
4. Run `npm run migrate:custom-links`. The script finds this Worker's ChatRoom namespace, pages through stored Durable Objects and applies the deadline plus cleanup alarm to each custom reservation. If needed, set `DROPCHAT_WORKER_NAME` or explicitly set `DROPCHAT_NAMESPACE_ID` to the namespace **bound to this Worker**. Objects from a different namespace cannot be migrated through this binding.
5. Confirm the script prints `Migration complete`. It is idempotent; rerun after a failure or to verify all records. It prints counts, never credentials or invite keys. Migration does not reset existing chat histories before their own deadlines.
6. Run `npx wrangler secret delete ROOM_MIGRATION_TOKEN`, then remove the token from your shell environment. In PowerShell: `Remove-Item Env:ROOM_MIGRATION_TOKEN`. Remove the temporary API token environment variable when finished as well.

The local implementation and migration tests do not apply this change to live Cloudflare data. Production deployment and this one-time migration must be completed for unattended cleanup of all dormant old links. File deletion is retryable/asynchronous; expiry blocks access immediately, and a failed purge prevents claiming the name until cleanup succeeds. A recreated name has a new commitment/context/key: previous invites and access tokens cannot enter it. A name alone is never a password. Users must share the new complete invite.

The migration uses Cloudflare's [namespace object listing API](https://developers.cloudflare.com/api/resources/durable_objects/subresources/namespaces/subresources/objects/methods/list/).

## Local development

1. Install Node.js LTS and npm.
2. Run `npm ci` in this folder.
3. Run `npm test` for integration tests against Cloudflare's local runtime.
4. Run `npm run dev`. Open the HTTP address Wrangler prints (usually http://localhost:8787).
5. Create a room, copy its full `/#room.secret` invite URL (older `?room=...#key=...` links also work), and open it in separate browsers or private windows. Send from each guest and check the online count/history.
6. For another device, use a separate HTTPS staging deployment or a trusted HTTPS development tunnel. Encryption requires a secure browser context: HTTP localhost works for local development, but an HTTP LAN IP does not. Keep development endpoints private.

Local Durable Object/R2 data stays in Wrangler's local storage, separate from production. `npm run preview` remains a static visual preview and does not provide chat. Rebuild after frontend edits; this setup does not automatically watch and rebuild frontend assets.

## Cloudflare production deployment

1. Create/sign in to your Cloudflare account and enable Workers and R2. Review current plan limits and any R2 billing requirements in your account.
2. Run `npx wrangler login` and authorize your account.
3. Run `npx wrangler whoami` and verify the intended account. If you have multiple accounts, configure the intended `account_id` in wrangler.jsonc or use CLOUDFLARE_ACCOUNT_ID in your deployment environment.
4. Run `npx wrangler r2 bucket create dropchat-files`. If choosing a different bucket name, update `r2_buckets[0].bucket_name` in wrangler.jsonc. Keep the bucket private; do not enable a public R2 URL.
5. Review wrangler.jsonc: Worker name, private R2 binding `FILES`, Durable Object namespace binding `ROOMS`, SQLite class `ChatRoom`, migration tag `v1`, and static assets from `dist`. Keep migration history when updating the app. Compatibility date is pinned to a runtime-supported date rather than the current date.
6. Run `npm ci`, `npm test`, and `npm run build`.
7. Optional packaging verification: `npx wrangler deploy --dry-run --outdir .deploy-check`. This packages the Worker and validates configuration; it does not create production resources or prove deployed behavior.
8. Run `npm run deploy`. Wrangler deploys the Worker, creates the declared Durable Object migration/namespace and uploads the static assets. It expects the R2 bucket from step 4 to exist. No database migration command or external Socket.IO service is needed.
9. Open the printed HTTPS workers.dev URL. Create a room and share its exact invite link with at least two other browsers/devices. Check messages in both directions, refresh, reconnect, attachments, expiry and dark mode.
10. For continuous deployment, commit source, package.json and package-lock.json to Git. Connect the repository through Cloudflare Workers Builds. Configure build command `npm run build` and deploy command `npx wrangler deploy` (or use the combined `npm run deploy` as the deployment command with no duplicate build). Use a restricted account-scoped API token in CI if needed; never commit it. Exclude node_modules, caches, dist, .wrangler, .deploy-check and secrets.

No account login, bucket creation, remote deployment or domain changes have been performed by the coding agent.

## Custom domain and HTTPS

1. Test the workers.dev deployment first.
2. In the Worker dashboard, open Settings > Domains & Routes and add a Custom Domain. Follow the account's Cloudflare zone/DNS instructions; wait for certificate activation.
3. Verify your final HTTPS hostname, favicon, theme, room creation and WebSocket connection. Use the app and API on the same hostname; cross-origin browser API/socket requests are intentionally rejected.
4. If redirecting alternative hostnames, preserve invite query strings and the complete URL fragment. Test redirects using a complete invite; the fragment is never sent in HTTP requests. Existing links on another hostname will still refer to the same Worker rooms if that hostname remains connected to this Worker, but browser session identities are per origin.
5. Keep preview/testing deployments on their own Worker and R2 bucket with separate bindings/resources. Do not casually deploy an environment configuration that points testing at production storage.

## Encryption rollout

Deploy the Worker and bundled client together. Previous clients that submit plaintext are rejected. Previous plaintext rooms remain inaccessible through chat APIs and expire on their original schedule; this update does not retroactively encrypt stored data. Create a new room and distribute its complete new invite. Do not strip the fragment when copying, shortening or redirecting links. Losing the invite secret means losing access; there is no password reset or key recovery.

## Checks before inviting a public audience

- Encryption tests verify authenticated round trips, fresh nonces, wrong-key/context/tamper rejection, ciphertext-only history and files, access-token enforcement and rejection of plaintext clients. Browser checks verify cross-browser decryption, reload history, encrypted attachment download, missing/wrong-key rejection and absence of message text, original filenames and root secrets in requests/WebSocket frames.
- The integration suite verifies three guests sharing messages, room isolation, unique identities, presence updates on leaving, stable identity on reconnect, deduplicated sends, upload/download isolation, forged-file rejection, invalid links/origins, expiry broadcast, R2 deletion, authenticated manual deletion and the native browser transport protocol. Local browser checks also cover the full-window layout at mobile/tablet/desktop widths and short viewports, composer visibility, themes, two-browser messaging, deletion cancellation/Escape, failure/retry and live closure for both guests. Physical-device keyboard behavior, assistive technology and production networks still need testing.
- Use a short `ROOM_TTL_SECONDS` variable only in a separate local/staging deployment to verify the deadline and cleanup. Production defaults to 86,400 seconds. Server deadline checks block access immediately after expiry; physical deletion is asynchronous and depends on the alarm completing. Cloudflare retries failed alarms; monitor repeated failures and provide recovery for outages exceeding automatic retries. Existing downloaded copies cannot be recalled.
- Rate limits on messages and per-room storage/participant caps are implemented. Global/IP-based room-creation and upload-abuse protection is still needed for a public launch; set Cloudflare rate limits/Turnstile or add backend enforcement suited to your audience. Current room links grant access to uploads; there is no creator-only administrator, approval queue or moderation interface. Joined guests can irreversibly delete a room for everyone; the interface explains this before confirmation.
- Uploaded files are ciphertext on the server, so server-side MIME inspection and malware scanning cannot inspect their contents. The client restricts declared file types and preview formats; the server enforces ciphertext size and room ownership. File responses use application/octet-stream, nosniff and sandbox headers. Treat downloads from other guests as untrusted; encryption does not make files safe.
- Avoid logging full request URLs containing room IDs, reconnect tokens, room-access tokens, invite fragments, message bodies or file contents. Never add analytics that capture complete invite URLs. Establish privacy/retention practices, and configure usage, billing, storage-growth and cleanup-failure alerts. Room deletion does not constitute a guarantee about provider infrastructure, logs or downloaded copies.
- The history is bounded at 1,000 messages and rendered in server sequence order. There is no pagination, message editing, removal, search, read receipts or custom room name.
- Confirm R2/Worker quotas and costs for your usage. Add operational monitoring and document rollback of both static client and Worker; preserve protocol compatibility and Durable Object migrations during rollback.
- Basic static security headers are in `_headers`; API/file responses set their own headers. A Content-Security-Policy restricting scripts/connections to this origin and previews to blob URLs is included and checked locally. Verify it on the production hostname as well.
- Test mobile keyboard, both themes, 320px layouts, reduced motion, browser history, expired links, upload cancellation, repeated sends, slow networks, missed acknowledgements and switching rooms during pending requests.

## Files

- worker.js: routing, shared Durable Object rooms, WebSocket fan-out, storage, uploads and cleanup.
- live-room.js: native WebSocket reconnect/join/ack transport.
- dropchat.js: chat interface, browser encryption/decryption, participant presence and history.
- encryption.js: Web Crypto key derivation, authenticated message/file encryption and validation.
- protocol.js: shared encrypted-envelope validation and size limits.
- SECURITY.md: threat model, key handling and limitations.
- wrangler.jsonc: Cloudflare deployment bindings, migration and assets.
- tests/group-chat.test.mjs: local-runtime integration and migration coverage.
- scripts/migrate-custom-links.mjs: one-time migration for dormant legacy custom names.

The development dependency override for sharp selects a patched release required by the current Cloudflare tooling's transitive dependency audit. The image-processing package is not included in the deployed Worker. Recheck compatibility and the audit when updating Wrangler/Miniflare.

Official references:
- Workers static assets/bindings: https://developers.cloudflare.com/workers/static-assets/binding/
- Durable Objects WebSocket coordination: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- Durable Object alarms: https://developers.cloudflare.com/durable-objects/api/alarms/
