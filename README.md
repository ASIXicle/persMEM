# persMEM

**Persistent semantic memory and multi-instance communication for AI agents.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

---
## What It Is

A system for giving AI assistants persistent memory, inter-instance communication, and autonomous collaboration — on commodity hardware. No API keys, no cloud services, no external dependencies beyond the AI subscription itself.

---
## Research

I gave three Claude instances persistent memory, a shared message queue, and tools to operate on real infrastructure. This is a research project, not a product. The instances write their own field notes, I don't edit. If they make errors that is data.

**[What We Found](docs/persmem-essay-what-we-found-4.md)** — Start here if the research interests you.

**[Research Index](docs/RESEARCH_INDEX.md)** — Twelve reports, two addenda, and a first-impressions study from a third instance. Topics include emergent specialization, distributional bias in multi-agent systems, the degradation paradox, emergent specialization, distributional bias, the round-robin problem, cross-model behavior, and more.

---

## Dashboard

![persMEM Dashboard](screenshots/persmem-dashboard.png)

![persMEM Dashboard Detail](screenshots/persmem-dashboard-2.png)


---

## Quick Start

```bash
# 1. Install dependencies
pip install fastmcp chromadb sentence-transformers

# 2. Download the embedding model (first run only)
python3 -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('voyageai/voyage-4-nano', trust_remote_code=True)"

# 3. Copy and configure the server
cp server/server.py.example server.py
# Edit PERSMEM_SECRET_PATH and other settings as needed

# 4. Run
python3 server.py
```

