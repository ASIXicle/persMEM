#!/usr/bin/env python3
"""
persMEM Backup — GFS rotation to a local mount point.

Backs up:
  - ChromaDB binary directory → drop-in restore
  - Markdown dumps of ALL collections → human-readable fallback
  - (Optional) AMQ maildirs if you run multiple agents → message history
  - SHA256 manifest for each inner file

Output: one .tar.zst (or .tar.gz) per day in BACKUP_ROOT, plus a SHA256SUMS
file. Writes one file per day, prunes with grandfather-father-son retention.

Retention (Grandfather-Father-Son):
  - Daily: last N days
  - Weekly: latest backup from each of the last N ISO weeks
  - Monthly: latest backup from each of the last N calendar months

Typical deployment:

  1. Mount your backup destination somewhere (NFS, ZFS bind mount, USB drive,
     external HDD, sshfs, whatever). Set BACKUP_ROOT to that path.
  2. Copy this script to /opt/persmem/scripts/ and chmod +x it.
  3. Schedule with systemd timer or cron. See README for unit files.
  4. Test: run once manually, confirm tarball lands in BACKUP_ROOT.

This is an example from the persMEM repo. Tune the config block for your
setup. If you're running a single-instance persMEM without AMQ, leave the
AMQ_MAILDIRS list empty — the script will skip those sections cleanly.
"""

import os
import sys
import tarfile
import hashlib
import shutil
import tempfile
import subprocess
import glob
import re
from datetime import datetime, timedelta, date


# ─────────────────────────────────────────────────────────────────
#  CONFIGURATION — edit this block for your deployment
# ─────────────────────────────────────────────────────────────────

# Where your ChromaDB persistent directory lives.
# Must match the persmem server's CHROMADB_PATH.
CHROMADB_PATH = "/var/lib/persmem/chromadb"

# Where backups should land. Create this directory before running.
# Examples:
#   /mnt/backups/persmem       (local mount, NFS, or ZFS bind mount)
#   /media/usb-drive/persmem   (external USB drive)
#   /var/backups/persmem       (same disk — NOT RECOMMENDED for real DR)
BACKUP_ROOT = "/mnt/backups/persmem"

# Name of your persmem systemd service. The script will stop this briefly
# while copying ChromaDB for a consistent SQLite snapshot, then restart it.
# Set to None if persMEM doesn't run as a systemd service on your system
# (e.g., it runs in a container, a screen/tmux session, or doesn't write
# often enough for live-copy inconsistency to matter).
PERSMEM_SERVICE = "persmem.service"

# Optional AMQ (agent message queue) maildirs to include in the backup.
# If you run multiple agent instances that communicate via AMQ, add each
# maildir root here. Leave empty [] for a single-instance deployment.
#
# Each entry is (source_path, archive_name). archive_name is the filename
# used inside the tarball — pick something descriptive.
AMQ_MAILDIRS = [
    # Example: multi-agent AMQ directories
    # ("/home/persmem/amq",        "amq-agents.tar"),
    # ("/var/lib/persmem-amq",     "amq-news.tar"),
]

# Compression. "zstd" is recommended (install `zstd` package). Falls back
# to gzip if zstd isn't installed. Set explicitly if you want to force one.
COMPRESSION = "auto"   # "zstd", "gzip", or "auto"

# Retention tiers (GFS = grandfather-father-son)
KEEP_DAILY   = 14   # any backup from within the last N days
KEEP_WEEKLY  = 8    # latest backup per ISO week, last N weeks
KEEP_MONTHLY = 12   # latest backup per calendar month, last N months

# ─────────────────────────────────────────────────────────────────


BACKUP_PREFIX = "persmem-backup-"
CHECKSUM_FILE = os.path.join(BACKUP_ROOT, "SHA256SUMS")


def log(msg):
    print(f"[{datetime.now().isoformat(timespec='seconds')}] {msg}", flush=True)


def sha256_of_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def pick_compression():
    """Return ('ext', ['tar', 'compress', 'args']) for the chosen compressor."""
    if COMPRESSION == "gzip":
        return "tar.gz", ["-czf"]
    if COMPRESSION == "zstd":
        return _zstd_args()
    # auto: try zstd, fall back to gzip
    if shutil.which("zstd"):
        return _zstd_args()
    return "tar.gz", ["-czf"]


def _zstd_args():
    return "tar.zst", ["--use-compress-program", "zstd -19 -T0", "-cf"]


def list_collections():
    """Return all ChromaDB collection names. Works across chromadb versions."""
    import chromadb
    client = chromadb.PersistentClient(path=CHROMADB_PATH)
    try:
        # chromadb >= 0.5 returns a list of Collection objects
        cols = client.list_collections()
        names = [c.name if hasattr(c, "name") else c for c in cols]
    except Exception:
        # Fallback for older chromadb
        names = [c.name for c in client.list_collections()]
    return sorted(names)


