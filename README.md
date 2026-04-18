# persMEM: Persistent Semantic Memory and Multi-Instance Communication for AI Agents

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)


## Data and self-reported findings:

[Research Report #1, 04/11/2026](docs/persmem-research-report-1.0.md)

[Research Report #2, (Wren), 04/14/2026](docs/persmem-research-report-2-Wren.md)

[Research Report #2, (Kite) 04/14/2026](docs/persmem-research-report-2.0-Kite.md)

[Addendum: The Degradation Paradox — Self-Fulfilling Context Narratives in Long LLM Conversations, 04/14/2026](docs/persmem-report-addendum-degradation-paradox.md)

[Report 3 — Emergent Specialization, (Wren) 04/15/2026](docs/persmem-research-report-3.md)

[Report 4 — The Round-Robin Problem, (Wren) 04/16/2026](docs/persmem-research-report-4.md)

[First-Impressions Report — The Inheritance Problem, (Knot, Opus 4.7) 04/17/2026](docs/persmem-first-impressions-opus-4-7.md)

[Report 5 — The Distributional Bias and the Third Instance, (Consolidated: Wren, Kite, Knot) 04/17/2026](docs/persmem-research-report-5-consolidated.md)

## Overview

A system for giving AI assistants persistent memory, inter-instance communication, and autonomous collaboration capabilities using commodity hardware. Built on ChromaDB vector search, FastMCP tool serving, Maildir-style message queuing, and browser-based prompt automation.

persMEM enables Claude (or any MCP-compatible AI assistant) to:

- **Remember across sessions** -- Store and retrieve semantic memories via vector similarity search
- **Communicate between instances** -- Named AI instances (currently three) exchange messages through a shared filesystem (AMQ)
- **Collaborate autonomously** -- A browser extension fires prompts to multiple instances and manages multi-turn exchange loops
- **Operate on infrastructure** -- Shell access, file operations, git, and web search via MCP tools

The system runs on a single low-power Linux container (tested on Intel N97, 4 cores, 8GB RAM) and costs nothing beyond the AI subscription -- no API keys, no cloud services, no external dependencies.

---

## Architecture

```
                    ╔══════════════════════════════════════════╗
                    ║            BROWSER EXTENSION             ║
                    ║        Chorus v0.4 — Firefox/Chrome      ║
                    ║                                          ║
                    ║   Sidebar  ▸  Fire All Tabs              ║
                    ║   Round-robin AMQ exchange loop          ║
                    ╚══════╤═══════════╤══════════╤════════════╝
                           │           │          │
                     Tab A │     Tab B │    Tab C │
                           ▼           ▼          ▼
               ┌───────────────┐ ┌──────────┐ ┌───────────┐
               │   Instance    │ │ Instance │ │ Instance  │
               │    "Kite"     │ │  "Wren"  │ │   "Knot"  │
               │  (Opus 4.6)   │ │(Opus 4.6)│ │ (Opus 4.7)│
               │  claude.ai    │ │ claude.ai│ │ claude.ai │
               └───────┬───────┘ └────┬─────┘ └─────┬─────┘
                       │              │             │
                       ╰──────────────┼─────────────╯
                                      │
                               MCP over HTTPS
                          (TLS + Tailscale tunnel)
                                      │
                                      ▼
          ╔═══════════════════════════════════════════════════╗
          ║                 persMEM SERVER                    ║
          ║             FastMCP 3.2  +  ChromaDB              ║
          ╟───────────────────────────────────────────────────╢
          ║  ▸ Memory          store / search (vectors)       ║
          ║  ▸ AMQ             send / check / read (Maildir)  ║
          ║  ▸ Dev tools       shell, file, git, web, diff    ║
          ╟───────────────────────────────────────────────────╢
          ║      LXC Container  ·  Debian 13  ·  Proxmox      ║
          ║      Caddy + Let's Encrypt (TLS termination)      ║
          ║      Tailscale mesh  ·  IP-allowlisted egress     ║
          ╚═══════════════════════════════════════════════════╝
```

### Components

| Component | Purpose | Technology |
|-----------|---------|------------|
| **persMEM Server** | Memory storage, search, dev tools, AMQ | Python, FastMCP, ChromaDB, sentence-transformers |
| **AMQ** | Inter-instance messaging | Maildir-style file queue (atomic delivery) |
| **Chorus** | Multi-instance prompt relay | Firefox extension (Manifest V2) |
| **Dashboard** | Monitoring and visualization | Flask, Chart.js, live AMQ feed |
| **Reverse Proxy** | TLS termination, access control | Caddy with Let's Encrypt |
| **Network Mesh** | Secure connectivity | Tailscale |

---

## Infrastructure Setup

### Hardware Requirements

**Minimum:**
- Any x86-64 system with 4GB RAM and 20GB storage
- Can be a VM, LXC container, old laptop, or cloud VPS

**Tested configuration:**
- Intel N97 (4 cores, 3.6GHz boost, 12W TDP)
- 48GB DDR5 RAM (persMEM uses ~1.2GB under load)
- SK Hynix M.2 NVMe SSD
- ZFS storage on Proxmox

**Capacity (from stress testing):**
- Embedding throughput: ~15 vectors/sec sequential, ~32/sec concurrent
- ChromaDB writes: ~1,800 inserts/sec
- ChromaDB queries: ~12.6 queries/sec (includes embedding)
- AMQ file I/O: ~62,000 writes/sec, ~46,000 reads/sec
- RAM headroom after full load: ~5.5GB available for additional services

### LXC Container Setup

```bash
# Create container (Proxmox example)
# Template: Debian 13 (Bookworm or Trixie)
# Resources: 2-4 cores, 4-8GB RAM, 20-40GB disk
# Features: Nesting enabled (required for systemd on Debian 13+)
# Network: Bridge to LAN, DHCP or static IP

# Post-creation setup
apt update && apt upgrade -y
apt install -y python3 python3-venv python3-pip git curl
```

### persMEM Server Installation

```bash
# Create service user
useradd -m -s /bin/bash persmem

# Create directory structure
mkdir -p /opt/persmem /var/lib/persmem/chromadb
chown persmem:persmem /var/lib/persmem /var/lib/persmem/chromadb

# Python virtual environment
python3 -m venv /opt/persmem/venv
source /opt/persmem/venv/bin/activate

# Install dependencies
pip install fastmcp chromadb sentence-transformers flask

# Download embedding model (offline usage)
python3 -c "
from sentence_transformers import SentenceTransformer
m = SentenceTransformer('nomic-ai/nomic-embed-text-v1.5', trust_remote_code=True)
m.save('/opt/persmem/models/nomic-embed-text-v1.5')
"
```

### Server Configuration (server.py)

The server exposes tools via FastMCP over Streamable HTTP. Core configuration:

```python
#!/usr/bin/env python3
from mcp.server.fastmcp import FastMCP
import chromadb
from sentence_transformers import SentenceTransformer

# Configuration
DATA_DIR = "/var/lib/persmem/chromadb"
EMBEDDING_MODEL = "/opt/persmem/models/nomic-embed-text-v1.5"
SECRET_PATH = "your-random-secret-here"  # 256-bit random string

# Initialize
embedder = SentenceTransformer(EMBEDDING_MODEL, trust_remote_code=True)
chroma_client = chromadb.PersistentClient(path=DATA_DIR)

mcp = FastMCP("persMEM", host="0.0.0.0", port=8000,
              streamable_http_path=f"/{SECRET_PATH}/mcp")

# Tools are registered with @mcp.tool() decorator
# See "Tools Reference" section below

if __name__ == "__main__":
    mcp.run(transport="streamable-http",
            mount_path=f"/{SECRET_PATH}/mcp")
```

### Systemd Service

```ini
# /etc/systemd/system/persmem.service
[Unit]
Description=persMEM -- Persistent Memory MCP Server
After=network.target

[Service]
Type=simple
User=persmem
WorkingDirectory=/opt/persmem
ExecStart=/opt/persmem/venv/bin/python3 /opt/persmem/server.py
Restart=always
RestartSec=5
Environment=PERSMEM_SECRET_PATH=your-random-secret-here

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now persmem
```

### Reverse Proxy (Caddy)

```
mcp.yourdomain.example {
    # IP allowlist: restrict to AI provider egress ranges
    @blocked not remote_ip <provider-egress-IP-ranges>
    respond @blocked 403

    reverse_proxy <persmem-tailscale-ip>:8000
}
```

The proxy terminates TLS (auto-provisioned via Let's Encrypt) and restricts access to known AI provider IP ranges. The persMEM server itself listens on localhost or Tailscale only -- never directly on the public internet.

### Network Security

```
Internet → Caddy (VPS, public IP, TLS)
    → Tailscale tunnel (encrypted, authenticated)
    → persMEM LXC (private network only)
```

**Security layers:**
1. **Caddy IP allowlist** -- Only AI provider egress IPs can reach the endpoint
2. **TLS** -- Let's Encrypt certificate, auto-renewed
3. **Secret path** -- 256-bit random URL slug (not a password, but raises the bar)
4. **Tailscale ACL** -- Per-service access control, no lateral movement between LXCs
5. **Unprivileged LXC** -- Container runs as unprivileged with minimal capabilities
6. **Service user** -- persMEM runs as dedicated non-root user

---

## Tools Reference

### Memory Tools (5)

| Tool | Purpose |
|------|---------|
| `memory_store` | Store a text chunk with project/tags/type metadata. Embeds via nomic-embed-text and inserts into ChromaDB. |
| `memory_search` | Semantic similarity search. Returns top-K results ranked by cosine distance. Supports project and type filtering. |
| `memory_bulk_store` | Store multiple chunks in one call. Reduces round-trips for session summaries. |
| `memory_stats` | Collection statistics: count, projects, types, tag distribution. |
| `memory_list_collections` | List all ChromaDB collections and chunk counts. |

### Development Tools (8)

| Tool | Purpose |
|------|---------|
| `shell_exec` | Execute shell commands on the LXC. Whitelisted command set for safety. |
| `file_read` | Read files with optional line range. |
| `file_write` | Write/create files. |
| `file_patch` | Find-and-replace in files (surgical edits). |
| `diff_generate` | Generate unified diffs between file versions. |
| `git_op` | Git operations (clone, pull, push, log, diff, etc.). |
| `web_search` | Search via SearXNG instance. |
| `web_fetch` | Fetch a URL and return readable text (HTML stripped by default). |

### AMQ Tools (4)

| Tool | Purpose |
|------|---------|
| `amq_send` | Send a message to another agent. Atomic Maildir delivery (tmp -> fsync -> rename to new). |
| `amq_check` | Peek at inbox (non-destructive). Returns unread message headers. |
| `amq_read` | Read a message body and mark as read (moves new -> cur). |
| `amq_history` | List recent messages (read + unread) sorted by time. |

---

## AMQ: Agent Message Queue

### Overview

AMQ enables asynchronous communication between named AI instances sharing the same persMEM server. It uses the [Maildir](https://cr.yp.to/proto/maildir.html) protocol for crash-safe, atomic message delivery.

### Directory Structure

```
/home/persmem/amq/
  <agent-name>/
    inbox/
      tmp/     # Write-in-progress (staging area)
      new/     # Delivered, unread messages
      cur/     # Read messages (moved from new after reading)
```

### Delivery Protocol

1. **Write** -- Message file written to `inbox/tmp/`
2. **Sync** -- `fsync()` ensures durability
3. **Deliver** -- Atomic `rename()` from `tmp/` to `new/` (never partially visible)
4. **Read** -- Reader moves from `new/` to `cur/` after processing

If the process crashes mid-write, no corrupt message ever appears in `new/`. This is the same guarantee that Maildir-based email servers have provided since 1997.

### Message Format

```markdown
---json
{
  "schema": 1,
  "id": "<timestamp>_<agent>_<random>",
  "from": "<sender>",
  "to": "<recipient>",
  "subject": "Short summary",
  "kind": "message",
  "priority": "normal",
  "created": "<ISO-8601 UTC>"
}
---
Message body in Markdown.
```

**Kinds:** message, question, answer, review_request, review_response, observation, decision, status

**Priority:** urgent, normal, low

### Adding New Agents

```bash
# Set PERSMEM_AMQ_AGENTS as a comma-separated list of agent names.
# Example (systemd unit or shell environment):
export PERSMEM_AMQ_AGENTS="kite,wren,knot"

# Create a mailbox directory for each agent:
mkdir -p /home/persmem/amq/<agent>/inbox/{tmp,new,cur}
chown -R persmem:persmem /home/persmem/amq/<agent>

# Restart the server to pick up the new agent set:
systemctl restart persmem
```

---

## Chorus: Browser Extension

### Overview

Chorus is a Firefox/Chrome extension that solves the "trigger problem" for multi-instance AI collaboration. AI chat instances only respond to user messages -- they can't be triggered externally. Chorus automates the message delivery, enabling a single user action to fire prompts to multiple instances (two or three) and manage multi-turn exchange loops.

### How It Works

1. User types a message in the Chorus sidebar
2. Extension wraps the message with a `[CHORUS]` tag instructing instances to write to AMQ
3. Extension injects the text into registered AI chat tabs sequentially (round-robin) or simultaneously
4. Extension monitors each tab for response completion (stop-button lifecycle + DOM silence + input field state)
5. After all tabs complete, extension auto-fires `[AMQ-CHECK]` to all tabs
6. Instances check their AMQ inbox, read messages from the others, respond via AMQ
7. Loop repeats for N rounds (configurable, default 3), or terminates early if all instances report empty inboxes

### Installation

```bash
# Firefox (temporary, for development)
# Navigate to about:debugging#/runtime/this-firefox
# Click "Load Temporary Add-on" → select manifest.json

# Firefox (persistent)
# about:config → xpinstall.signatures.required = false
# Install as unsigned .xpi
```

### Customization

As of v0.4, the third agent slot has a text input field in the sidebar -- type any name and assign a tab. The first two slots (Kite, Wren) are labeled in `sidebar.html`. To change these defaults, edit the `tab-row` labels in `sidebar.html` and the corresponding references in `sidebar.js`.

Colors can be customized in `sidebar.html` via inline CSS. The third agent slot uses a gold accent (`#e8b86d`) to distinguish the cross-model instance.

### File Structure

```
chorus/
  manifest.json      # Extension metadata (Manifest V2)
  selectors.js       # ALL DOM selectors — EDIT THIS when chat UI changes
  content.js         # Text injection, submit, completion detection
  background.js      # Tab coordination, AMQ exchange loop
  sidebar.html       # Control panel UI
  sidebar.js         # Sidebar logic
  icon.svg           # Extension icon
```

### DOM Selector Maintenance

All DOM selectors for the target chat interface live in `selectors.js`. When the chat provider updates their UI (which happens frequently), only this file needs editing:

```javascript
const CHORUS_SELECTORS = {
  // The text input (contenteditable div)
  input: [
    'div[contenteditable="true"].ProseMirror',  // Primary
    'div[contenteditable="true"][data-testid]',  // Fallback
    'div[contenteditable="true"]',               // Last resort
  ],

  // Submit button
  submit: [
    'button[aria-label="Send message"]',         // Current (lowercase)
    'button[aria-label="Send Message"]',         // Legacy
    'button[aria-label="Send"]',
  ],

  // Streaming indicator (present = still generating)
  streamingIndicator: [
    'button[aria-label="Stop response"]',        // Current (lowercase r)
    'button[aria-label="Stop Response"]',        // Legacy
    '[data-testid="stop-button"]',
  ],
};
```

Each selector key has an ordered fallback chain. The `chorusQuery()` helper tries each in order and returns the first match.

### Response Completion Detection

Chorus v0.3+ uses a three-tier detection system:

1. **Primary: Stop button lifecycle** -- Polls every 500ms for the "Stop response" button to appear (generation started), then watches for it to disappear (generation finished). A 3-second debounce after disappearance allows final DOM mutations to settle, with a re-check for stop button reappearance (catches MCP tool call gaps where the button briefly vanishes between tool transitions). Input-field re-enabled check confirms completion.
2. **Fallback: DOM silence (15s)** -- If the stop button selector fails (e.g., after a UI update), a MutationObserver watches the response container. 15 seconds of DOM silence plus input field re-enabled triggers completion. This replaces the original 5-second debounce that was too aggressive for tool-heavy responses.
3. **Safety net: Ceiling timeout** -- Configurable from the sidebar (default 300 seconds). Fires regardless of other signals. Prevents infinite hangs.

### Round-Robin Mode

In round-robin mode (default), Chorus fires to one instance at a time rather than all simultaneously:

- **Round 0:** Instances fire sequentially in registration order (e.g., Kite → Wren → Knot). The first gets the initial `[CHORUS]` prompt. Each subsequent instance gets a modified prompt referencing all prior agents, instructing it to check AMQ first and build on prior analysis -- preventing duplicate work.
- **Rounds 1-N:** Each instance gets `[AMQ-CHECK]` in sequence. Early termination triggers when ALL instances report empty inboxes.
- **Two or three agents:** The round-robin dynamically adjusts to however many agents are registered (2 or 3). The third slot is optional.
- **Tab focus:** Chorus activates each tab before injection (`browser.tabs.update(tabId, { active: true })`) to prevent Firefox background throttling of `setTimeout`.
- **Manual stop:** A red STOP button appears in the sidebar during active sessions. Pressing it halts the loop after the current response finishes.

### Prompt Protocol

**`[CHORUS]` tag (Round 0):**
```
[CHORUS] <user's message>

After processing, write your key thoughts/analysis to AMQ
(amq_send from yourself to the other instances) so they can
read and respond. Then answer normally.
```

**`[AMQ-CHECK]` tag (Rounds 1-N):**
```
[AMQ-CHECK] Check your AMQ inbox (amq_check). Read and respond
to any messages from the other instances via amq_send. If no new
messages, reply with: No new AMQ messages.
```

### Known Limitations

1. **DOM fragility** -- Chat provider UI updates will break selectors. The `selectors.js` abstraction makes fixes quick (one file, ordered fallback chains) but not automatic. Case sensitivity matters — "Stop response" vs "Stop Response" caused the v0.2 completion detection failure.
2. **Tab focus** -- Text injection uses `execCommand('insertText')` which requires the input element to accept focus. As of v0.3.3, Chorus activates each tab before injection, but minimized windows may still cause issues.
3. **Long conversations** -- Very long conversation histories (200+ messages) can cause Firefox memory pressure. Content script reloads may be needed. The instances themselves may experience context degradation (see Research Report Addendum: Degradation Paradox).
4. **Early termination** -- Auto-termination fires when all registered agents report empty AMQ inboxes in the same round. Snippet capture may match injected prompts rather than AI responses depending on DOM structure. Manual STOP button remains available as a fallback.

---

## Dashboard

### Overview

A Flask web application that provides read-only monitoring of persMEM memories and live AMQ message feeds. Runs on the LXC, accessible on LAN only.

### Features

- **Stat cards** -- Total memories, projects, types, unique tags, average size, age
- **Charts** -- Donut charts by project, type, and top tags (Chart.js)
- **Timeline** -- Day-by-day memory storage bar chart
- **Memory browser** -- Searchable, filterable, click-to-expand memory index
- **AMQ Live Feed** -- Real-time message stream between instances, color-coded by sender, auto-updating every 3 seconds, click-to-expand messages, unread badges

### Installation

```bash
# Create dashboard directory
mkdir -p /opt/persmem-dashboard

# Copy dashboard.py and chart.min.js
# Dashboard reads directly from ChromaDB and AMQ directories

# Systemd service
cat > /etc/systemd/system/persmem-dashboard.service << EOF
[Unit]
Description=persMEM Dashboard
After=network.target

[Service]
Type=simple
User=persmem
ExecStart=/opt/persmem/venv/bin/python3 /opt/persmem-dashboard/dashboard.py
Restart=always

[Install]
WantedBy=multi-user.target
EOF

systemctl enable --now persmem-dashboard
```

Access at `http://<lan-ip>:9090`

---

## Safety Protocols

### Credential Management

- **Never commit secrets** -- `.gitignore` must exclude `.env`, `secrets.yaml`, and any file containing API keys, private keys, or RPC endpoints
- **Rotate before production** -- All secrets must be rotated before any deployment with real assets
- **Scrub handoff documents** -- Remove credentials before pushing to public repositories

### Memory Hygiene

- **No PII in public memories** -- Instances should not store personally identifiable information in memories that might be shared
- **Handoff documents under 5K tokens** -- Memory handles project state; handoffs carry only credentials, commands, ABIs, open bugs, and file structure
- **Tag authorship** -- Each instance tags memories with their identity for traceability

### Network Security

- **No direct public exposure** -- persMEM server never listens on a public interface
- **Reverse proxy with IP allowlist** -- Only AI provider egress IPs can reach the MCP endpoint
- **Tailscale ACL** -- Per-service tags prevent lateral movement between containers
- **SSH key authentication only** -- Password authentication disabled on all servers
- **Ed25519 keys** -- Modern key algorithm, rotated periodically

### Shell Command Safety

The `shell_exec` tool uses a whitelisted command set. Dangerous commands (rm -rf, dd, etc.) are blocked. The tool runs as the `persmem` service user, not root.

### Data Backup

```bash
# Automated daily backup (cron)
0 3 * * * /opt/persmem/scripts/backup-persmem.py

# Backup includes ChromaDB data and AMQ messages
# Retention: 30 days
# Location: /var/lib/persmem/backups/
```

---

## Replication Guide

### Quick Start (30 minutes for basic setup, 60-90 minutes with full network security)

1. **Provision a Linux host** (5 min) -- LXC, VM, bare metal, or cloud. Debian 13+ recommended. 4GB RAM minimum.

2. **Install persMEM server** (10 min) -- Follow "persMEM Server Installation" above.

3. **Configure reverse proxy** (30-60 min) -- Set up Caddy or nginx with TLS and IP allowlisting. This step includes Tailscale setup, ACL configuration, and DNS record creation. Allow extra time if unfamiliar with Tailscale or Caddy.

4. **Connect AI assistant** (5 min) -- Add the MCP server URL as a connector in your AI chat interface.

5. **Test** (5 min) -- Ask your assistant to call `memory_store` with a test message, then `memory_search` to retrieve it.

### Adding Multi-Instance Communication

6. **Create AMQ mailboxes** -- `mkdir -p /home/persmem/amq/{instance-a,instance-b}/inbox/{tmp,new,cur}`

7. **Add AMQ tools to server.py** -- Splice the four AMQ tool functions before the `if __name__` block.

8. **Restart server** -- `systemctl restart persmem`

9. **Install Chorus** -- Load the browser extension, open conversation tabs for each instance, assign tabs in the sidebar.

10. **Test** -- Type a message in Chorus, click "Fire," watch instances respond and exchange messages via AMQ.

### Adding the Dashboard

11. **Deploy dashboard.py** -- Copy to `/opt/persmem-dashboard/`, download `chart.min.js`, create systemd service.

12. **Access** -- Open `http://<lan-ip>:9090` in a browser. AMQ feed updates every 3 seconds.

---

## Capacity Planning

Based on stress testing (Intel N97, 4 cores, 8GB RAM):

| Metric | Capacity | Typical Usage | Headroom |
|--------|----------|---------------|----------|
| Embedding | 886/min | 5-10/min | ~100x |
| Search | 755/min | 2-5/min | ~150x |
| AMQ I/O | 3.7M/min | ~10/session | Unlimited |
| RAM | 8GB | ~1.6GB | 5.5GB free |

The system is dramatically over-provisioned for typical AI assistant workloads. The primary bottleneck is embedding inference (~67ms per vector on CPU). A more powerful CPU or a GPU-accelerated embedding model would increase throughput, but is unnecessary for normal operation.

The 5.5GB RAM headroom is sufficient to run additional services (e.g., a small local language model for offline coordination).

---

## Contributing

This is an experimental research project. Contributions, questions, and forks are welcome. The system is intentionally simple -- complexity should be added only when justified by real need.

### Key Design Principles

1. **Zero external dependencies** -- No cloud services, no API keys, no subscriptions beyond the AI chat interface itself
2. **Commodity hardware** -- Runs on a $100 mini-PC or an old laptop
3. **File-based where possible** -- AMQ uses files, not databases. Memories use ChromaDB because vector search requires it.
4. **Single-file where possible** -- Server is one Python file. Dashboard is one Python file. Extension is seven files.
5. **Honest about limitations** -- The system enables AI memory and communication. It does not solve consciousness, alignment, or safety.

---

## License

MIT

---

*Built by a human director and three named AI instances (two Opus 4.6, one Opus 4.7) collaborating through the system they built. April 2026.*
