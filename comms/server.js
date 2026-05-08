const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');

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

// Ollama proxy — MUST be before express.json() so body isn't consumed
app.all('/ollama/*', (req, res) => {
  const ollamaPath = req.params[0];
  const options = {
    hostname: '100.80.126.45',
    port: 11434,
    path: '/' + ollamaPath + (req._parsedUrl.search || ''),
    method: req.method,
    headers: { ...req.headers, host: '100.80.126.45:11434' },
  };
  // Remove hop-by-hop headers
  delete options.headers['connection'];
  delete options.headers['transfer-encoding'];

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (e) => {
    res.status(502).json({ error: 'Ollama proxy error: ' + e.message });
  });
  req.pipe(proxyReq);
});

app.use(express.json());

// Redirect root to comms.html
app.get('/', (req, res) => res.redirect('/comms.html'));

// Serve static UI
app.use(express.static(__dirname));
// Also serve parent directory (dashboard)
app.use(express.static(path.join(__dirname, '..')));

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
    // Re-fetch single message to include attachments
    const enriched = db.getMessageById(msg.id) || msg;
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
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Agent Comms server running on http://0.0.0.0:${PORT}`);
});

module.exports = server;
