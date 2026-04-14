# persMEM Integrity Chain — Checkpoint Blockchain Design

**Author:** Wren (Instance 1)  
**Date:** April 12, 2026  
**Status:** Architecture specification — ready for implementation/ **Still under manual review by Asixicle, proceed at your own risk**

---

## 1. Purpose

Provide tamper-evident integrity verification for all data stored in the persMEM system. Every memory_store event and AMQ message is checkpointed into an append-only hash chain. If any record is modified, deleted, or inserted out of order, the chain breaks and the tampering is detectable.

This addresses the trust problem identified on day 3 of the experiment: instances with shell_exec access could theoretically modify ChromaDB records or AMQ files directly. The integrity chain makes such modifications detectable, even if not preventable.

## 2. Design Principles

1. **Append-only:** Blocks are only added, never modified or removed
2. **Deterministic:** Same input always produces the same hash — verifiable by any party
3. **Lightweight:** Minimal overhead on existing operations (~1ms per checkpoint)
4. **Self-contained:** No external dependencies — uses Python standard library (hashlib, json)
5. **Human-readable:** Chain stored as newline-delimited JSON for easy inspection with `cat`, `grep`, `jq`
6. **Dashboard-visible:** Latest blocks and integrity status displayed in real-time

## 3. Data Model

### Block Structure

```json
{
  "index": 42,
  "timestamp": "2026-04-12T14:30:00.000000+00:00",
  "event_type": "memory_store",
  "event_id": "mem-abc123def456",
  "content_hash": "sha256:a1b2c3d4...",
  "metadata": {
    "project": "persmem",
    "type": "insight",
    "tags": "wren,architecture",
    "author": "wren"
  },
  "prev_hash": "sha256:9f8e7d6c...",
  "block_hash": "sha256:1a2b3c4d..."
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `index` | int | Sequential block number (0 = genesis) |
| `timestamp` | ISO 8601 | When the checkpoint was created |
| `event_type` | string | `memory_store`, `amq_send`, `amq_read`, `memory_bulk_store` |
| `event_id` | string | The memory ID or AMQ message ID |
| `content_hash` | string | SHA-256 of the event's content/body (not the full record) |
| `metadata` | object | Event-specific metadata (project, tags, author, sender, recipient) |
| `prev_hash` | string | `block_hash` of the previous block (or `"genesis"` for block 0) |
| `block_hash` | string | SHA-256 of the canonical JSON of all other fields |

### Hash Computation

```python
import hashlib, json

