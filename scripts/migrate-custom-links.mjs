import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
export async function migrateCustomLinks({ env = process.env, fetchImpl = fetch, log = console.log } = {}) {
// Schedule the 30-day policy on every stored room, including dormant legacy reservations.
// Credentials come only from the environment; never print tokens or invite secrets.
const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: apiToken, ROOM_MIGRATION_TOKEN: migrationToken, DROPCHAT_URL: site, DROPCHAT_NAMESPACE_ID: explicitNamespace } = env;
if (!account || !apiToken || !migrationToken || !site) throw new Error('Set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, ROOM_MIGRATION_TOKEN and DROPCHAT_URL.');
if (!/^[a-f0-9]{32}$/.test(account) || migrationToken.length < 32) throw new Error('Invalid account ID or migration token (minimum 32 characters).');
const target = new URL(site);
if (target.protocol !== 'https:' || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('DROPCHAT_URL must be the HTTPS origin of the deployed app.');
async function api(path) {
 const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${account}/${path}`, { headers: { Authorization: `Bearer ${apiToken}` }, signal: AbortSignal.timeout(30000) });
 const body = await response.json();
 if (!response.ok || !body.success) throw new Error(`Cloudflare API request failed (${response.status}). Check account and Workers Scripts Read permission.`);
 return body;
}
let namespace = explicitNamespace;
if (!namespace) {
 const candidates = [];
 for (let page = 1; ; page++) {
  const body = await api(`workers/durable_objects/namespaces?page=${page}&per_page=100`);
  candidates.push(...(body.result || []).filter(n => n.script === (env.DROPCHAT_WORKER_NAME || 'dropchat') && n.class === 'ChatRoom'));
  if (page >= (body.result_info?.total_pages || 1)) break;
 }
 if (candidates.length !== 1) throw new Error('Could not uniquely select ChatRoom. Set DROPCHAT_NAMESPACE_ID from the Cloudflare dashboard/API.');
 namespace = candidates[0].id;
}
if (!/^[a-f0-9]{32}$/.test(namespace || '')) throw new Error('Invalid namespace ID.');
let cursor, processed = 0, custom = 0;
const seenCursors = new Set();
do {
 const body = await api(`workers/durable_objects/namespaces/${namespace}/objects?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
 for (const object of body.result || []) {
  if (object.hasStoredData === false) continue;
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
   response = await fetchImpl(new URL('/api/maintenance/custom-links', target), { method: 'POST', headers: { Authorization: `Bearer ${migrationToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: object.id }), signal: AbortSignal.timeout(30000) });
   if (response.status !== 503) break;
   await new Promise(resolve => setTimeout(resolve, 300 * 2 ** attempt));
  }
  if (!response.ok) throw new Error(`Migration stopped (${response.status}) after ${processed} objects. Check deployment, namespace and migration secret, then rerun; this operation is idempotent.`);
  const result = await response.json();
  processed++; if (result.custom) custom++;
 }
 const next = body.result_info?.cursors?.after || body.result_info?.cursor;
 if (next && seenCursors.has(next)) throw new Error('Cloudflare returned a repeated cursor. Rerun the migration.');
 if (next) seenCursors.add(next);
 cursor = next;
 log(`Processed ${processed} stored rooms; scheduled ${custom} custom-name deadlines.`);
} while (cursor);
log('Migration complete. Old custom reservations now have cleanup alarms. Remove ROOM_MIGRATION_TOKEN from the Worker when finished.');

}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await migrateCustomLinks();