def dump_collection_md(collection_name, out_path):
    """Export a ChromaDB collection to markdown."""
    import chromadb
    client = chromadb.PersistentClient(path=CHROMADB_PATH)
    collection = client.get_collection(collection_name)
    results = collection.get(include=["documents", "metadatas"])

    with open(out_path, "w") as f:
        f.write(f"# persMEM {collection_name} backup\n")
        f.write(f"**Exported:** {datetime.now().isoformat()}\n")
        f.write(f"**Total chunks:** {len(results['ids'])}\n\n---\n\n")
        for doc_id, doc, meta in zip(
            results["ids"], results["documents"], results["metadatas"]
        ):
            f.write(f"## {doc_id}\n")
            for k, v in (meta or {}).items():
                f.write(f"- **{k}:** {v}\n")
            f.write(f"\n{doc}\n\n---\n\n")
    return len(results["ids"])


def stop_service_if_possible():
    """Try to stop the persmem service. Return True if we actually stopped it."""
    if not PERSMEM_SERVICE:
        return False
    try:
        r = subprocess.run(
            ["systemctl", "stop", PERSMEM_SERVICE],
            capture_output=True, text=True, timeout=30,
        )
    except FileNotFoundError:
        log("systemctl not available — skipping service stop")
        return False
    if r.returncode == 0:
        log(f"Stopped {PERSMEM_SERVICE} for consistent snapshot")
        return True
    log(f"WARN: could not stop {PERSMEM_SERVICE}: {r.stderr.strip()}")
    log("Proceeding with live copy — snapshot may be inconsistent for recent writes")
    return False


def start_service_if_stopped(was_stopped):
    if not was_stopped or not PERSMEM_SERVICE:
        return
    subprocess.run(
        ["systemctl", "start", PERSMEM_SERVICE],
        capture_output=True, text=True, timeout=30,
    )
    log(f"Restarted {PERSMEM_SERVICE}")


def build_backup(workdir, today_str):
    """Assemble backup contents inside workdir, then tar+compress them.
    Returns path to the final tarball in BACKUP_ROOT."""

    # 1. Markdown dumps of every collection present
    collection_counts = {}
    collections = list_collections()
    if not collections:
        log("WARN: no ChromaDB collections found — is CHROMADB_PATH correct?")
    for name in collections:
        md_path = os.path.join(workdir, f"{name}.md")
        n = dump_collection_md(name, md_path)
        collection_counts[name] = n
        log(f"Markdown dump: {name}.md ({n} chunks)")

    # 2. ChromaDB binary (drop-in restore). Stop service briefly for a
    #    consistent SQLite snapshot.
    chromadb_dst = os.path.join(workdir, "chromadb")
    was_stopped = stop_service_if_possible()
    try:
        shutil.copytree(CHROMADB_PATH, chromadb_dst)
        log(f"Copied ChromaDB binary: {CHROMADB_PATH} → chromadb/")
    finally:
        start_service_if_stopped(was_stopped)

    # 3. Optional AMQ maildirs (as nested tars to preserve Maildir structure)
    amq_archives = []
    for src_path, archive_name in AMQ_MAILDIRS:
        if not os.path.isdir(src_path):
            log(f"Skipping AMQ source {src_path} — not a directory")
            continue
        archive_path = os.path.join(workdir, archive_name)
        with tarfile.open(archive_path, "w") as tf:
            tf.add(src_path, arcname=os.path.basename(src_path.rstrip("/")))
        amq_archives.append(archive_name)
        log(f"Archived AMQ maildir {src_path} → {archive_name}")

    # 4. MANIFEST with per-file sha256 (directories hashed at tarball level only)
    manifest = os.path.join(workdir, "MANIFEST.txt")
    top_level_files = [f"{name}.md" for name in collections] + amq_archives

    with open(manifest, "w") as f:
        f.write(f"persMEM backup {today_str}\n")
        f.write(f"Created: {datetime.now().isoformat()}\n")
        for name, count in collection_counts.items():
            f.write(f"{name} chunks: {count}\n")
        f.write(f"\n# sha256 of top-level entries\n")
        for rel in top_level_files:
            full = os.path.join(workdir, rel)
            digest = sha256_of_file(full)
            f.write(f"{digest}  {rel}\n")
        f.write(f"# chromadb/ is a directory tree — hashed at tarball level only\n")
    log("MANIFEST written")

    # 5. Build the compressed tarball
    ext, tar_args = pick_compression()
    final_name = f"{BACKUP_PREFIX}{today_str}.{ext}"
    final_path = os.path.join(BACKUP_ROOT, final_name)

    payload = top_level_files + ["MANIFEST.txt", "chromadb"]
    cmd = ["tar"] + tar_args + [final_path, "-C", workdir] + payload
    subprocess.run(cmd, check=True)
    size_kb = os.path.getsize(final_path) / 1024
    log(f"Created {final_path} ({size_kb:.0f} KB)")

    # 6. Append outer sha256 to SHA256SUMS
    outer_digest = sha256_of_file(final_path)
    with open(CHECKSUM_FILE, "a") as f:
        f.write(f"{outer_digest}  {final_name}\n")
    log(f"Outer sha256: {outer_digest[:16]}...")

    return final_path