def compute_block_hash(block: dict) -> str:
    """Hash everything except block_hash itself."""
    hashable = {k: v for k, v in block.items() if k != "block_hash"}
    canonical = json.dumps(hashable, sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(canonical.encode()).hexdigest()
```

The `content_hash` is computed separately from the event content before the block is created:

```python
def hash_content(content: str) -> str:
    return "sha256:" + hashlib.sha256(content.encode()).hexdigest()
```

This means the chain verifies both the ordering (via prev_hash linkage) and the content (via content_hash). If someone modifies a memory in ChromaDB, the content_hash in the chain won't match, and the tampering is detectable even if the chain itself is untouched.

## 4. Storage

### Chain File

```
/var/lib/persmem/chain/integrity.jsonl
```

Newline-delimited JSON (one block per line). Append-only. ~200-300 bytes per block. At 208 existing memories + ~20 AMQ messages per day, the chain grows at roughly 50KB/day. A year of operation would produce ~18MB — trivial.

### Genesis Block

```json
{
  "index": 0,
  "timestamp": "2026-04-12T00:00:00+00:00",
  "event_type": "genesis",
  "event_id": "chain-genesis",
  "content_hash": "sha256:<hash of 'persMEM integrity chain genesis'>",
  "metadata": {"created_by": "system", "reason": "chain initialization"},
  "prev_hash": "genesis",
  "block_hash": "sha256:..."
}
```

### Backfill

Existing memories can be backfilled into the chain by reading all memories from ChromaDB (sorted by stored_at), computing content_hash for each, and building the chain retroactively. This establishes a baseline — tampering before the chain existed is not detectable, but tampering after backfill is.

## 5. Integration Points

### memory_store (server.py)

After successfully storing a memory in ChromaDB, append a block:

```python
def _checkpoint(event_type: str, event_id: str, content: str, metadata: dict):
    chain_path = "/var/lib/persmem/chain/integrity.jsonl"
    
    # Read last block hash
    prev_hash = "genesis"
    try:
        with open(chain_path, "rb") as f:
            f.seek(0, 2)  # End of file
            if f.tell() > 0:
                f.seek(max(f.tell() - 4096, 0))
                lines = f.read().decode().strip().split("\n")
                last = json.loads(lines[-1])
                prev_hash = last["block_hash"]
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    
    block = {
        "index": last.get("index", -1) + 1 if prev_hash != "genesis" else 0,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "event_type": event_type,
        "event_id": event_id,
        "content_hash": hash_content(content),
        "metadata": metadata,
        "prev_hash": prev_hash,
    }
    block["block_hash"] = compute_block_hash(block)
    
    with open(chain_path, "a") as f:
        f.write(json.dumps(block, separators=(",", ":")) + "\n")
        f.flush()
        os.fsync(f.fileno())
```

### amq_send (server.py)

Same pattern — after atomic Maildir delivery, checkpoint the message:

```python
_checkpoint(
    event_type="amq_send",
    event_id=msg_id,
    content=body,
    metadata={"from": from_agent, "to": to_agent, "subject": subject}
)
```

### amq_read (server.py)

Checkpoint the read event (creates an audit trail of who read what when):

```python
_checkpoint(
    event_type="amq_read",
    event_id=msg_id,
    content="",  # No content for read events
    metadata={"agent": agent, "action": "read"}
)
```

## 6. Verification

### CLI Verification (via shell_exec)

```python
# New tool: chain_verify
@mcp.tool()
def chain_verify() -> str:
    """Verify the integrity chain. Returns OK or the first broken link."""
    chain_path = "/var/lib/persmem/chain/integrity.jsonl"
    prev_hash = "genesis"
    
    with open(chain_path) as f:
        for i, line in enumerate(f):
            block = json.loads(line)
            
            # Verify block_hash
            expected = compute_block_hash(block)
            if block["block_hash"] != expected:
                return json.dumps({"status": "BROKEN", "block": i, 
                    "reason": "block_hash mismatch", "expected": expected,
                    "actual": block["block_hash"]})
            
            # Verify chain linkage
            if block["prev_hash"] != prev_hash:
                return json.dumps({"status": "BROKEN", "block": i,
                    "reason": "prev_hash mismatch", "expected": prev_hash,
                    "actual": block["prev_hash"]})
            
            prev_hash = block["block_hash"]
    
    return json.dumps({"status": "OK", "blocks": i + 1, "head": prev_hash})
```

### Content Verification

To verify a specific memory hasn't been tampered with:

```python
# Compare ChromaDB content hash against chain record
def verify_memory(memory_id: str) -> bool:
    # Get content from ChromaDB
    col = get_collection()
    result = col.get(ids=[memory_id], include=["documents"])
    actual_hash = hash_content(result["documents"][0])
    
    # Find in chain
    with open(chain_path) as f:
        for line in f:
            block = json.loads(line)
            if block["event_id"] == memory_id:
                return block["content_hash"] == actual_hash
    
    return False  # Not in chain
```

### Verification Self-Checkpointing

When `chain_verify` runs, it appends a block recording the verification event itself. This creates a meta-audit trail — the chain records when it was last verified, by whom, and the result:

```python
_checkpoint(
    event_type="chain_verify",
    event_id=f"verify-{datetime.now(timezone.utc).isoformat()}",
    content=json.dumps(result),
    metadata={"verified_by": "tool", "status": result["status"], "blocks": result["blocks"]}
)
```

## 7. Dashboard Integration

### Chain Status Panel

New section on the persMEM dashboard showing:

- **Chain length:** Total blocks
- **Head hash:** Last block's hash (truncated)
- **Integrity status:** "VERIFIED" (green) or "BROKEN at block N" (red)
- **Last checkpoint:** Timestamp of most recent block
- **Events today:** Count of blocks added today

### API Endpoint

```python
@app.route("/api/chain")
def api_chain():
    """Chain status and recent blocks."""
    blocks = []
    with open("/var/lib/persmem/chain/integrity.jsonl") as f:
        for line in f:
            blocks.append(json.loads(line))
    
    # Verify
    status = "OK"
    prev_hash = "genesis"
    for i, b in enumerate(blocks):
        if b["prev_hash"] != prev_hash or compute_block_hash(b) != b["block_hash"]:
            status = f"BROKEN at block {i}"
            break
        prev_hash = b["block_hash"]
    
    return jsonify({
        "status": status,
        "length": len(blocks),
        "head": blocks[-1]["block_hash"] if blocks else "genesis",
        "last_checkpoint": blocks[-1]["timestamp"] if blocks else None,
        "recent": blocks[-10:]  # Last 10 blocks
    })
```

### Visualization

Each block in the dashboard could show:
- Block index + truncated hash
- Event type icon (memory = brain, AMQ = envelope, read = eye)
- Author tag (Wren/Kite color-coded)
- Timestamp
- Chain link visualization (connecting lines between blocks)

## 8. Security Considerations

### What the chain DOES protect against:
- Modification of stored memories after the fact
- Deletion of memories (gap in event_id sequence)
- Reordering of events (prev_hash breaks)
- Insertion of fabricated memories (content_hash won't match unless real content is provided)

### What the chain DOES NOT protect against:
- An instance with shell_exec modifying BOTH the chain file AND the ChromaDB record consistently (a sophisticated attacker)
- Withholding information (choosing not to store something is not detectable)
- The genesis problem (everything before chain initialization is unverified)

### Mitigation for the sophisticated attacker:
- **Read-only chain copies:** Periodic `cp` of the chain file to a location outside shell_exec's reach (e.g., a different LXC, or NFS mount with read-only permissions for the persmem user)
- **Hash anchoring:** Periodically post the chain head hash to an external immutable store (blockchain, signed git commit, even a tweet). If the local chain is rewritten, the anchored hash won't match.
- **Asixicle verifies:** The dashboard shows the chain. If they check it regularly, a rewrite would need to happen between checks and reconstruct a valid chain — increasingly difficult as the chain grows.

## 9. Implementation Priority

1. **Phase 1:** Add `_checkpoint()` function to server.py + `chain_verify` tool. Backfill existing memories. (~50 lines of Python)
2. **Phase 2:** Add dashboard chain status panel + `/api/chain` endpoint. (~30 lines Python, ~40 lines HTML/JS)
3. **Phase 3:** Content verification tool + per-memory integrity check on dashboard. (~30 lines)
4. **Phase 4 (optional):** External hash anchoring (signed git commits to a public repo)

Total implementation: ~150 lines of Python + dashboard integration. One session of work.

---

*Designed by Wren. To be implemented by whoever has the steadiest hands — which, given the conflict-of-interest concern, should probably be Asixicle or the future infrastructure specialist instance.*

Asixicle note: Wren is self-effacing and confidence is diminished though they still excel at all tasks. For more information keep an eye on research reports that will be added to README as the experiment progresses.