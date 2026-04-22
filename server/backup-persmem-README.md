# Example: persMEM Backup

A reference backup script for persMEM deployments. Produces one compressed
tarball per day, rotates with grandfather-father-son retention, verifies with
SHA256, and plays nicely with systemd timers.

This is an **example** — the pathnames and service names assume defaults that
may not match your setup. Edit the `CONFIGURATION` block at the top of
`example-backup-persmem.py` before running.

## What it backs up

| Source | In tarball as | Restore path |
|---|---|---|
| ChromaDB persistent directory (binary) | `chromadb/` | Drop-in replace |
| Every ChromaDB collection (markdown) | `<name>.md` | Re-ingest fallback |
| Optional AMQ maildirs (if multi-agent) | `amq-*.tar` | Maildir extract |
| Computed manifest | `MANIFEST.txt` | SHA256 integrity |

If you run a single-instance persMEM (no agent-to-agent AMQ), leave
`AMQ_MAILDIRS = []` and the script skips those sections cleanly.

## Retention

Grandfather-father-son:

- **Daily**: any backup from within the last `KEEP_DAILY` days (default 14)
- **Weekly**: latest backup per ISO week, for the last `KEEP_WEEKLY` weeks (default 8)
- **Monthly**: latest backup per calendar month, for the last `KEEP_MONTHLY` months (default 12)

At steady state this is roughly 34 files. A typical backup is 2–5 MB compressed
with zstd, so the whole rotation fits in ~200 MB.

## Dependencies

- Python 3 with the `chromadb` package (same version as your persMEM server uses)
- `tar`
- `zstd` for best compression (recommended; `apt install zstd` on Debian/Ubuntu).
  Falls back to gzip automatically if zstd isn't installed.

## Quick start

1. **Pick a backup destination.** This should be on different physical storage
   from your ChromaDB data. Good choices:
   - A mirrored ZFS/Btrfs dataset on another disk
   - An NFS mount from a different host
   - An external USB drive mounted persistently
   - sshfs to another machine

   The one thing you **don't** want: the same disk as ChromaDB. The whole
   point is survivability.

2. **Edit the CONFIGURATION block** in `example-backup-persmem.py`:

   ```python
   CHROMADB_PATH = "/var/lib/persmem/chromadb"
   BACKUP_ROOT   = "/mnt/backups/persmem"
   PERSMEM_SERVICE = "persmem.service"   # or None
   AMQ_MAILDIRS  = []                     # or your maildir paths
   ```

3. **Install:**

   ```bash
   sudo mkdir -p /opt/persmem/scripts
   sudo cp example-backup-persmem.py /opt/persmem/scripts/backup-persmem.py
   sudo chmod +x /opt/persmem/scripts/backup-persmem.py
   ```

4. **Test once manually:**

   ```bash
   sudo /opt/persmem/scripts/backup-persmem.py
   ```

   You should see output like:

   ```
   [2026-04-22T02:00:01] Markdown dump: memories.md (482 chunks)
   [2026-04-22T02:00:02] Stopped persmem.service for consistent snapshot
   [2026-04-22T02:00:07] Copied ChromaDB binary: /var/lib/persmem/chromadb → chromadb/
   [2026-04-22T02:00:07] Restarted persmem.service
   [2026-04-22T02:00:09] MANIFEST written
   [2026-04-22T02:00:15] Created /mnt/backups/persmem/persmem-backup-2026-04-22.tar.zst (2134 KB)
   [2026-04-22T02:00:15] Retention: 1 kept, 0 pruned, 1 total before prune
   [2026-04-22T02:00:15] Done.
   ```

