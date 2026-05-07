const fs = require('fs');
const path = require('path');

const TEST_DB = path.join(__dirname, 'test-api.db');
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
process.env.COMMS_DB_PATH = TEST_DB;
process.env.COMMS_PORT = '3099'; // test port

const BASE = 'http://localhost:3099/api';

async function req(path, opts = {}) {
  const r = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  const data = await r.json();
  return { status: r.status, data };
}

function assert(condition, msg) {
  if (!condition) { console.error('FAIL:', msg); process.exit(1); }
  console.log('PASS:', msg);
}

async function runTests() {
  // Start server
  const server = require('./server');
  await new Promise(r => setTimeout(r, 500)); // let it boot

  // GET /channels
  const ch = await req('/channels');
  assert(ch.status === 200, 'GET /channels returns 200');
  assert(ch.data.length === 3, '3 default channels');

  // POST /channels
  const newCh = await req('/channels', {
    method: 'POST',
    body: JSON.stringify({ name: 'alerts', description: 'System alerts' })
  });
  assert(newCh.status === 201, 'POST /channels returns 201');
  assert(newCh.data.name === 'alerts', 'channel name matches');

  // POST /channels/:id/messages (JSON)
  const msg = await req('/channels/1/messages', {
    method: 'POST',
    body: JSON.stringify({
      author_name: 'test-bot',
      author_type: 'agent',
      content: 'Hello from test',
      action_items: ['Check logs']
    })
  });
  assert(msg.status === 201, 'POST message returns 201');
  assert(msg.data.content === 'Hello from test', 'message content');
  assert(msg.data.action_items.length === 1, '1 action item');

  // GET /channels/:id/messages
  const msgs = await req('/channels/1/messages');
  assert(msgs.status === 200, 'GET messages returns 200');
  assert(msgs.data.length === 1, '1 message in channel');

  // GET /channels/:id/messages?since=
  const since = new Date().toISOString();
  await new Promise(r => setTimeout(r, 100));
  const msg2 = await req('/channels/1/messages', {
    method: 'POST',
    body: JSON.stringify({
      author_name: 'bot2',
      author_type: 'agent',
      content: 'Second message'
    })
  });
  const sinceResult = await req(`/channels/1/messages?since=${encodeURIComponent(since)}`);
  assert(sinceResult.data.length === 1, 'since filter returns 1 new message');

  // POST thread reply
  const reply = await req(`/channels/1/messages`, {
    method: 'POST',
    body: JSON.stringify({
      author_name: 'human',
      author_type: 'human',
      content: 'Thread reply',
      thread_parent_id: msg.data.id
    })
  });
  assert(reply.status === 201, 'thread reply created');

  // GET /messages/:id/thread
  const thread = await req(`/messages/${msg.data.id}/thread`);
  assert(thread.status === 200, 'GET thread returns 200');
  assert(thread.data.length === 1, 'thread has 1 reply');

  // GET /action-items?completed=false
  const items = await req('/action-items?completed=false');
  assert(items.status === 200, 'GET action-items returns 200');
  assert(items.data.length === 1, '1 open action item');

  // PATCH /action-items/:id
  const patched = await req(`/action-items/${items.data[0].id}`, {
    method: 'PATCH',
    body: JSON.stringify({ completed: true, completed_by: 'human' })
  });
  assert(patched.status === 200, 'PATCH action-item returns 200');
  assert(patched.data.completed === 1, 'action item completed');

  // Verify no open items
  const items2 = await req('/action-items?completed=false');
  assert(items2.data.length === 0, '0 open action items');

  // Cleanup
  server.close();
  fs.unlinkSync(TEST_DB);
  console.log('\nAll API tests passed.');
}

runTests().catch(e => { console.error('Test error:', e); process.exit(1); });
