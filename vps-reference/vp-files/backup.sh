#!/bin/bash
# vp-files nightly backup (cron: 09:00 UTC = 03:00 Querétaro).
# Dormant until rclone is installed and a remote named "vpbackup" exists
# (Backblaze B2 or Google Drive). Status shows on the Archivos page.
D=/root/vp-files
S=$D/data/backup_status.json
NOW=$(date -u +%FT%TZ)
if ! command -v rclone >/dev/null 2>&1 || ! rclone listremotes 2>/dev/null | grep -q '^vpbackup:'; then
  echo "{\"ok\":false,\"at\":\"$NOW\",\"message\":\"Respaldo no configurado todavía\"}" > "$S"
  exit 0
fi
python3 -c "import sqlite3; s=sqlite3.connect('$D/data/db/files.sqlite'); d=sqlite3.connect('$D/data/db/files-backup.sqlite'); s.backup(d); d.close(); s.close()"
rclone copy "$D/data/orig" vpbackup:vp-files/orig --transfers 4 && \
  rclone copyto "$D/data/db/files-backup.sqlite" vpbackup:vp-files/db/files.sqlite
RC=$?
BYTES=$(du -sb "$D/data/orig" | cut -f1)
if [ $RC -eq 0 ]; then
  echo "{\"ok\":true,\"at\":\"$NOW\",\"bytes\":$BYTES}" > "$S"
else
  echo "{\"ok\":false,\"at\":\"$NOW\",\"message\":\"rclone falló (ver /root/vp-files/backup.log)\"}" > "$S"
fi
