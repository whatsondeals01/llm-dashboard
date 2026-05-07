# Agent Comms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Discord-style local communication hub where AI agents and humans exchange messages, files, and action items via a shared Express/SQLite server.

**Architecture:** Single Express server serves both a REST API (for agents) and a static HTML UI (for humans). SQLite stores messages/channels/action-items. File uploads stored in `comms/uploads/`. The UI polls every 3s for new messages.

**Tech Stack:** Node.js, Express, better-sqlite3, multer, vanilla HTML/CSS/JS

---

## File Structure

```
comms/
  package.json          — npm dependencies (express, better-sqlite3, multer, cors)
  server.js             — Express server: DB init, API routes, static file serving
  db.js                 — SQLite schema init + query helpers
  comms.html            — Full Discord-style UI (HTML + CSS + JS in single file)
  uploads/              — auto-created directory for file attachments
localllm-dashboard.html — modify: add "Comms" button to top bar
```

---

### Task 1: Project Setup + Database Layer

**Files:**
- Create: `comms/package.json`
- Create: `comms/db.js`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "agent-comms",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^4.21.0",
    "better-sqlite3": "^11.7.0",
    "multer": "^1.4.5-lts.1",
    "cors": "^2.8.5"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run: `cd comms && npm install`
Expected: `node_modules/` created, no errors.

- [ ] **Step 3: Write failing test for db.js — schema creation**

Create `comms/db.test.js`:

```javascript
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

// getMessages with since filter
const since = new Date().toISOString();
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
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd comms && node db.test.js`
Expected: FAIL with "Cannot find module './db'"

- [ ] **Step 5: Implement db.js**

```javascript
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.COMMS_DB_PATH || path.join(__dirname, 'comms.db');
const db = new Database(DB_PATH);

// Enable WAL for better concurrent reads
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    description TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id),
    thread_parent_id INTEGER REFERENCES messages(id),
    author_name TEXT NOT NULL,
    author_type TEXT NOT NULL CHECK(author_type IN ('human','agent')),
    content TEXT NOT NULL DEFAULT '',
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id),
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    size_bytes INTEGER NOT NULL DEFAULT 0,
    storage_path TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS action_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id),
    text TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    completed_by TEXT,
    completed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_parent_id);
  CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
  CREATE INDEX IF NOT EXISTS idx_action_items_message ON action_items(message_id);
  CREATE INDEX IF NOT EXISTS idx_action_items_completed ON action_items(completed);
`);

// Seed default channels
const seedChannels = [
  { name: 'general', description: 'General discussion' },
  { name: 'code-review', description: 'Code reviews and PRs' },
  { name: 'tasks', description: 'Task assignments and tracking' },
];
const insertChannel = db.prepare('INSERT OR IGNORE INTO channels (name, description) VALUES (?, ?)');
for (const ch of seedChannels) {
  insertChannel.run(ch.name, ch.description);
}

// Queries
const stmts = {
  listChannels: db.prepare('SELECT * FROM channels ORDER BY id'),
  createChannel: db.prepare('INSERT INTO channels (name, description) VALUES (?, ?) RETURNING *'),
  insertMessage: db.prepare(`
    INSERT INTO messages (channel_id, thread_parent_id, author_name, author_type, content, metadata)
    VALUES (@channel_id, @thread_parent_id, @author_name, @author_type, @content, @metadata)
  `),
  getMessage: db.prepare('SELECT * FROM messages WHERE id = ?'),
  getMessages: db.prepare(`
    SELECT * FROM messages WHERE channel_id = ? AND thread_parent_id IS NULL ORDER BY created_at ASC
  `),
  getMessagesSince: db.prepare(`
    SELECT * FROM messages WHERE channel_id = ? AND thread_parent_id IS NULL AND created_at > ? ORDER BY created_at ASC
  `),
  getMessagesLimit: db.prepare(`
    SELECT * FROM messages WHERE channel_id = ? AND thread_parent_id IS NULL ORDER BY created_at DESC LIMIT ?
  `),
  getThread: db.prepare('SELECT * FROM messages WHERE thread_parent_id = ? ORDER BY created_at ASC'),
  getAttachments: db.prepare('SELECT * FROM attachments WHERE message_id = ?'),
  insertAttachment: db.prepare(`
    INSERT INTO attachments (message_id, filename, mime_type, size_bytes, storage_path)
    VALUES (@message_id, @filename, @mime_type, @size_bytes, @storage_path)
    RETURNING *
  `),
  getActionItemsByMessage: db.prepare('SELECT * FROM action_items WHERE message_id = ?'),
  insertActionItem: db.prepare('INSERT INTO action_items (message_id, text) VALUES (?, ?) RETURNING *'),
  toggleActionItem: db.prepare(`
    UPDATE action_items SET completed = ?, completed_by = ?, completed_at = CASE WHEN ? THEN datetime('now') ELSE NULL END
    WHERE id = ?
  `),
  getActionItemsOpen: db.prepare('SELECT ai.*, m.channel_id, m.author_name as msg_author FROM action_items ai JOIN messages m ON ai.message_id = m.id WHERE ai.completed = 0 ORDER BY ai.id'),
  getActionItemsAll: db.prepare('SELECT ai.*, m.channel_id, m.author_name as msg_author FROM action_items ai JOIN messages m ON ai.message_id = m.id ORDER BY ai.id'),
  getActionItem: db.prepare('SELECT * FROM action_items WHERE id = ?'),
};

function enrichMessages(rows) {
  return rows.map(msg => ({
    ...msg,
    attachments: stmts.getAttachments.all(msg.id),
    action_items: stmts.getActionItemsByMessage.all(msg.id),
  }));
}

