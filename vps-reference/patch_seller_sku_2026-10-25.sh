#!/bin/bash
# tiktok-import patch 2026-10-25: pass the CSV "Seller SKU" into every line item,
# so Apps Script can link TikTok orders to products created in Productos by SKU.
# Run with:
#   curl -fsSL https://raw.githubusercontent.com/bvzij/velpapier-orders-sandbox/main/vps-reference/patch_seller_sku_2026-10-25.sh | bash
set -e
C=$(docker ps --format '{{.Names}}' | grep -i 'tiktok-import' | head -1)
[ -z "$C" ] && { echo "FAILED  tiktok-import container not running"; exit 1; }
WD=$(docker inspect "$C" --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}')
F=$(find "$WD" -maxdepth 3 -name tiktok_lib.py -not -path '*/node_modules/*' | head -1)
[ -z "$F" ] && F=$(find /root /opt /home -maxdepth 4 -name tiktok_lib.py 2>/dev/null | head -1)
[ -z "$F" ] && { echo "FAILED  tiktok_lib.py not found"; exit 1; }
echo "OK  found $F (compose folder $WD)"
python3 - "$F" <<'PYEOF'
import shutil, sys
path = sys.argv[1]
src = open(path, encoding="utf-8").read()
if '"seller_sku": r["seller_sku"],' in src:
    print("OK  already applied"); sys.exit(0)
old = '            "variation": r["variation"],\n            "qty":       int(qty) if qty.isdigit() else 1,\n'
new = '            "variation": r["variation"],\n            "seller_sku": r["seller_sku"],   # 2026-10-25 Productos SKU matching\n            "qty":       int(qty) if qty.isdigit() else 1,\n'
n = src.count(old)
if n != 1:
    print("FAILED  expected the line_item block exactly once, found %d time(s). Nothing changed." % n); sys.exit(1)
shutil.copy2(path, path + ".bak-20261025")
open(path, "w", encoding="utf-8").write(src.replace(old, new))
print("OK  line_item now carries seller_sku (backup: tiktok_lib.py.bak-20261025)")
PYEOF
cd "$WD" && docker compose build tiktok-import && docker compose up -d --force-recreate tiktok-import
echo "OK  tiktok-import rebuilt"
