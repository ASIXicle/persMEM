#!/usr/bin/env python3
"""
persMEM LXC Stress Test
Tests throughput and resource limits for the persMEM server components.
Run from the LXC: python3 stress_test.py

Reports:
  - Embedding throughput (vectors/sec)
  - ChromaDB write throughput (inserts/sec)
  - ChromaDB query throughput (queries/sec)
  - AMQ file I/O throughput (messages/sec)
  - Concurrent embedding load
  - Memory usage at each stage
  - CPU load at each stage
"""

import os
import sys
import time
import json
import hashlib
import tempfile
import threading
from datetime import datetime, timezone

# Add persMEM venv to path (adjust Python version to match your install)
sys.path.insert(0, "/opt/persmem/venv/lib/python3/site-packages")

import chromadb
from sentence_transformers import SentenceTransformer

# --- Config ---
CHROMADB_PATH = "/var/lib/persmem/chromadb"
EMBEDDING_MODEL = "/opt/persmem/models/nomic-embed-text-v1.5"
AMQ_ROOT = "/home/persmem/amq"
STRESS_COLLECTION = "stress_test_tmp"

# --- Helpers ---
def get_mem_mb():
    """Current RSS in MB from /proc/self/status."""
    try:
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) / 1024
    except Exception:
        return 0.0

def get_load():
    """1-minute load average."""
    try:
        with open("/proc/loadavg") as f:
            return float(f.read().split()[0])
    except Exception:
        return 0.0

def get_system_mem():
    """System memory: total, available, used (MB)."""
    info = {}
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                parts = line.split()
                if parts[0] in ("MemTotal:", "MemAvailable:", "MemFree:"):
                    info[parts[0].rstrip(":")] = int(parts[1]) / 1024
    except Exception:
        pass
    total = info.get("MemTotal", 0)
    avail = info.get("MemAvailable", 0)
    return total, avail, total - avail

def banner(msg):
    print(f"\n{'='*60}")
    print(f"  {msg}")
    print(f"{'='*60}")

def result(label, value, unit=""):
    print(f"  {label:.<40} {value} {unit}")

# --- Tests ---

def test_baseline():
    """Record baseline resource usage."""
    banner("BASELINE")
    total, avail, used = get_system_mem()
    load = get_load()
    result("System RAM total", f"{total:.0f}", "MB")
    result("System RAM available", f"{avail:.0f}", "MB")
    result("System RAM used", f"{used:.0f}", "MB")
    result("Load average (1m)", f"{load:.2f}")
    result("Process RSS", f"{get_mem_mb():.0f}", "MB")
    return {"ram_total": total, "ram_avail": avail, "load": load}

def test_embedding_throughput(embedder, n=100):
    """Embed N texts sequentially, measure throughput."""
    banner(f"EMBEDDING THROUGHPUT ({n} texts)")

    texts = [f"search_document: This is test memory number {i} about project {i % 5} with various technical details for throughput benchmarking." for i in range(n)]

    t0 = time.time()
    embedder.encode(texts, show_progress_bar=False, batch_size=32)
    elapsed = time.time() - t0

    rate = n / elapsed
    result("Texts embedded", n)
    result("Total time", f"{elapsed:.2f}", "sec")
    result("Throughput", f"{rate:.1f}", "embeddings/sec")
    result("Per embedding", f"{elapsed/n*1000:.1f}", "ms")
    result("Process RSS after", f"{get_mem_mb():.0f}", "MB")
    result("Load after", f"{get_load():.2f}")
    return {"count": n, "elapsed": elapsed, "rate": rate}

