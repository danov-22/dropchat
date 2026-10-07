# DropChat group chat: run and deploy

## What is implemented

One invite link opens one shared group room across devices. The backend now uses a Cloudflare Worker, one SQLite-backed Durable Object per room, native WebSockets and a private R2 bucket. It replaces the earlier frontend-only Socket.IO setup. Deploy the whole Worker app: uploading only `dist` to Pages will not run group chat.

Features: full-window chat with a compact header, independently scrolling messages and a pinned composer; confirmed room deletion for every guest; anonymous server-assigned Guest names; online participant list/count; persisted encrypted shared message history; per-tab reconnect identity; automatic reconnect and history refresh; server-side message acknowledgements and duplicate-send protection; validated room-scoped attachments; fixed 24-hour room expiry and retryable storage cleanup. Landing-page logo/favicon and dark mode are included.

Current limits: 50 simultaneous connections, 500 guest identities over the room lifetime, 1,000 messages, 25 MiB per file, 100 MiB total files per room. A participant is a browser-tab guest identity, not a verified person. Refresh/reconnect preserves identity when sessionStorage is available; another device/tab normally gets a new identity. Some browsers copy sessionStorage when duplicating a tab, so duplicated tabs may share identity. Nobody needs an account. Anyone who receives the room link can read the room history and files until expiry. Any guest who has joined can also delete the room for everyone through the confirmation dialog. Deletion requires that room's private session token; it is not a creator-only action. Server access is revoked before cleanup, all connected guests are notified, and messages/files are removed. If cleanup fails, the room remains closed and an alarm retries cleanup; already downloaded copies cannot be recalled. Messages, attachments and filenames are end-to-end encrypted in the browser. The complete invite includes a secret in its #key= fragment; anyone holding it can decrypt the history. Read SECURITY.md for the security model and limitations. Existing plaintext rooms cannot be converted: deploy this version and create new rooms.

## Local development

1. Install Node.js LTS and npm.
2. Run `npm ci` in this folder.
3. Run `npm test` for integration tests against Cloudflare's local runtime.
4. Run `npm run dev`. Open the HTTP address Wrangler prints (usually http://localhost:8787).
5. Create a room, copy its full `?room=...#key=...` invite URL, and open it in separate browsers or private windows. Send from each guest and check the online count/history.
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
4. If redirecting alternative hostnames, preserve invite query strings and the #key fragment. Test redirects using a complete invite; the fragment is never sent in HTTP requests. Existing links on another hostname will still refer to the same Worker rooms if that hostname remains connected to this Worker, but browser session identities are per origin.
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
- tests/group-chat.test.mjs: local-runtime integration coverage.

The development dependency override for sharp selects a patched release required by the current Cloudflare tooling's transitive dependency audit. The image-processing package is not included in the deployed Worker. Recheck compatibility and the audit when updating Wrangler/Miniflare.

Official references:
- Workers static assets/bindings: https://developers.cloudflare.com/workers/static-assets/binding/
- Durable Objects WebSocket coordination: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- Durable Object alarms: https://developers.cloudflare.com/durable-objects/api/alarms/