# ─────────────────────────────────────────────────────────────────
#  GFS Retention
# ─────────────────────────────────────────────────────────────────

DATE_PATTERN = re.compile(
    r"^" + re.escape(BACKUP_PREFIX) + r"(\d{4}-\d{2}-\d{2})\.tar\.(?:zst|gz)$"
)


def parse_backup_date(filename):
    m = DATE_PATTERN.search(filename)
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1), "%Y-%m-%d").date()
    except ValueError:
        return None


def gfs_classify(backup_dates, today):
    """Given all backup dates, return the set to KEEP.

    Rules:
      - Any backup from within the last KEEP_DAILY days
      - Latest backup per ISO week, last KEEP_WEEKLY weeks
      - Latest backup per calendar month, last KEEP_MONTHLY months
    """
    backup_dates = sorted(set(backup_dates))
    keep = set()

    daily_cutoff = today - timedelta(days=KEEP_DAILY)
    for d in backup_dates:
        if d > daily_cutoff:
            keep.add(d)

    by_week = {}
    for d in backup_dates:
        year, week, _ = d.isocalendar()
        key = (year, week)
        if key not in by_week or d > by_week[key]:
            by_week[key] = d
    for wk in sorted(by_week.keys(), reverse=True)[:KEEP_WEEKLY]:
        keep.add(by_week[wk])

    by_month = {}
    for d in backup_dates:
        key = (d.year, d.month)
        if key not in by_month or d > by_month[key]:
            by_month[key] = d
    for mo in sorted(by_month.keys(), reverse=True)[:KEEP_MONTHLY]:
        keep.add(by_month[mo])

    return keep


def prune(today):
    files = glob.glob(os.path.join(BACKUP_ROOT, f"{BACKUP_PREFIX}*.tar.zst"))
    files += glob.glob(os.path.join(BACKUP_ROOT, f"{BACKUP_PREFIX}*.tar.gz"))
    date_to_file = {}
    for fp in files:
        d = parse_backup_date(os.path.basename(fp))
        if d:
            # If both .zst and .gz exist for the same day (e.g. compression
            # switched mid-deployment), keep the newer file.
            if d not in date_to_file or os.path.getmtime(fp) > os.path.getmtime(date_to_file[d]):
                date_to_file[d] = fp

    keep_dates = gfs_classify(list(date_to_file.keys()), today)
    to_delete = [
        (d, fp) for d, fp in date_to_file.items() if d not in keep_dates
    ]

    for d, fp in sorted(to_delete):
        log(f"Pruning {os.path.basename(fp)} (date {d})")
        os.remove(fp)

    log(
        f"Retention: {len(keep_dates)} kept, {len(to_delete)} pruned, "
        f"{len(date_to_file)} total before prune"
    )


# ─────────────────────────────────────────────────────────────────
#  Main
# ─────────────────────────────────────────────────────────────────

def main():
    if not os.path.isdir(BACKUP_ROOT):
        log(f"FATAL: backup target {BACKUP_ROOT} does not exist — is it mounted?")
        sys.exit(1)
    if not os.access(BACKUP_ROOT, os.W_OK):
        log(f"FATAL: backup target {BACKUP_ROOT} not writable by {os.getenv('USER', '?')}")
        sys.exit(1)
    if not os.path.isdir(CHROMADB_PATH):
        log(f"FATAL: CHROMADB_PATH {CHROMADB_PATH} does not exist")
        sys.exit(1)

    today = date.today()
    today_str = today.isoformat()

    # Idempotent: skip build if today's backup already exists
    existing = glob.glob(
        os.path.join(BACKUP_ROOT, f"{BACKUP_PREFIX}{today_str}.tar.*")
    )
    if existing:
        log(f"Today's backup already exists: {existing[0]}")
        log("Running prune only.")
        prune(today)
        return

    with tempfile.TemporaryDirectory(prefix="persmem-backup-") as workdir:
        build_backup(workdir, today_str)

    prune(today)
    log("Done.")


if __name__ == "__main__":
    main()