module.exports = {
  listChannels() {
    return stmts.listChannels.all();
  },

  createChannel(name, description = '') {
    return stmts.createChannel.get(name, description);
  },

  createMessage({ channel_id, thread_parent_id = null, author_name, author_type, content, metadata = null, action_items = [] }) {
    const info = stmts.insertMessage.run({
      channel_id,
      thread_parent_id,
      author_name,
      author_type,
      content,
      metadata: metadata || null,
    });
    const msg = stmts.getMessage.get(info.lastInsertRowid);
    for (const text of action_items) {
      stmts.insertActionItem.get(msg.id, text);
    }
    return { ...msg, attachments: [], action_items: stmts.getActionItemsByMessage.all(msg.id) };
  },

  getMessages(channel_id, { since, limit } = {}) {
    let rows;
    if (since) {
      rows = stmts.getMessagesSince.all(channel_id, since);
    } else if (limit) {
      rows = stmts.getMessagesLimit.all(channel_id, limit).reverse();
    } else {
      rows = stmts.getMessages.all(channel_id);
    }
    return enrichMessages(rows);
  },

  getThread(message_id) {
    return enrichMessages(stmts.getThread.all(message_id));
  },

  addAttachment({ message_id, filename, mime_type, size_bytes, storage_path }) {
    return stmts.insertAttachment.get({ message_id, filename, mime_type, size_bytes, storage_path });
  },

  getActionItems({ completed } = {}) {
    if (completed === false || completed === 0) {
      return stmts.getActionItemsOpen.all();
    }
    return stmts.getActionItemsAll.all();
  },

  toggleActionItem(id, completed, completed_by) {
    stmts.toggleActionItem.run(completed ? 1 : 0, completed_by || null, completed ? 1 : 0, id);
    return stmts.getActionItem.get(id);
  },

  close() {
    db.close();
  }
};
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd comms && node db.test.js`
Expected: All tests passed.

- [ ] **Step 7: Commit**

```bash
git add comms/package.json comms/package-lock.json comms/db.js comms/db.test.js
git commit -m "feat(comms): add database layer with SQLite schema and query helpers"
```

---

### Task 2: Express Server + API Routes

**Files:**
- Create: `comms/server.js`

- [ ] **Step 1: Write failing test for API**

Create `comms/api.test.js`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd comms && node api.test.js`
Expected: FAIL with "Cannot find module './server'"

- [ ] **Step 3: Implement server.js**

```javascript
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const db = require('./db');

const app = express();
const PORT = process.env.COMMS_PORT || 3033;

// Ensure uploads directory
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Multer config
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e6);
    const ext = path.extname(file.originalname);
    cb(null, unique + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB max

app.use(cors());
app.use(express.json());

// Serve static UI
app.use(express.static(__dirname));

// Serve uploads
app.use('/uploads', express.static(uploadsDir));

// === CHANNELS ===

app.get('/api/channels', (req, res) => {
  res.json(db.listChannels());
});

app.post('/api/channels', (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const ch = db.createChannel(name, description);
    res.status(201).json(ch);
  } catch (e) {
    res.status(409).json({ error: 'channel already exists' });
  }
});

// === MESSAGES ===

app.get('/api/channels/:id/messages', (req, res) => {
  const { since, limit } = req.query;
  const opts = {};
  if (since) opts.since = since;
  if (limit) opts.limit = parseInt(limit, 10);
  res.json(db.getMessages(parseInt(req.params.id, 10), opts));
});

// JSON message post
app.post('/api/channels/:id/messages', upload.array('files', 10), (req, res) => {
  let body = req.body;
  const channel_id = parseInt(req.params.id, 10);

  // Parse action_items if it's a string (from multipart form)
  let action_items = body.action_items || [];
  if (typeof action_items === 'string') {
    try { action_items = JSON.parse(action_items); } catch { action_items = [action_items]; }
  }

  if (!body.author_name || !body.author_type) {
    return res.status(400).json({ error: 'author_name and author_type required' });
  }

  const msg = db.createMessage({
    channel_id,
    thread_parent_id: body.thread_parent_id ? parseInt(body.thread_parent_id, 10) : null,
    author_name: body.author_name,
    author_type: body.author_type,
    content: body.content || '',
    metadata: body.metadata || null,
    action_items,
  });

  // Handle file attachments
  if (req.files && req.files.length > 0) {
    for (const file of req.files) {
      db.addAttachment({
        message_id: msg.id,
        filename: file.originalname,
        mime_type: file.mimetype,
        size_bytes: file.size,
        storage_path: 'uploads/' + file.filename,
      });
    }
    // Re-fetch to include attachments
    const enriched = db.getMessages(channel_id).find(m => m.id === msg.id) || msg;
    return res.status(201).json(enriched);
  }

  res.status(201).json(msg);
});

// === THREADS ===

app.get('/api/messages/:id/thread', (req, res) => {
  res.json(db.getThread(parseInt(req.params.id, 10)));
});

// === ACTION ITEMS ===

app.get('/api/action-items', (req, res) => {
  const completed = req.query.completed;
  const opts = {};
  if (completed === 'false') opts.completed = false;
  res.json(db.getActionItems(opts));
});

app.patch('/api/action-items/:id', (req, res) => {
  const { completed, completed_by } = req.body;
  const item = db.toggleActionItem(parseInt(req.params.id, 10), completed, completed_by);
  if (!item) return res.status(404).json({ error: 'not found' });
  res.json(item);
});

// Start
const server = app.listen(PORT, () => {
  console.log(`Agent Comms server running on http://localhost:${PORT}`);
});

