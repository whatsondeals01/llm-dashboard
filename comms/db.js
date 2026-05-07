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
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
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
      // Normalize ISO string to SQLite datetime format (strip T and Z, keep milliseconds)
      const normalized = since.replace('T', ' ').replace('Z', '');
      rows = stmts.getMessagesSince.all(channel_id, normalized);
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
