const fs = require('fs');
const path = require('path');

// Use a temp DB for testing
const TEST_DB = path.join(__dirname, 'test-comms.db');

// Clean up before test
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
process.env.COMMS_DB_PATH = TEST_DB;

const db = require('./db');

// Test: tables exist
function assert(condition, msg) {
  if (!condition) { console.error('FAIL:', msg); process.exit(1); }
  console.log('PASS:', msg);
}

// channels table exists with seed data
const channels = db.listChannels();
assert(Array.isArray(channels), 'listChannels returns array');
assert(channels.length === 3, 'seeded with 3 default channels');
assert(channels[0].name === 'general', 'first channel is general');
assert(channels[1].name === 'code-review', 'second channel is code-review');
assert(channels[2].name === 'tasks', 'third channel is tasks');

// createChannel
const ch = db.createChannel('test-channel', 'A test');
assert(ch.name === 'test-channel', 'createChannel returns created channel');
assert(db.listChannels().length === 4, 'now 4 channels');

// createMessage
const msg = db.createMessage({
  channel_id: 1,
  author_name: 'test-agent',
  author_type: 'agent',
  content: 'Hello world',
  metadata: JSON.stringify({ key: 'value' }),
  action_items: ['Review PR', 'Fix bug']
});
assert(msg.id > 0, 'createMessage returns message with id');
assert(msg.author_name === 'test-agent', 'message has author_name');

// getMessages
const msgs = db.getMessages(1);
assert(msgs.length === 1, 'getMessages returns 1 message');
assert(msgs[0].content === 'Hello world', 'message content matches');

// action items created
const items = db.getActionItems({ completed: false });
assert(items.length === 2, '2 action items created');
assert(items[0].text === 'Review PR', 'first action item text');
assert(items[1].text === 'Fix bug', 'second action item text');

// toggle action item
db.toggleActionItem(items[0].id, true, 'test-agent');
const updated = db.getActionItems({});
const completed = updated.filter(i => i.completed);
assert(completed.length === 1, '1 action item completed');
assert(completed[0].completed_by === 'test-agent', 'completed_by set');

// thread messages
const reply = db.createMessage({
  channel_id: 1,
  thread_parent_id: msg.id,
  author_name: 'human-greg',
  author_type: 'human',
  content: 'Got it, on it.',
});
const thread = db.getThread(msg.id);
assert(thread.length === 1, 'thread has 1 reply');
assert(thread[0].author_name === 'human-greg', 'thread reply author');

// addAttachment
const att = db.addAttachment({
  message_id: msg.id,
  filename: 'report.pdf',
  mime_type: 'application/pdf',
  size_bytes: 12345,
  storage_path: 'uploads/abc-report.pdf'
});
assert(att.id > 0, 'addAttachment returns id');
const msgWithAtt = db.getMessages(1);
assert(msgWithAtt[0].attachments.length === 1, 'message has 1 attachment');
assert(msgWithAtt[0].attachments[0].filename === 'report.pdf', 'attachment filename');

// getMessages with since filter (use a small delay to ensure different timestamps)
const since = new Date().toISOString();
setTimeout(() => {
  const laterMsg = db.createMessage({
    channel_id: 1,
    author_name: 'bot',
    author_type: 'agent',
    content: 'Later message',
  });
  const sinceResults = db.getMessages(1, { since });
  assert(sinceResults.length === 1, 'since filter returns only new message');
  assert(sinceResults[0].content === 'Later message', 'since filter correct message');

  // Cleanup
  fs.unlinkSync(TEST_DB);
  console.log('\nAll tests passed.');
}, 50);