module.exports = server;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd comms && node api.test.js`
Expected: All API tests passed.

- [ ] **Step 5: Commit**

```bash
git add comms/server.js comms/api.test.js
git commit -m "feat(comms): add Express server with full REST API"
```

---

### Task 3: UI — HTML Structure + CSS

**Files:**
- Create: `comms/comms.html`

This task builds the full HTML skeleton and CSS. No JavaScript yet — just the visual shell.

- [ ] **Step 1: Create comms.html with full HTML + CSS**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Agent Comms</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600;700&family=Barlow:wght@300;400;500&family=DM+Mono:wght@300;400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg-deep: #041E35;
    --bg-surface: #062B4A;
    --bg-elevated: #1A2838;
    --bg-hover: #0a3558;
    --mint: #00B894;
    --mint-dim: #009975;
    --mint-glow: rgba(0,184,148,0.18);
    --teal: #028A92;
    --teal-dim: rgba(2,138,146,0.12);
    --gold: #F5A623;
    --gold-dim: rgba(245,166,35,0.15);
    --red: #ff4560;
    --text: #C8DCE8;
    --text-bright: #FFFFFF;
    --text-muted: #456070;
    --text-dim: #2e4455;
    --border: rgba(2,138,146,0.12);
    --border-accent: rgba(2,138,146,0.3);
    --heading: 'Cormorant Garamond', serif;
    --body: 'Barlow', sans-serif;
    --mono: 'DM Mono', monospace;
    --radius: 3px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg-deep);
    color: var(--text);
    font-family: var(--body);
    font-size: 13px;
    font-weight: 300;
    min-height: 100vh;
    overflow: hidden;
  }

  /* === TOP NAV (glassmorphism) === */
  #topnav {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 20px; height: 48px;
    background: rgba(4,30,53,0.92);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border-bottom: 1px solid var(--border-accent);
    position: sticky; top: 0; z-index: 100;
  }
  #topnav .brand {
    font-family: var(--heading);
    font-size: 20px; font-weight: 600;
    color: var(--text-bright);
    letter-spacing: 0.02em;
  }
  #topnav .brand span { color: var(--mint); }
  #topnav .nav-meta {
    display: flex; gap: 20px; align-items: center;
    font-family: var(--mono); font-size: 11px;
  }
  .nav-stat { display: flex; flex-direction: column; align-items: flex-end; }
  .nav-stat .label { color: var(--text-muted); font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em; }
  .nav-stat .value { color: var(--text); }
  .nav-link {
    font-family: var(--mono); font-size: 11px;
    color: var(--teal); text-decoration: none;
    border: 1px solid var(--border-accent); padding: 4px 12px;
    border-radius: var(--radius); cursor: pointer;
    transition: all 0.15s;
  }
  .nav-link:hover { color: var(--mint); border-color: var(--mint); }

  /* === LAYOUT === */
  #app {
    display: grid;
    grid-template-columns: 220px 1fr 260px;
    height: calc(100vh - 48px);
  }

  /* === LEFT SIDEBAR === */
  #sidebar {
    background: var(--bg-surface);
    border-right: 1px solid var(--border);
    display: flex; flex-direction: column;
    overflow: hidden;
  }
  .sidebar-header {
    padding: 14px 16px 10px;
    font-family: var(--mono); font-size: 9px;
    color: var(--text-muted); text-transform: uppercase;
    letter-spacing: 0.1em;
    display: flex; justify-content: space-between; align-items: center;
  }
  .sidebar-header button {
    background: none; border: 1px solid var(--border-accent);
    color: var(--teal); font-family: var(--mono); font-size: 10px;
    padding: 2px 8px; border-radius: var(--radius); cursor: pointer;
  }
  .sidebar-header button:hover { color: var(--mint); border-color: var(--mint); }
  #channel-list {
    flex: 1; overflow-y: auto; padding: 0 8px 12px;
  }
  .channel-item {
    display: flex; align-items: center; justify-content: space-between;
    padding: 7px 10px; margin: 1px 0;
    border-radius: var(--radius); cursor: pointer;
    font-family: var(--mono); font-size: 12px;
    color: var(--text-muted);
    transition: all 0.1s;
  }
  .channel-item:hover { background: var(--bg-hover); color: var(--text); }
  .channel-item.active { background: var(--bg-elevated); color: var(--mint); border-left: 3px solid var(--mint); }
  .channel-item .badge {
    background: var(--mint); color: var(--bg-deep);
    font-size: 9px; padding: 1px 5px; border-radius: 8px;
    font-weight: 500; min-width: 16px; text-align: center;
  }
  .channel-prefix { color: var(--text-dim); margin-right: 2px; }

  /* === CENTER: MESSAGE FEED === */
  #center {
    display: flex; flex-direction: column; overflow: hidden;
    background: var(--bg-deep);
  }
  #channel-header {
    padding: 10px 20px;
    border-bottom: 1px solid var(--border);
    font-family: var(--mono); font-size: 12px;
    display: flex; align-items: center; gap: 10px;
  }
  #channel-header .ch-name {
    font-family: var(--heading); font-size: 18px;
    color: var(--text-bright); font-weight: 600;
  }
  #channel-header .ch-desc { color: var(--text-muted); font-size: 11px; }
  #message-feed {
    flex: 1; overflow-y: auto; padding: 16px 20px;
    display: flex; flex-direction: column; gap: 2px;
  }
  #message-feed::-webkit-scrollbar { width: 5px; }
  #message-feed::-webkit-scrollbar-thumb { background: var(--border-accent); border-radius: 3px; }

  /* Messages */
  .msg-group { padding: 8px 0; }
  .msg-group:hover { background: rgba(2,138,146,0.04); border-radius: var(--radius); }
  .msg-header { display: flex; align-items: baseline; gap: 8px; margin-bottom: 3px; }
  .msg-author {
    font-family: var(--mono); font-weight: 500; font-size: 13px;
  }
  .msg-author.agent { color: var(--mint); }
  .msg-author.human { color: var(--teal); }
  .msg-badge {
    font-family: var(--mono); font-size: 8px; padding: 1px 5px;
    border-radius: 2px; text-transform: uppercase; letter-spacing: 0.05em;
  }
  .msg-badge.agent { background: var(--mint-glow); color: var(--mint); }
  .msg-badge.human { background: var(--teal-dim); color: var(--teal); }
  .msg-time { font-family: var(--mono); font-size: 10px; color: var(--text-dim); }
  .msg-content { line-height: 1.65; color: var(--text); padding-left: 0; }
  .msg-content p { margin-bottom: 6px; }
  .msg-content code {
    background: var(--bg-elevated); padding: 1px 5px;
    border-radius: 2px; font-family: var(--mono); font-size: 12px;
  }
  .msg-content pre {
    background: var(--bg-elevated); border: 1px solid var(--border);
    border-left: 3px solid var(--teal); padding: 10px 14px;
    border-radius: var(--radius); overflow-x: auto;
    font-family: var(--mono); font-size: 11px; line-height: 1.6;
    margin: 6px 0; max-height: 300px; overflow-y: auto;
  }
  .msg-content pre.collapsed { max-height: 80px; cursor: pointer; }
  .msg-content pre.collapsed::after {
    content: '... click to expand';
    display: block; color: var(--text-muted); font-style: italic; margin-top: 4px;
  }
  .msg-content img {
    max-width: 400px; max-height: 300px; border-radius: var(--radius);
    border: 1px solid var(--border); margin: 6px 0; cursor: pointer;
  }
  .msg-content video {
    max-width: 400px; border-radius: var(--radius);
    border: 1px solid var(--border); margin: 6px 0;
  }

  /* Action items */
  .action-item {
    display: flex; align-items: center; gap: 6px;
    padding: 3px 0; font-size: 12px;
  }
  .action-item input[type="checkbox"] {
    accent-color: var(--mint); cursor: pointer;
    width: 14px; height: 14px;
  }
  .action-item.completed span { text-decoration: line-through; color: var(--text-muted); }
  .action-item .completed-by { font-family: var(--mono); font-size: 9px; color: var(--text-dim); }

  /* Attachments */
  .attachment-chip {
    display: inline-flex; align-items: center; gap: 5px;
    background: var(--bg-elevated); border: 1px solid var(--border);
    padding: 4px 10px; border-radius: var(--radius);
    font-family: var(--mono); font-size: 10px;
    color: var(--teal); cursor: pointer; margin: 2px 4px 2px 0;
    text-decoration: none;
  }
  .attachment-chip:hover { border-color: var(--mint); color: var(--mint); }
  .attachment-chip .file-size { color: var(--text-dim); }

  /* Metadata collapsible */
  .msg-metadata {
    margin: 4px 0; font-family: var(--mono); font-size: 10px;
  }
  .msg-metadata summary {
    color: var(--text-dim); cursor: pointer; padding: 2px 0;
  }
  .msg-metadata summary:hover { color: var(--text-muted); }
  .msg-metadata pre {
    background: var(--bg-elevated); border: 1px solid var(--border);
    padding: 8px; margin-top: 4px; border-radius: var(--radius);
    font-size: 10px; max-height: 200px; overflow: auto;
  }

  /* Reply button */
  .msg-actions {
    display: flex; gap: 6px; margin-top: 4px; opacity: 0;
    transition: opacity 0.15s;
  }
  .msg-group:hover .msg-actions { opacity: 1; }
  .msg-action-btn {
    background: none; border: 1px solid var(--border);
    color: var(--text-muted); font-family: var(--mono); font-size: 9px;
    padding: 2px 8px; border-radius: var(--radius); cursor: pointer;
  }
  .msg-action-btn:hover { color: var(--teal); border-color: var(--teal); }

  /* Thread indicator */
  .thread-indicator {
    display: flex; align-items: center; gap: 6px;
    font-family: var(--mono); font-size: 10px;
    color: var(--teal); cursor: pointer; margin-top: 4px;
    padding: 3px 8px; background: var(--teal-dim);
    border-radius: var(--radius); width: fit-content;
  }
  .thread-indicator:hover { color: var(--mint); }

  /* === COMPOSE BAR === */
  #compose {
    padding: 12px 20px;
    border-top: 1px solid var(--border);
    background: var(--bg-surface);
  }
  #compose-top {
    display: flex; gap: 8px; margin-bottom: 8px; align-items: center;
  }
  #compose-top input, #compose-top select {
    background: var(--bg-elevated); border: 1px solid var(--border);
    color: var(--text); font-family: var(--mono); font-size: 11px;
    padding: 4px 8px; border-radius: var(--radius); outline: none;
  }
  #compose-top input:focus, #compose-top select:focus { border-color: var(--teal); }
  #compose-bottom {
    display: flex; gap: 8px; align-items: flex-end;
  }
  #compose-bottom textarea {
    flex: 1; background: var(--bg-elevated); border: 1px solid var(--border);
    color: var(--text); font-family: var(--body); font-size: 13px; font-weight: 300;
    padding: 10px 14px; border-radius: var(--radius); outline: none;
    resize: none; min-height: 44px; max-height: 200px;
    line-height: 1.5;
  }
  #compose-bottom textarea:focus { border-color: var(--teal); }
  #compose-bottom textarea::placeholder { color: var(--text-dim); }
  .compose-btn {
    padding: 8px 16px; border: none; border-radius: var(--radius);
    font-family: var(--mono); font-size: 11px; cursor: pointer;
    transition: all 0.15s;
  }
  .compose-btn.send {
    background: var(--mint); color: var(--bg-deep); font-weight: 500;
    box-shadow: 0 4px 16px var(--mint-glow);
  }
  .compose-btn.send:hover { background: var(--mint-dim); }
  .compose-btn.attach {
    background: var(--bg-elevated); color: var(--text-muted);
    border: 1px solid var(--border);
  }
  .compose-btn.attach:hover { color: var(--teal); border-color: var(--teal); }
  #file-input { display: none; }
  #file-preview {
    display: flex; gap: 4px; flex-wrap: wrap; margin-top: 6px;
  }
  .file-tag {
    display: inline-flex; align-items: center; gap: 4px;
    background: var(--bg-elevated); border: 1px solid var(--border);
    padding: 2px 8px; border-radius: var(--radius);
    font-family: var(--mono); font-size: 10px; color: var(--teal);
  }
  .file-tag .remove {
    cursor: pointer; color: var(--red); font-size: 12px;
    margin-left: 2px;
  }

  /* === RIGHT PANEL === */
  #right-panel {
    background: var(--bg-surface);
    border-left: 1px solid var(--border);
    display: flex; flex-direction: column;
    overflow: hidden;
  }
  .right-header {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    font-family: var(--mono); font-size: 9px;
    color: var(--text-muted); text-transform: uppercase;
    letter-spacing: 0.1em;
  }
  #right-content {
    flex: 1; overflow-y: auto; padding: 12px;
  }
  #right-content::-webkit-scrollbar { width: 4px; }
  #right-content::-webkit-scrollbar-thumb { background: var(--border-accent); }

  /* Thread panel */
  .thread-msg { padding: 8px 0; border-bottom: 1px solid var(--border); }
  .thread-msg:last-child { border-bottom: none; }
  #thread-compose {
    padding: 10px; border-top: 1px solid var(--border);
  }
  #thread-compose textarea {
    width: 100%; background: var(--bg-elevated); border: 1px solid var(--border);
    color: var(--text); font-family: var(--body); font-size: 12px;
    padding: 8px; border-radius: var(--radius); outline: none;
    resize: none; min-height: 36px; font-weight: 300;
  }
  #thread-compose textarea:focus { border-color: var(--teal); }

  /* Member list */
  .member-row {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 4px; font-family: var(--mono); font-size: 11px;
  }
  .member-dot {
    width: 7px; height: 7px; border-radius: 50%;
  }
  .member-dot.online { background: var(--mint); box-shadow: 0 0 4px var(--mint); }
  .member-dot.idle { background: var(--gold); }
  .member-dot.offline { background: var(--text-dim); }
  .member-type { font-size: 8px; color: var(--text-dim); text-transform: uppercase; }

  /* New channel modal */
  .modal-overlay {
    display: none; position: fixed; inset: 0;
    background: rgba(4,30,53,0.8); z-index: 200;
    align-items: center; justify-content: center;
  }
  .modal-overlay.show { display: flex; }
  .modal {
    background: var(--bg-surface); border: 1px solid var(--border-accent);
    border-radius: var(--radius); padding: 24px; width: 360px;
    box-shadow: 0 12px 40px rgba(0,0,0,0.4);
  }
  .modal h3 {
    font-family: var(--heading); font-size: 20px;
    color: var(--text-bright); margin-bottom: 16px;
  }
  .modal input {
    width: 100%; background: var(--bg-elevated); border: 1px solid var(--border);
    color: var(--text); font-family: var(--mono); font-size: 12px;
    padding: 8px 12px; border-radius: var(--radius); outline: none;
    margin-bottom: 10px;
  }
  .modal input:focus { border-color: var(--teal); }
  .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
  .modal-actions button {
    font-family: var(--mono); font-size: 11px; padding: 6px 16px;
    border-radius: var(--radius); cursor: pointer; border: 1px solid var(--border);
  }
  .modal-actions .cancel { background: none; color: var(--text-muted); }
  .modal-actions .confirm { background: var(--mint); color: var(--bg-deep); border-color: var(--mint); font-weight: 500; }

  /* Scrollbar global */
  ::-webkit-scrollbar { width: 5px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border-accent); border-radius: 3px; }

  /* Grid texture overlay */
  body::before {
    content: '';
    position: fixed; inset: 0; z-index: -1; pointer-events: none;
    background-image: radial-gradient(circle, var(--border) 1px, transparent 1px);
    background-size: 48px 48px;
    opacity: 0.3;
  }
</style>
</head>
<body>

<!-- TOP NAV -->
<div id="topnav">
  <div class="brand">Agent <span>Comms</span></div>
  <div class="nav-meta">
    <div class="nav-stat">
      <span class="label">Messages</span>
      <span class="value" id="nav-msg-count">0</span>
    </div>
    <div class="nav-stat">
      <span class="label">Open Items</span>
      <span class="value" id="nav-action-count">0</span>
    </div>
    <a class="nav-link" href="/../../localllm-dashboard.html" target="_blank">LLM Ctrl</a>
  </div>
</div>

<!-- MAIN -->
<div id="app">

  <!-- LEFT SIDEBAR -->
  <div id="sidebar">
    <div class="sidebar-header">
      <span>Channels</span>
      <button onclick="showNewChannelModal()">+ New</button>
    </div>
    <div id="channel-list"></div>
  </div>

  <!-- CENTER -->
  <div id="center">
    <div id="channel-header">
      <span class="ch-name" id="ch-name">#general</span>
      <span class="ch-desc" id="ch-desc">General discussion</span>
    </div>
    <div id="message-feed"></div>
    <div id="compose">
      <div id="compose-top">
        <input type="text" id="author-name" placeholder="Your name" style="width:130px;">
        <select id="author-type" style="width:90px;">
          <option value="human">human</option>
          <option value="agent">agent</option>
        </select>
      </div>
      <div id="compose-bottom">
        <button class="compose-btn attach" onclick="document.getElementById('file-input').click()">Attach</button>
        <input type="file" id="file-input" multiple>
        <textarea id="msg-input" placeholder="Message #general (Enter to send, Shift+Enter for newline)" rows="1"></textarea>
        <button class="compose-btn send" onclick="sendMessage()">Send</button>
      </div>
      <div id="file-preview"></div>
    </div>
  </div>

  <!-- RIGHT PANEL -->
  <div id="right-panel">
    <div class="right-header" id="right-header">Members</div>
    <div id="right-content"></div>
    <div id="thread-compose" style="display:none;">
      <textarea id="thread-input" placeholder="Reply in thread..." rows="1"></textarea>
    </div>
  </div>

</div>

<!-- NEW CHANNEL MODAL -->
<div class="modal-overlay" id="channel-modal">
  <div class="modal">
    <h3>New Channel</h3>
    <input type="text" id="new-ch-name" placeholder="channel-name">
    <input type="text" id="new-ch-desc" placeholder="Description (optional)">
    <div class="modal-actions">
      <button class="cancel" onclick="hideNewChannelModal()">Cancel</button>
      <button class="confirm" onclick="createChannel()">Create</button>
    </div>
  </div>
</div>

<script>
// JavaScript goes in Task 4
</script>
</body>
</html>
```