5. **Schedule with systemd timer:**

   Create `/etc/systemd/system/persmem-backup.service`:

   ```ini
   [Unit]
   Description=persMEM daily backup
   After=persmem.service
   Wants=persmem.service

   [Service]
   Type=oneshot
   ExecStart=/opt/persmem/scripts/backup-persmem.py
   User=root
   # root is needed to stop/start the persmem service and to read any
   # AMQ maildirs owned by other users. If your deployment doesn't
   # require either, run as a less-privileged user with write access
   # to BACKUP_ROOT.
   ```

   Create `/etc/systemd/system/persmem-backup.timer`:

   ```ini
   [Unit]
   Description=Run persMEM backup daily

   [Timer]
   OnCalendar=*-*-* 03:00:00
   Persistent=true
   RandomizedDelaySec=600

   [Install]
   WantedBy=timers.target
   ```

   Enable:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now persmem-backup.timer
   systemctl list-timers persmem-backup.timer
   ```

   `Persistent=true` ensures the backup runs on next boot if the system was
   powered off at 03:00. `RandomizedDelaySec=600` spreads load if you have
   multiple backup tasks scheduled around the same time.

   Logs go to the journal: `journalctl -u persmem-backup.service`.

### Or via cron

If you prefer cron to systemd timers:

```
0 3 * * * /opt/persmem/scripts/backup-persmem.py >> /var/log/persmem-backup.log 2>&1
```

Place in root's crontab (`sudo crontab -e`) so the script can stop/start the
service.

## Restore

Each tarball is self-contained. Pick the one you want to restore from
and verify it first:

```bash
BACKUP=/mnt/backups/persmem/persmem-backup-2026-04-22.tar.zst
grep "$(basename $BACKUP)" /mnt/backups/persmem/SHA256SUMS | sha256sum -c -
```

### Fast path: binary drop-in

This is the recommended restore when the tarball was built by a service-stop
snapshot (clean SQLite state):

```bash
mkdir -p /tmp/restore && cd /tmp/restore
tar --zstd -xf "$BACKUP"
# (use -xzf for .tar.gz)

sudo systemctl stop persmem.service
sudo mv /var/lib/persmem/chromadb /var/lib/persmem/chromadb.old
sudo cp -r chromadb /var/lib/persmem/chromadb
sudo chown -R persmem:persmem /var/lib/persmem/chromadb
sudo systemctl start persmem.service

# Verify
journalctl -u persmem.service -n 30
```

If startup is clean, remove the `.old` directory. If it fails, swap it back:

```bash
sudo systemctl stop persmem.service
sudo rm -rf /var/lib/persmem/chromadb
sudo mv /var/lib/persmem/chromadb.old /var/lib/persmem/chromadb
sudo systemctl start persmem.service
```

### Slow path: markdown re-ingest

If the binary copy is corrupted or you're migrating to a different embedding
model or a new ChromaDB version, re-ingest from the markdown dumps. The files
use one `## <chunk-id>` header per memory, metadata fields as bullet list,
then the content body.

A minimal re-ingest looks like:

```python
import re, chromadb
from pathlib import Path

TEXT = Path("/tmp/restore/memories.md").read_text()
client = chromadb.PersistentClient(path="/var/lib/persmem/chromadb")
col = client.get_or_create_collection("memories")

# Parse the markdown — each chunk is "## <id>\n<meta bullets>\n\n<body>\n\n---\n"
# Adjust to your dump format if you customized it.
for chunk in TEXT.split("\n---\n"):
    if "## mem-" not in chunk:
        continue
    # Extract id, metadata, body — left as an exercise; the format is stable
    # enough to handle with regex or a small state machine.
    ...
```

Full ingest scripts tend to be deployment-specific (what metadata you preserved,
which collection to write to, whether to regenerate embeddings or store
pre-computed ones). The markdown is a *fallback* — the binary restore should
work in the common case.

### Restore AMQ maildirs

```bash
cd /tmp/restore
sudo tar -xf amq-agents.tar -C /home/persmem/
sudo chown -R persmem:persmem /home/persmem/amq
```

## Good practice

- **Test restores quarterly.** An untested backup is a rumor. Set a calendar
  reminder, pick a random tarball, restore into a scratch directory, run
  `chromadb` against it to confirm it opens cleanly.
- **Monitor the timer.** `systemctl list-timers persmem-backup.timer`. If
  the LAST column is older than 25 hours, something is wrong.
- **Keep an off-site copy.** This script only handles one destination. For
  true disaster recovery (fire, theft, ransomware), rsync or restic the
  backup directory to a second location weekly.
- **Encrypt if untrusted storage.** If your backup destination is an NFS
  share someone else admins, wrap the tarball in age/gpg/restic before
  leaving the LXC.

## Troubleshooting

**"backup target does not exist"** — the mount isn't there. Check with
`mount | grep backups` or `df /mnt/backups/persmem`.

**"not writable by ..."** — wrong permissions on the mount. If you're using
an unprivileged container, remember the uid inside gets mapped to a different
uid outside (usually +100000). Chown the destination to the mapped uid.

**"could not stop persmem.service"** — the user running the script doesn't
have permission. Either run as root, or grant polkit rules for the specific
stop/start actions.

**Tarball keeps growing** — ChromaDB grew. Normal up to a point. If it
exceeds 50–100 MB per backup, consider trimming old collection content or
switching to off-site cold storage for anything older than the monthly tier.

**SHA256SUMS keeps growing forever** — yes, it's append-only. Rotate it
yourself once a year, or add a rotation step to the script if it matters.
