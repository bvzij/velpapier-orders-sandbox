#!/bin/bash
# Installs / updates the vp-files container (Archivos) on the Hostinger VPS.
# Run with:
#   curl -fsSL https://raw.githubusercontent.com/bvzij/velpapier-orders-sandbox/main/vps-reference/vp-files/install.sh | bash
# Safe to run again: it only (re)builds vp-files. It copies the Traefik setup of
# the existing image-service container, renamed, so n8n / tiktok-import /
# image-service are never touched.
set -e
D=/root/vp-files
RAW=https://raw.githubusercontent.com/bvzij/velpapier-orders-sandbox/main/vps-reference/vp-files
mkdir -p "$D/app" "$D/data"
for f in service.py Dockerfile requirements.txt backup.sh; do
  curl -fsSL "$RAW/$f?$(date +%s)" -o "$D/app/$f"
  echo "OK  downloaded $f"
done
mv -f "$D/app/backup.sh" "$D/backup.sh" && chmod +x "$D/backup.sh"

python3 - <<'PYEOF'
import json, re, subprocess, sys
names = subprocess.check_output(["docker", "ps", "--format", "{{.Names}}"]).decode().split()
cand = [n for n in names if "image" in n.lower() and "vp-files" not in n]
if not cand:
    sys.exit("FAILED: no running image-service container found (docker ps). Nothing was changed.")
info = json.loads(subprocess.check_output(["docker", "inspect", cand[0]]))[0]
labels = info["Config"].get("Labels") or {}
tl = {k: v for k, v in labels.items() if k.startswith("traefik.")}
if not tl:
    sys.exit("FAILED: image-service has no traefik labels, can't copy its routing. Nothing was changed.")
nets = list((info["NetworkSettings"].get("Networks") or {}).keys())
routers = sorted({k.split(".")[3] for k in tl if k.startswith("traefik.http.routers.")})
services = sorted({k.split(".")[3] for k in tl if k.startswith("traefik.http.services.")})
mws = sorted({k.split(".")[3] for k in tl if k.startswith("traefik.http.middlewares.")})
host_old = None
for k, v in tl.items():
    m = re.search(r"Host\(`([^`]+)`\)", v)
    if m:
        host_old = m.group(1); break
host_new = ("files." + host_old.split(".", 1)[1]) if host_old and host_old.startswith("img.") else "files.srv2017849.hstgr.cloud"
new = {}
for k, v in tl.items():
    parts = k.split(".")
    if k.startswith("traefik.http.routers.") and parts[3] in routers:
        parts[3] = "vpfiles-" + parts[3]
    if k.startswith("traefik.http.services.") and parts[3] in services:
        parts[3] = "vpfiles"
    if k.startswith("traefik.http.middlewares."):
        continue   # image-service's own middlewares (often CORS) are not copied: vp-files sends its own CORS headers
    nk = ".".join(parts)
    nv = v.replace(host_old, host_new) if host_old else v
    if k.endswith(".middlewares") and ".routers." in k:
        nv = ",".join(x for x in nv.split(",") if x.split("@")[0] not in mws)
        if not nv:
            continue
    if ".routers." in k and k.endswith(".service"):
        nv = "vpfiles"
    if "loadbalancer.server.port" in k:
        nv = "8000"
    new[nk] = nv
new.setdefault("traefik.enable", "true")
new["traefik.http.services.vpfiles.loadbalancer.server.port"] = "8000"
for r in routers:
    new["traefik.http.routers.vpfiles-%s.service" % r] = "vpfiles"
compose = {
    "services": {"vp-files": {
        "build": "./app", "container_name": "vp-files", "restart": "unless-stopped",
        "environment": {
            "API_URL": "https://script.google.com/macros/s/AKfycbyeywjfBWA0hFSy_3U3A2iYLE2TlPN22pBOELJ97N-FTAkgXkEAk6Af0aG1O3DjK8OjHw/exec",
            "PUBLIC_BASE": "https://" + host_new,
            "ALLOWED_ORIGINS": "https://dashboard.velpapier.com,https://velpapier-orders-sandbox.vercel.app",
            "DATA_DIR": "/data"},
        "volumes": ["/root/vp-files/data:/data"],
        "labels": new, "networks": nets}},
    "networks": {n: {"external": True, "name": n} for n in nets},
}
open("/root/vp-files/docker-compose.yml", "w").write(json.dumps(compose, indent=2))
open("/root/vp-files/host.txt", "w").write(host_new)
print("OK  copied routing from %s (networks: %s) -> https://%s" % (cand[0], ", ".join(nets), host_new))
PYEOF

HOST=$(cat "$D/host.txt")
if getent hosts "$HOST" >/dev/null; then echo "OK  $HOST resolves to $(getent hosts "$HOST" | awk '{print $1}')"; else echo "WARNING  $HOST does not resolve (DNS) — the container will run, but the browser can't reach it yet"; fi

cd "$D" && docker compose -p vpfiles up -d --build
echo "OK  container started"

( crontab -l 2>/dev/null | grep -v 'vp-files/backup.sh' ; echo "0 9 * * * /root/vp-files/backup.sh >> /root/vp-files/backup.log 2>&1" ) | crontab -
"$D/backup.sh" || true
echo "OK  nightly backup job installed (dormant until rclone remote 'vpbackup' exists)"

for i in $(seq 1 24); do
  if curl -fsS "https://$HOST/health" >/dev/null 2>&1; then echo "OK  https://$HOST/health answers — Archivos is live"; exit 0; fi
  sleep 5
done
echo "FAILED  https://$HOST/health did not answer after 2 minutes. Logs:"
docker logs --tail 40 vp-files