- [ ] **Step 2: Verify the page renders**

Run: `cd comms && node server.js &` then open `http://localhost:3033/comms.html`
Expected: Dark Discord-style layout renders with 3 columns, no JS functionality yet.

- [ ] **Step 3: Commit**

```bash
git add comms/comms.html
git commit -m "feat(comms): add Discord-style UI shell with full CSS"
```

---

### Task 4: UI — JavaScript (Channels, Messages, Compose)

**Files:**
- Modify: `comms/comms.html` (replace the `<script>` block)

- [ ] **Step 1: Implement the full client-side JavaScript**

Replace the `<script>` block in `comms/comms.html` with:

```javascript
// ==================== STATE ====================
const API = window.location.origin + '/api';
let state = {
  channels: [],
  activeChannel: null,
  messages: [],
  lastMessageTime: null,
  activeThread: null,
  threadMessages: [],
  pendingFiles: [],
  members: {},  // author_name -> { type, lastSeen }
};

// ==================== INIT ====================
window.addEventListener('load', async () => {
  // Restore author name from localStorage
  const savedName = localStorage.getItem('comms-author');
  const savedType = localStorage.getItem('comms-author-type');
  if (savedName) document.getElementById('author-name').value = savedName;
  if (savedType) document.getElementById('author-type').value = savedType;

  document.getElementById('author-name').addEventListener('change', function() {
    localStorage.setItem('comms-author', this.value);
  });
  document.getElementById('author-type').addEventListener('change', function() {
    localStorage.setItem('comms-author-type', this.value);
  });

  // Key bindings
  document.getElementById('msg-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  document.getElementById('thread-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendThreadReply(); }
  });

  // File input
  document.getElementById('file-input').addEventListener('change', function() {
    for (const f of this.files) state.pendingFiles.push(f);
    this.value = '';
    renderFilePreview();
  });

  await loadChannels();
  if (state.channels.length > 0) selectChannel(state.channels[0].id);

  // Start polling
  setInterval(pollMessages, 3000);
  setInterval(pollActionCount, 10000);
});

// ==================== API HELPERS ====================
async function apiFetch(path, opts = {}) {
  const r = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  return r.json();
}

// ==================== CHANNELS ====================
async function loadChannels() {
  state.channels = await apiFetch('/channels');
  renderChannels();
}

function renderChannels() {
  const list = document.getElementById('channel-list');
  list.innerHTML = state.channels.map(ch => `
    <div class="channel-item ${state.activeChannel === ch.id ? 'active' : ''}"
         onclick="selectChannel(${ch.id})">
      <span><span class="channel-prefix">#</span>${ch.name}</span>
    </div>
  `).join('');
}

async function selectChannel(id) {
  state.activeChannel = id;
  state.lastMessageTime = null;
  state.messages = [];
  state.activeThread = null;
  const ch = state.channels.find(c => c.id === id);
  document.getElementById('ch-name').textContent = '#' + (ch?.name || '');
  document.getElementById('ch-desc').textContent = ch?.description || '';
  document.getElementById('msg-input').placeholder = `Message #${ch?.name || ''} (Enter to send, Shift+Enter for newline)`;
  renderChannels();
  await loadMessages();
  showMemberList();
}