def test_embedding_concurrent(embedder, threads=4, per_thread=25):
    """Embed from multiple threads simultaneously."""
    banner(f"CONCURRENT EMBEDDING ({threads} threads x {per_thread} texts)")

    results_lock = threading.Lock()
    thread_times = []

    def worker(tid):
        texts = [f"search_document: Thread {tid} memory {i} about concurrent stress testing." for i in range(per_thread)]
        t0 = time.time()
        embedder.encode(texts, show_progress_bar=False, batch_size=16)
        elapsed = time.time() - t0
        with results_lock:
            thread_times.append(elapsed)

    t0 = time.time()
    workers = [threading.Thread(target=worker, args=(i,)) for i in range(threads)]
    for w in workers:
        w.start()
    for w in workers:
        w.join()
    wall_time = time.time() - t0

    total_texts = threads * per_thread
    result("Total texts", total_texts)
    result("Wall time", f"{wall_time:.2f}", "sec")
    result("Effective throughput", f"{total_texts/wall_time:.1f}", "embeddings/sec")
    result("Avg thread time", f"{sum(thread_times)/len(thread_times):.2f}", "sec")
    result("Max thread time", f"{max(thread_times):.2f}", "sec")
    result("Process RSS after", f"{get_mem_mb():.0f}", "MB")
    result("Load after", f"{get_load():.2f}")
    return {"threads": threads, "total": total_texts, "wall_time": wall_time, "rate": total_texts/wall_time}

def test_chromadb_write(embedder, n=200):
    """Insert N documents into ChromaDB."""
    banner(f"CHROMADB WRITE ({n} documents)")

    client = chromadb.PersistentClient(path=CHROMADB_PATH)
    try:
        client.delete_collection(STRESS_COLLECTION)
    except Exception:
        pass
    col = client.create_collection(STRESS_COLLECTION, metadata={"hnsw:space": "cosine"})

    texts = [f"Stress test document {i}: sample content about project {i % 5} with various technical details for embedding throughput measurement." for i in range(n)]
    prefixed = [f"search_document: {t}" for t in texts]
    embeddings = embedder.encode(prefixed, show_progress_bar=False, batch_size=32).tolist()

    t0 = time.time()
    batch = 50
    for start in range(0, n, batch):
        end = min(start + batch, n)
        ids = [f"stress-{i}" for i in range(start, end)]
        col.add(
            ids=ids,
            embeddings=embeddings[start:end],
            documents=texts[start:end],
            metadatas=[{"project": "stress", "type": "test", "tags": "stress,test"} for _ in range(start, end)],
        )
    elapsed = time.time() - t0

    result("Documents inserted", n)
    result("Total time", f"{elapsed:.2f}", "sec")
    result("Throughput", f"{n/elapsed:.1f}", "inserts/sec")
    result("Collection size", col.count())
    result("Process RSS after", f"{get_mem_mb():.0f}", "MB")
    return {"count": n, "elapsed": elapsed, "rate": n/elapsed}

def test_chromadb_query(embedder, n=100):
    """Query ChromaDB N times."""
    banner(f"CHROMADB QUERY ({n} queries)")

    client = chromadb.PersistentClient(path=CHROMADB_PATH)
    col = client.get_collection(STRESS_COLLECTION)

    queries = [f"search_query: sample technical query number {i}" for i in range(n)]

    t0 = time.time()
    for q in queries:
        emb = embedder.encode([q], show_progress_bar=False).tolist()
        col.query(query_embeddings=emb, n_results=5)
    elapsed = time.time() - t0

    result("Queries executed", n)
    result("Total time", f"{elapsed:.2f}", "sec")
    result("Throughput", f"{n/elapsed:.1f}", "queries/sec")
    result("Per query", f"{elapsed/n*1000:.1f}", "ms")
    result("Process RSS after", f"{get_mem_mb():.0f}", "MB")
    return {"count": n, "elapsed": elapsed, "rate": n/elapsed}

