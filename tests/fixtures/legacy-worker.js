import worker, { ChatRoom as CurrentChatRoom } from '../../worker.js';
export default worker;
// Only loaded by Miniflare tests, never by the production Worker entrypoint.
export class ChatRoom extends CurrentChatRoom {
 async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/__fixture/seed') {
   await this.ctx.storage.put('room', await request.json());
   await this.ctx.storage.deleteAlarm();
   return Response.json({ seeded: true });
  }
  if (path === '/__fixture/inspect') return Response.json({ room: await this.ctx.storage.get('room'), alarm: await this.ctx.storage.getAlarm(), count: (await this.ctx.storage.list()).size });
  return super.fetch(request);
 }
}