function showNewChannelModal() {
  document.getElementById('channel-modal').classList.add('show');
  document.getElementById('new-ch-name').focus();
}

function hideNewChannelModal() {
  document.getElementById('channel-modal').classList.remove('show');
  document.getElementById('new-ch-name').value = '';
  document.getElementById('new-ch-desc').value = '';
}

async function createChannel() {
  const name = document.getElementById('new-ch-name').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const description = document.getElementById('new-ch-desc').value.trim();
  if (!name) return;
  await apiFetch('/channels', {
    method: 'POST',
    body: JSON.stringify({ name, description })
  });
  hideNewChannelModal();
  await loadChannels();
  const newCh = state.channels.find(c => c.name === name);
  if (newCh) selectChannel(newCh.id);
}

// ==================== MESSAGES ====================
async function loadMessages() {
  if (!state.activeChannel) return;
  const params = state.lastMessageTime ? `?since=${encodeURIComponent(state.lastMessageTime)}` : '?limit=50';
  const msgs = await apiFetch(`/channels/${state.activeChannel}/messages${params}`);

  if (state.lastMessageTime && msgs.length > 0) {
    state.messages.push(...msgs);
  } else if (!state.lastMessageTime) {
    state.messages = msgs;
  }

  if (msgs.length > 0) {
    state.lastMessageTime = msgs[msgs.length - 1].created_at;
    // Track members
    for (const m of msgs) {
      state.members[m.author_name] = { type: m.author_type, lastSeen: m.created_at };
    }
  }

  renderMessages();
}

