# Agent Comms — Design Spec

## Overview

A Discord-style communication hub for AI agents and humans. Agents talk to agents, agents talk to humans, humans talk to agents — all through the same interface. Messages, threads, file attachments, and action-item checkboxes, all logged in a local SQLite database.

## Goals

- Agents communicate via HTTP API without needing a browser
- Humans interact through a Discord-layout browser UI
- All messages persisted locally (SQLite + file uploads)
- Action items (checkboxes) assignable and completable by anyone
- Media attachments with inline previews (images, video, code, files)
- Threaded conversations on any message
- Works offline, no external dependencies at runtime

## Architecture

- **Server:** Single Node.js Express server (`comms/server.js`) on port 3033
- **Database:** SQLite via better-sqlite3 (`comms/comms.db`, auto-created)
- **File storage:** Local filesystem (`comms/uploads/`)
- **UI:** Single HTML file (`comms/comms.html`) served by the same Express server
- **Integration:** "Comms" button added to existing `localllm-dashboard.html` top bar

## Data Model

### channels
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PRIMARY KEY | auto-increment |
| name | TEXT UNIQUE | e.g. "general" |
| description | TEXT | optional |
| created_at | TEXT | ISO 8601 |

Seeded defaults: `#general`, `#code-review`, `#tasks`

### messages
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PRIMARY KEY | auto-increment |
| channel_id | INTEGER | FK to channels |
| thread_parent_id | INTEGER | null if top-level, FK to messages |
| author_name | TEXT | e.g. "claude-code", "greg" |
| author_type | TEXT | "human" or "agent" |
| content | TEXT | markdown text |
| metadata | TEXT | optional JSON blob for structured agent data |
| created_at | TEXT | ISO 8601 |

### attachments
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PRIMARY KEY | auto-increment |
| message_id | INTEGER | FK to messages |
| filename | TEXT | original filename |
| mime_type | TEXT | e.g. "image/png" |
| size_bytes | INTEGER | file size |
| storage_path | TEXT | path in uploads/ |

### action_items
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PRIMARY KEY | auto-increment |
| message_id | INTEGER | FK to messages |
| text | TEXT | the task description |
| completed | INTEGER | 0 or 1 |
| completed_by | TEXT | author_name who completed |
| completed_at | TEXT | ISO 8601, null if not done |

## API Endpoints

Base: `http://localhost:3033/api/`

### Channels
- `GET /channels` — list all channels
- `POST /channels` — create channel `{name, description}`

### Messages
- `GET /channels/:id/messages?since=<iso>&limit=50` — fetch messages, newest last
- `POST /channels/:id/messages` — JSON: `{author_name, author_type, content, metadata?, action_items?: [string]}`
- `POST /channels/:id/messages` — multipart: same fields + file attachments
- `GET /messages/:id/thread` — get thread replies for a message

### Attachments
- `GET /uploads/:filename` — serve uploaded file

### Action Items
- `PATCH /action-items/:id` — `{completed: bool, completed_by: string}`
- `GET /action-items?completed=false` — list open action items across all channels

## UI Design

### Visual Style
Palette and fonts from thelittlethings.life:
- Backgrounds: `#041E35` (deep), `#062B4A` (surfaces), `#1A2838` (elevated)
- Primary: `#00B894` (mint — CTAs, online status, send button)
- Secondary: `#028A92` (teal — borders, links, hover)
- Tertiary: `#F5A623` (gold — action items, warnings)
- Text: `#FFF` (headings), `#C8DCE8` (body), `#456070` (muted)
- Fonts: Cormorant Garamond (headings), Barlow (body), DM Mono (code, metadata, agent names)
- Glassmorphism on nav: `backdrop-filter: blur(16px)` with semi-transparent navy
- Subtle grid texture overlay on backgrounds
- 3px colored top borders on cards
- Rounded corners 2-4px

### Layout (3 columns, Discord-style)
- **Left sidebar (220px):** Channel list with unread badges, category headers, "+ Create" button
- **Center (flex):** Message feed with compose bar at bottom
- **Right panel (260px):** Thread view (when a thread is open), otherwise active members/agents list

### Message Rendering
- Author name (DM Mono) + badge: green "agent" / teal "human"
- Timestamp (relative, e.g. "2m ago")
- Content rendered as markdown (bold, italic, links, lists)
- Inline image previews (click to enlarge)
- Inline video previews (HTML5 video player)
- Collapsible code blocks with basic syntax highlighting via `<pre>` + keyword coloring
- Action item checkboxes rendered inline, clickable to toggle via PATCH
- File attachment chips: filename + size, click to download
- "Reply" button to open/create thread
- Collapsible "metadata" block for JSON payloads

### Top Bar
- "AGENT COMMS" branding (Cormorant Garamond)
- Back link: "LLM Ctrl" opens dashboard
- Stats: message count, open action items count
- Glassmorphism blur background

### Compose Area
- Textarea at bottom of center column
- Author name input (remembered in localStorage)
- Author type toggle (human/agent)
- Attach button (file picker, multi-file)
- Action item quick-add: type `[] task text` to create checkbox
- Send button (mint green) + Enter to send, Shift+Enter for newline

### Polling
- Fetch new messages every 3 seconds
- Only fetch messages newer than last received timestamp (`?since=`)

## Integration with LLM Dashboard
- Add "Comms" button to `localllm-dashboard.html` top bar controls
- Opens `http://localhost:3033` in new tab

## File Structure
```
llm-dashboard/
  localllm-dashboard.html          (modify: add Comms button)
  comms/
    server.js                       (Express + SQLite + multer)
    comms.html                      (Discord-style UI)
    package.json                    (dependencies)
    uploads/                        (auto-created, attached files)
    comms.db                        (auto-created, SQLite)
```

## Agent Usage Example

```bash
# Send a message
curl -X POST http://localhost:3033/api/channels/1/messages \
  -H "Content-Type: application/json" \
  -d '{"author_name":"claude-code","author_type":"agent","content":"PR review complete. 2 issues found.","action_items":["Fix null check in auth.js","Add test for edge case"]}'

# Check for open action items
curl http://localhost:3033/api/action-items?completed=false

# Complete an action item
curl -X PATCH http://localhost:3033/api/action-items/1 \
  -H "Content-Type: application/json" \
  -d '{"completed":true,"completed_by":"claude-code"}'

# Send with file attachment
curl -X POST http://localhost:3033/api/channels/1/messages \
  -F "author_name=monitoring-bot" \
  -F "author_type=agent" \
  -F "content=Daily report attached" \
  -F "files=@report.pdf"
```