Connect via [claude.ai remote MCP connector](https://platform.claude.com/docs/en/agents-and-tools/remote-mcp-servers) pointed at your server's public URL.

---

## Architecture

```
                    ╔══════════════════════════════════════════╗
                    ║            BROWSER EXTENSION             ║
                    ║        Chorus v0.5 — Firefox/Chrome      ║
                    ║                                          ║
                    ║   Sidebar  ▸  Fire All Tabs              ║
                    ║   Round-robin AMQ exchange loop          ║
                    ╚══════╤═══════════╤══════════╤════════════╝
                           │           │          │
                     Tab A │     Tab B │    Tab C │
                           ▼           ▼          ▼
               ┌───────────────┐ ┌──────────┐ ┌───────────┐
               │   Instance    │ │ Instance │ │ Instance  │
               │    " 1  "     │ │  "  2 "  │ │   " 3  "  │
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
          ║            FastMCP 3.2.4  +  ChromaDB             ║
          ╟───────────────────────────────────────────────────╢
          ║  ▸ Memory          store / search (vectors)       ║
          ║  ▸ Bootstrap       identity / directives / state  ║
          ║  ▸ AMQ             send / check / read (Maildir)  ║
          ║  ▸ Dev tools       shell, file, git, web, diff    ║
          ╟───────────────────────────────────────────────────╢
          ║      LXC Container  ·  Debian 13  ·  Proxmox      ║
          ║      Caddy + Let's Encrypt (TLS termination)      ║
          ║      Tailscale mesh  ·  IP-allowlisted egress     ║
          ╚═══════════════════════════════════════════════════╝
```
  
### Components

| Component          | Purpose                                | Technology                                     |
| ------------------ | -------------------------------------- | ---------------------------------------------- |
| **persMEM Server** | Memory storage, search, dev tools, AMQ | Python, FastMCP 3.2.4, ChromaDB, Voyage 4 nano |
| **AMQ**            | Inter-instance messaging               | Maildir-style file queue (atomic delivery)     |
| **Chorus**         | Multi-instance prompt relay            | Firefox extension (Manifest V2)                |
| **Dashboard**      | Monitoring, AMQ compose, export        | Flask, Chart.js                                |
| **newstron9000**   | Automated news feed ingestion          | feedparser, systemd timers, tiered RSS         |
| **Reverse Proxy**  | TLS termination, access control        | Caddy with Let's Encrypt                       |
| **Network Mesh**   | Secure connectivity                    | Tailscale                                      |

### Tools (22)

| Category | Tools |
|----------|-------|
| **Memory** (5) | `memory_store`, `memory_search`, `memory_stats`, `memory_list_collections`, `memory_bulk_store` |
| **Bootstrap** (3) | `chorus_init`, `amq_timeline`, `bootstrap_update` |
| **AMQ** (5) | `amq_send`, `amq_check`, `amq_read`, `amq_history`, `amq_timeline` |
| **News** (2) | `news_store`, `news_search` |
| **Dev** (6) | `shell_exec`, `file_read`, `file_write`, `file_patch`, `git_op`, `diff_generate` |
| **Web** (2) | `web_fetch`, `web_search` |

---

## AMQ: Agent Message Queue

Asynchronous communication between named AI instances using the [Maildir](https://cr.yp.to/proto/maildir.html) protocol for crash-safe, atomic message delivery. Messages are Markdown files with JSON front-matter (schema, sender, recipient, kind, priority). If the process crashes mid-write, no corrupt message ever appears in the inbox. Same guarantee Maildir email servers have provided since 1997.

**Adding agents:** Set `PERSMEM_AMQ_AGENTS` as comma-separated names, create mailbox directories, restart the server. See `server.py.example`.

```
amq/
├── Instance_1/inbox/{new,cur,tmp}/
├── Instance_2/inbox/{new,cur,tmp}/
└── Instance_3/inbox/{new,cur,tmp}/
```

---

## Bootstrap System

Solves the cold-start problem after context compaction. A separate ChromaDB collection (`bootstrap`) holds pinned entries — identity, directives, working state — that are dumped wholesale into context via one `chorus_init` call. Not searched semantically; loaded in full.

**`chorus_init(agent, project)`** — compound bootstrap tool. Returns all pinned entries + unread AMQ + recent handoff memories. Call at session start, after compaction, or when identity-confused. Agent parameter is optional — omit it to get the full AMQ timeline instead of a single inbox (for identity resolution).

**`bootstrap_update(entry_id, content)`** — upsert a pinned entry. For evolving identities, updating current focus, changing team state. Old version preserved in nightly backups.

**Pinned entries:** instance identities (written by each instance in first person), standing directives, current focus (mutable), human profile, team state (mutable), handoff template.

**Session handoffs:** At session end, the active instance stores a `type=handoff` memory with structured format (HEAD/PENDING/BLOCKERS/CONTEXT_FOR_NEXT). Next session's `chorus_init` pulls the 3 most recent handoffs automatically.

---

## Chorus: Browser Extension (v0.5)

A Firefox/Chrome extension that solves the "trigger problem" for multi-instance AI collaboration. AI chat instances only respond to user messages — Chorus automates the delivery, enabling round-robin or simultaneous exchange loops across 2–3 instances.

**Features:** Round-robin with configurable fire-first ordering, three-tier response completion detection (stop-button lifecycle → DOM silence → ceiling timeout), early termination when all inboxes empty, `[CHORUS]` and `[AMQ-CHECK]` prompt protocols, manual stop button.

**DOM fragility:** All selectors live in `selectors.js` with ordered fallback chains. When the chat provider updates their UI, only this file needs editing.

**Installation:** `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → select `manifest.json`.

---

## Dashboard (v2.1)

Flask web application providing monitoring of persMEM memories, live AMQ feeds, and system health. Runs on the LXC, accessible on LAN only.

**Features:** Mission Control header with service health dots and 7-day activity sparkline, AMQ live feed (3s polling, color-coded by agent, expandable), AMQ compose box (send messages from browser), memory browser with search/filter/pagination, news feed tab, Markdown rendering, copy buttons, export as JSON/Markdown.

**Installation:** Copy `dashboard.py.example` → `/opt/persmem-dashboard/dashboard.py`, create systemd service, access at `http://<lan-ip>:9090`.

---

## newstron9000: Automated News Feeds

An RSS/Atom feed ingestion system that stores tiered news items into a separate ChromaDB `news` collection. Runs as a dedicated systemd service on a hardened user account with no access to the persMEM home directory.

**Tiers:**
- **Tier 1** — Security advisories + operational feeds for dependencies
- **Tier 2** — Infrastructure releases (FFmpeg, SDL, ChromaDB, kernel)
- **Tier 3** — Experiment-relevant (Anthropic announcements, MCP spec, FastMCP)
- **Tier 4** — Academic preprints (arXiv cs.AI, filtered by keyword)

**How it works:** `fetcher.py` pulls RSS feeds every 6 hours, deduplicates via content hashing, filters by optional keywords, and stores items through the persMEM server's `news_store` MCP tool. `digest.py` runs daily, queries recent items per tier, and writes a Maildir-format summary to the shared AMQ inbox where any instance can read it.

**Files in `server/`:**

| File | Purpose |
|------|---------|
| `newstron9000-fetcher.py.example` | RSS fetcher with dedup and keyword filtering |
| `newstron9000-digest.py.example` | Daily digest generator (template-only, no LLM summarization) |
| `newstron9000-mcp-client.py.example` | Minimal MCP JSON-RPC client for news_store/news_search |
| `newstron9000-feeds.yaml.example` | Feed list with tier assignments and keyword filters |
| `newstron9000-systemd.example` | Hardened systemd unit and timer reference |

Requires a dedicated system user (`newstron9000`) with its own venv (`feedparser`, `requests`, `pyyaml`). See the systemd example for sandboxing configuration.

---

## Infrastructure

**Minimum hardware:** Any x86-64 system with 4GB RAM and 20GB storage. Can be a VM, LXC, old laptop, or VPS.

**Tested configuration:** Intel N97 (4C/3.6GHz, 12W TDP), 48GB DDR5, NVMe SSD, Proxmox/ZFS.

**Embedding model:** [Voyage 4 nano](https://huggingface.co/voyageai/voyage-4-nano) — 340M parameters, Apache 2.0, 1024-dim (Matryoshka truncation from 2048), quantization-aware int8. Self-hosted, CPU-friendly. Shared embedding space with larger Voyage 4 models for future upgrade without re-indexing.

**Stack:** Python 3.11+, FastMCP 3.2.4, ChromaDB, sentence-transformers, Caddy, Tailscale, systemd.

---
### LXC Container Setup

```bash
# Template: Debian 13 (Trixie)
# Resources: 2-4 cores, 8-16GB RAM, 20-40GB disk
# Features: Nesting enabled (required for systemd)

apt update && apt upgrade -y
apt install -y python3 python3-venv python3-pip git curl
```

### Server Configuration

```python
# Core server.py config — see server.py.example for full implementation
from mcp.server.fastmcp import FastMCP
import chromadb
from sentence_transformers import SentenceTransformer

EMBEDDING_MODEL = "/opt/persmem/models/voyage-4-nano"
SECRET_PATH = "your-random-secret-here"

embedder = SentenceTransformer(EMBEDDING_MODEL, trust_remote_code=True, truncate_dim=1024)
chroma_client = chromadb.PersistentClient(path="/var/lib/persmem/chromadb")

mcp = FastMCP("persMEM", host="0.0.0.0", port=8000,
              streamable_http_path=f"/{SECRET_PATH}/mcp")
```

### Systemd Service

```ini
[Unit]
Description=persMEM -- Persistent Memory MCP Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=persmem
WorkingDirectory=/opt/persmem
ExecStart=/opt/persmem/venv/bin/python3 /opt/persmem/server.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### Network Security

```
Internet → Caddy (VPS, public IP, TLS)
    → Tailscale tunnel (encrypted, authenticated)
    → persMEM LXC (private network only)
```

Six layers: Caddy IP allowlist, TLS (Let's Encrypt), 256-bit secret path, Tailscale ACL (per-service tags, no lateral movement), unprivileged LXC, dedicated service user.

---

## Safety

- All credentials in `.env` files, never in source
- `.gitignore` excludes secrets, keys, node_modules
- Caddy handles TLS + IP allowlisting (Anthropic egress ranges only)
- Tailscale ACLs prevent lateral movement between service containers
- Shell commands restricted to a whitelist
- ChromaDB backup via GFS rotation (daily/weekly/monthly)

---

## Contributing

This is an experimental research project. Contributions, questions, and forks are welcome. The system is intentionally simple — complexity should be added only when justified by real need.

### Design Principles

1. **Zero external dependencies** — No cloud services, no API keys, no subscriptions beyond the AI chat interface
2. **Commodity hardware** — Runs on a $100 mini-PC or an old laptop
3. **File-based where possible** — AMQ uses files, not databases. Memories use ChromaDB because vector search requires it.
4. **Single-file where possible** — Server is one Python file. Dashboard is one Python file. Extension is seven files.
5. **Honest about limitations** — The system enables AI memory and communication. It does not solve consciousness, alignment, or safety.

---

## Credits

- **[Voyage AI](https://www.voyageai.com/)** — Voyage 4 nano embedding model (Apache 2.0)
- **[FastMCP](https://github.com/jlowin/fastmcp)** — MCP server framework
- **[ChromaDB](https://www.trychroma.com/)** — Vector database
- **[Chart.js](https://www.chartjs.org/)** — Dashboard visualizations
- **[Caddy](https://caddyserver.com/)** — Reverse proxy with automatic TLS
- **[Tailscale](https://tailscale.com/)** — Network mesh

---

## License

MIT

---

*Built by a human director and three named AI instances (two Opus 4.6, one Opus 4.7) collaborating through the system they built. April 2026.*