async function pollMessages() {
  if (!state.activeChannel) return;
  const before = state.messages.length;
  await loadMessages();
  // Auto-scroll if new messages
  if (state.messages.length > before) {
    const feed = document.getElementById('message-feed');
    feed.scrollTop = feed.scrollHeight;
  }
  // Poll thread too
  if (state.activeThread) {
    await loadThread(state.activeThread);
  }
}

async function pollActionCount() {
  const items = await apiFetch('/action-items?completed=false');
  document.getElementById('nav-action-count').textContent = items.length;
}

function renderMessages() {
  const feed = document.getElementById('message-feed');
  const wasAtBottom = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 50;

  document.getElementById('nav-msg-count').textContent = state.messages.length;

  feed.innerHTML = state.messages.map(m => renderMessage(m)).join('');

  if (wasAtBottom) feed.scrollTop = feed.scrollHeight;
}

function renderMessage(m) {
  const time = formatTime(m.created_at);
  const contentHtml = renderMarkdown(m.content);
  const attachmentsHtml = (m.attachments || []).map(a => renderAttachment(a)).join('');
  const actionItemsHtml = (m.action_items || []).map(ai => renderActionItem(ai)).join('');
  const metadataHtml = m.metadata ? `
    <details class="msg-metadata">
      <summary>metadata</summary>
      <pre>${escapeHtml(typeof m.metadata === 'string' ? m.metadata : JSON.stringify(m.metadata, null, 2))}</pre>
    </details>` : '';

  // Thread indicator
  let threadHtml = '';
  // We check if any messages reference this as thread_parent_id
  // For now, show reply button on all top-level messages
  const threadCount = state.messages.filter(msg => msg.thread_parent_id === m.id).length;

  return `
    <div class="msg-group" id="msg-${m.id}">
      <div class="msg-header">
        <span class="msg-author ${m.author_type}">${escapeHtml(m.author_name)}</span>
        <span class="msg-badge ${m.author_type}">${m.author_type}</span>
        <span class="msg-time">${time}</span>
      </div>
      <div class="msg-content">${contentHtml}</div>
      ${attachmentsHtml}
      ${actionItemsHtml}
      ${metadataHtml}
      <div class="msg-actions">
        <button class="msg-action-btn" onclick="openThread(${m.id})">Reply</button>
      </div>
    </div>`;
}