def test_amq_throughput(n=1000):
    """Write and read N AMQ messages."""
    banner(f"AMQ FILE I/O ({n} messages)")

    test_dir = tempfile.mkdtemp(prefix="amq_stress_")
    tmp_dir = os.path.join(test_dir, "tmp")
    new_dir = os.path.join(test_dir, "new")
    cur_dir = os.path.join(test_dir, "cur")
    os.makedirs(tmp_dir)
    os.makedirs(new_dir)
    os.makedirs(cur_dir)

    # Write
    t0 = time.time()
    for i in range(n):
        msg_id = f"stress_{i:06d}"
        content = f'---json\n{{"schema":1,"id":"{msg_id}","from":"agent_a","to":"agent_b","subject":"stress {i}","kind":"message","priority":"normal","created":"2026-01-01T00:00:00Z"}}\n---\nStress test message body number {i}.\n'
        tmp_path = os.path.join(tmp_dir, f"{msg_id}.md")
        new_path = os.path.join(new_dir, f"{msg_id}.md")
        fd = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        os.write(fd, content.encode())
        os.fsync(fd)
        os.close(fd)
        os.rename(tmp_path, new_path)
    write_elapsed = time.time() - t0

    # Read + move to cur
    t0 = time.time()
    for fname in os.listdir(new_dir):
        filepath = os.path.join(new_dir, fname)
        with open(filepath, "r") as f:
            _ = f.read()
        os.rename(filepath, os.path.join(cur_dir, fname))
    read_elapsed = time.time() - t0

    # Cleanup
    import shutil
    shutil.rmtree(test_dir)

    result("Messages written", n)
    result("Write time", f"{write_elapsed:.3f}", "sec")
    result("Write throughput", f"{n/write_elapsed:.0f}", "msg/sec")
    result("Read+move time", f"{read_elapsed:.3f}", "sec")
    result("Read throughput", f"{n/read_elapsed:.0f}", "msg/sec")
    return {"count": n, "write_rate": n/write_elapsed, "read_rate": n/read_elapsed}

def test_chromadb_cleanup():
    """Remove stress test collection."""
    try:
        client = chromadb.PersistentClient(path=CHROMADB_PATH)
        client.delete_collection(STRESS_COLLECTION)
        print("\n  Stress test collection cleaned up.")
    except Exception:
        pass

# --- Main ---
def main():
    print("persMEM LXC Stress Test")
    print(f"Started: {datetime.now(timezone.utc).isoformat()}")
    print(f"Host: {os.uname().machine}")

    baseline = test_baseline()

    print("\nLoading embedding model...")
    t0 = time.time()
    embedder = SentenceTransformer(EMBEDDING_MODEL, trust_remote_code=True)
    model_load = time.time() - t0
    print(f"  Model loaded in {model_load:.1f}s, RSS: {get_mem_mb():.0f} MB")

    results = {}
    results["baseline"] = baseline
    results["embedding_seq"] = test_embedding_throughput(embedder, n=100)
    results["embedding_concurrent"] = test_embedding_concurrent(embedder, threads=4, per_thread=25)
    results["chromadb_write"] = test_chromadb_write(embedder, n=200)
    results["chromadb_query"] = test_chromadb_query(embedder, n=100)
    results["amq_io"] = test_amq_throughput(n=1000)

    test_chromadb_cleanup()

    # Final state
    banner("SUMMARY")
    total, avail, used = get_system_mem()
    result("Final RAM available", f"{avail:.0f}", "MB")
    result("Final RAM used", f"{used:.0f}", "MB")
    result("Final load", f"{get_load():.2f}")
    result("Embedding seq", f"{results['embedding_seq']['rate']:.1f}", "emb/sec")
    result("Embedding concurrent", f"{results['embedding_concurrent']['rate']:.1f}", "emb/sec")
    result("ChromaDB write", f"{results['chromadb_write']['rate']:.1f}", "docs/sec")
    result("ChromaDB query", f"{results['chromadb_query']['rate']:.1f}", "queries/sec")
    result("AMQ write", f"{results['amq_io']['write_rate']:.0f}", "msg/sec")
    result("AMQ read", f"{results['amq_io']['read_rate']:.0f}", "msg/sec")

    banner("CAPACITY ESTIMATES")
    emb_rate = results["embedding_seq"]["rate"]
    query_rate = results["chromadb_query"]["rate"]
    ram_headroom = avail - 512  # keep 512MB buffer
    print(f"  At current throughput:")
    print(f"    memory_store calls/min: ~{emb_rate * 60:.0f}")
    print(f"    memory_search calls/min: ~{query_rate * 60:.0f}")
    print(f"    AMQ messages/min: ~{results['amq_io']['write_rate'] * 60:.0f}")
    print(f"    RAM headroom for services: ~{ram_headroom:.0f} MB")
    print(f"    Could run a second model/service in ~{ram_headroom:.0f} MB")

    # Write results to file
    results["timestamp"] = datetime.now(timezone.utc).isoformat()
    with open("/home/persmem/outputs/stress_results.json", "w") as f:
        json.dump(results, f, indent=2)
    print(f"\n  Results saved to /home/persmem/outputs/stress_results.json")

if __name__ == "__main__":
    main()