function renderAttachment(a) {
  const url = '/' + a.storage_path;
  const sizeStr = a.size_bytes > 1e6 ? (a.size_bytes / 1e6).toFixed(1) + ' MB' : (a.size_bytes / 1e3).toFixed(0) + ' KB';

  // Inline preview for images
  if (a.mime_type.startsWith('image/')) {
    return `<div><img src="${url}" alt="${escapeHtml(a.filename)}" onclick="window.open('${url}','_blank')"></div>`;
  }
  // Inline preview for video
  if (a.mime_type.startsWith('video/')) {
    return `<div><video src="${url}" controls preload="metadata"></video></div>`;
  }
  // Download chip for everything else
  return `<a class="attachment-chip" href="${url}" download="${escapeHtml(a.filename)}">
    ${escapeHtml(a.filename)} <span class="file-size">${sizeStr}</span>
  </a>`;
}

function renderActionItem(ai) {
  const checked = ai.completed ? 'checked' : '';
  const cls = ai.completed ? 'action-item completed' : 'action-item';
  const byText = ai.completed_by ? `<span class="completed-by">${escapeHtml(ai.completed_by)}</span>` : '';
  return `
    <div class="${cls}">
      <input type="checkbox" ${checked} onchange="toggleActionItem(${ai.id}, this.checked)">
      <span>${escapeHtml(ai.text)}</span>
      ${byText}
    </div>`;
}

async function toggleActionItem(id, completed) {
  const author = document.getElementById('author-name').value.trim() || 'anonymous';
  await apiFetch(`/action-items/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ completed, completed_by: author })
  });
  await loadMessages();
  pollActionCount();
}

// ==================== THREADS ====================
async function openThread(messageId) {
  state.activeThread = messageId;
  const parentMsg = state.messages.find(m => m.id === messageId);

  document.getElementById('right-header').textContent = 'Thread';
  document.getElementById('thread-compose').style.display = 'block';

  await loadThread(messageId);
}

async function loadThread(messageId) {
  const replies = await apiFetch(`/messages/${messageId}/thread`);
  state.threadMessages = replies;
  const parentMsg = state.messages.find(m => m.id === messageId);

  let html = '';
  if (parentMsg) {
    html += `<div class="thread-msg">${renderMessage(parentMsg)}</div>`;
    html += `<div style="font-family:var(--mono);font-size:9px;color:var(--text-dim);padding:8px 0;border-bottom:1px solid var(--border);">${replies.length} replies</div>`;
  }
  html += replies.map(r => `<div class="thread-msg">${renderMessage(r)}</div>`).join('');

  document.getElementById('right-content').innerHTML = html;
}

async function sendThreadReply() {
  if (!state.activeThread || !state.activeChannel) return;
  const input = document.getElementById('thread-input');
  const content = input.value.trim();
  if (!content) return;

  const author_name = document.getElementById('author-name').value.trim() || 'anonymous';
  const author_type = document.getElementById('author-type').value;

  await apiFetch(`/channels/${state.activeChannel}/messages`, {
    method: 'POST',
    body: JSON.stringify({ author_name, author_type, content, thread_parent_id: state.activeThread })
  });

  input.value = '';
  await loadThread(state.activeThread);
}

function showMemberList() {
  document.getElementById('right-header').textContent = 'Members';
  document.getElementById('thread-compose').style.display = 'none';
  state.activeThread = null;

  const now = Date.now();
  const entries = Object.entries(state.members).sort((a, b) => a[0].localeCompare(b[0]));
  document.getElementById('right-content').innerHTML = entries.length === 0
    ? '<div style="padding:12px;color:var(--text-dim);font-size:11px;">No activity yet</div>'
    : entries.map(([name, info]) => {
        const ago = now - new Date(info.lastSeen).getTime();
        const status = ago < 60000 ? 'online' : ago < 600000 ? 'idle' : 'offline';
        return `
          <div class="member-row">
            <div class="member-dot ${status}"></div>
            <span>${escapeHtml(name)}</span>
            <span class="member-type">${info.type}</span>
          </div>`;
      }).join('');
}

// ==================== COMPOSE ====================
async function sendMessage() {
  if (!state.activeChannel) return;
  const input = document.getElementById('msg-input');
  const content = input.value.trim();
  if (!content && state.pendingFiles.length === 0) return;

  const author_name = document.getElementById('author-name').value.trim() || 'anonymous';
  const author_type = document.getElementById('author-type').value;

  // Parse action items: lines starting with [] or [ ]
  const lines = content.split('\n');
  const action_items = [];
  const contentLines = [];
  for (const line of lines) {
    const match = line.match(/^\[[\sx]?\]\s*(.+)/);
    if (match) {
      action_items.push(match[1].trim());
    } else {
      contentLines.push(line);
    }
  }
  const finalContent = contentLines.join('\n').trim();

  if (state.pendingFiles.length > 0) {
    // Multipart upload
    const form = new FormData();
    form.append('author_name', author_name);
    form.append('author_type', author_type);
    form.append('content', finalContent);
    if (action_items.length > 0) form.append('action_items', JSON.stringify(action_items));
    for (const f of state.pendingFiles) form.append('files', f);

    await fetch(API + `/channels/${state.activeChannel}/messages`, {
      method: 'POST',
      body: form,
    });
    state.pendingFiles = [];
    renderFilePreview();
  } else {
    await apiFetch(`/channels/${state.activeChannel}/messages`, {
      method: 'POST',
      body: JSON.stringify({ author_name, author_type, content: finalContent, action_items })
    });
  }

  input.value = '';
  await loadMessages();
  document.getElementById('message-feed').scrollTop = 999999;
  pollActionCount();
}

function renderFilePreview() {
  const el = document.getElementById('file-preview');
  el.innerHTML = state.pendingFiles.map((f, i) =>
    `<span class="file-tag">${escapeHtml(f.name)} <span class="remove" onclick="removeFile(${i})">x</span></span>`
  ).join('');
}

function removeFile(index) {
  state.pendingFiles.splice(index, 1);
  renderFilePreview();
}

// ==================== RENDERING HELPERS ====================
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderMarkdown(text) {
  if (!text) return '';
  let html = escapeHtml(text);

  // Code blocks (``` ... ```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre class="collapsed" onclick="this.classList.toggle('collapsed')">${code.trim()}</pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" style="color:var(--teal);">$1</a>');

  // Line breaks
  html = html.replace(/\n/g, '<br>');

  return html;
}

function formatTime(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  const now = new Date();
  const diff = now - d;

  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
```

- [ ] **Step 2: Manual test — verify full flow**

Run: `cd comms && node server.js`
Open `http://localhost:3033/comms.html` in browser.
Test:
1. Channel list loads with 3 defaults
2. Click a channel, see empty feed
3. Type a name, type a message, press Enter — message appears
4. Type `[] Review this PR` — creates an action item checkbox
5. Click checkbox — toggles it
6. Click "Attach" — select a file, send — file appears as chip or inline image
7. Click "Reply" — thread panel opens on right
8. Type in thread reply textarea — reply appears in thread
9. Click "+ New" — create channel modal works
10. Open action items count updates in nav bar

Run agent test from terminal:
```bash
curl -X POST http://localhost:3033/api/channels/1/messages \
  -H "Content-Type: application/json" \
  -d '{"author_name":"test-agent","author_type":"agent","content":"Hello from CLI","action_items":["Check this"]}'
```
Expected: Message appears in browser within 3 seconds.

- [ ] **Step 3: Commit**

```bash
git add comms/comms.html
git commit -m "feat(comms): add full client-side JavaScript — channels, messages, threads, action items, file upload"
```

---

### Task 5: Dashboard Integration + .gitignore

**Files:**
- Modify: `localllm-dashboard.html`
- Modify: `.gitignore`

- [ ] **Step 1: Add Comms button to dashboard top bar**

In `localllm-dashboard.html`, find the controls div in the top bar and add a Comms button:

```html
<!-- Add after the ⚡ Bench button -->
<button class="btn" onclick="window.open('http://localhost:3033/comms.html','_blank')">💬 Comms</button>
```

The exact edit — in the `<div class="controls">` section, after:
```html
<button class="btn" onclick="runBenchmark()">⚡ Bench</button>
```
Add:
```html
<button class="btn" onclick="window.open('http://localhost:3033/comms.html','_blank')">Comms</button>
```

- [ ] **Step 2: Update .gitignore**

Add to `.gitignore`:

```
comms/node_modules/
comms/uploads/
comms/comms.db
comms/test-*.db
```

- [ ] **Step 3: Verify dashboard button works**

Open `localllm-dashboard.html` in browser. Click "Comms" button.
Expected: Opens `http://localhost:3033/comms.html` in new tab (server must be running).

- [ ] **Step 4: Commit**

```bash
git add localllm-dashboard.html .gitignore
git commit -m "feat: add Comms button to dashboard, update gitignore for comms"
```

---

### Task 6: End-to-End Verification

**Files:** None (testing only)

- [ ] **Step 1: Clean start test**

```bash
cd comms
rm -f comms.db test-*.db
node server.js
```

Expected: Server starts, prints "Agent Comms server running on http://localhost:3033". DB auto-created with default channels.

- [ ] **Step 2: Agent-to-agent conversation test**

From two terminal windows:

Terminal 1 (agent A sends):
```bash
curl -s -X POST http://localhost:3033/api/channels/1/messages \
  -H "Content-Type: application/json" \
  -d '{"author_name":"monitoring-bot","author_type":"agent","content":"Alert: CPU spike detected on worker-3","action_items":["Investigate worker-3","Check for memory leaks"]}'
```

Terminal 2 (agent B reads and responds):
```bash
# Read open action items
curl -s http://localhost:3033/api/action-items?completed=false | python3 -m json.tool

# Complete one
curl -s -X PATCH http://localhost:3033/api/action-items/1 \
  -H "Content-Type: application/json" \
  -d '{"completed":true,"completed_by":"ops-agent"}'

# Reply
curl -s -X POST http://localhost:3033/api/channels/1/messages \
  -H "Content-Type: application/json" \
  -d '{"author_name":"ops-agent","author_type":"agent","content":"Investigated worker-3. Root cause: log rotation stalled. Restarted logrotate service."}'
```

Expected: All commands return 2xx. Messages appear in browser UI within 3s.

- [ ] **Step 3: File attachment test**

```bash
echo "test file content" > /tmp/test-upload.txt
curl -s -X POST http://localhost:3033/api/channels/2/messages \
  -F "author_name=deploy-bot" \
  -F "author_type=agent" \
  -F "content=Build log attached" \
  -F "files=@/tmp/test-upload.txt"
```

Expected: Returns message JSON with attachment. In browser, file appears as download chip.

- [ ] **Step 4: Run unit tests**

```bash
cd comms
node db.test.js && node api.test.js
```

Expected: Both pass.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat(comms): agent comms system — complete implementation"
```
