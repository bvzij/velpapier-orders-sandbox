"""
vp-files — Vel Papier team file sharing ("Archivos" page in the dashboard).

Runs as its own Docker container next to tiktok-import / image-service / n8n,
behind the same Traefik. Files live on a bind-mounted folder (/data):

  /data/orig/<yyyy>/<mm>/<id><ext>   original, untouched
  /data/web/<id>.jpg                 images: longest side 1200 px (TikTok-safe)
  /data/thumb/<id>.jpg               400 px preview (videos: first frame)
  /data/tmp/                         chunked uploads in progress
  /data/db/files.sqlite              index (folders + files)
  /data/backup_status.json           written by /root/vp-files/backup.sh

Auth: the browser sends the normal dashboard token (Authorization: Bearer …
or ?t=… for plain links). It is checked once against Apps Script
(?action=whoami) and cached for 5 minutes. No separate passwords.

Public URLs (/f/, /w/, /t/) carry a random token per file, so they can't be
guessed. Files in a PRIVATE folder are only served to logged-in users.
"""
import hashlib
import json
import logging
import mimetypes
import os
import secrets
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone

from fastapi import BackgroundTasks, Body, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from PIL import Image, ImageOps

try:
    import pillow_heif  # iPhone HEIC photos
    pillow_heif.register_heif_opener()
except Exception:  # pragma: no cover
    pillow_heif = None

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("vp-files")

DATA = os.environ.get("DATA_DIR", "/data")
API_URL = os.environ["API_URL"]                       # Apps Script /exec URL (same as the dashboard)
PUBLIC_BASE = os.environ.get("PUBLIC_BASE", "").rstrip("/")
ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]
CHUNK = 8 * 1024 * 1024
MAX_FILE = 4 * 1024 ** 3
TRASH_DAYS = 30
WEB_MAX = 1200
THUMB_MAX = 400

for sub in ("orig", "web", "thumb", "tmp", "db"):
    os.makedirs(os.path.join(DATA, sub), exist_ok=True)

DB_PATH = os.path.join(DATA, "db", "files.sqlite")
_db_lock = threading.Lock()


def db():
    con = sqlite3.connect(DB_PATH, timeout=30)
    con.row_factory = sqlite3.Row
    return con


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def init_db():
    with _db_lock, db() as con:
        con.executescript("""
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS folders (
            id TEXT PRIMARY KEY, parent_id TEXT, name TEXT NOT NULL, public INTEGER NOT NULL DEFAULT 1,
            created_by TEXT, created_at TEXT, trashed_at TEXT, trashed_by TEXT);
        CREATE TABLE IF NOT EXISTS files (
            id TEXT PRIMARY KEY, folder_id TEXT NOT NULL, name TEXT NOT NULL, ext TEXT, mime TEXT,
            size INTEGER, width INTEGER, height INTEGER, duration REAL, sha256 TEXT, token TEXT NOT NULL,
            orig_path TEXT NOT NULL, has_web INTEGER DEFAULT 0, has_thumb INTEGER DEFAULT 0,
            uploaded_by TEXT, uploaded_at TEXT, trashed_at TEXT, trashed_by TEXT);
        CREATE TABLE IF NOT EXISTS uploads (
            id TEXT PRIMARY KEY, name TEXT, size INTEGER, mime TEXT, folder_id TEXT,
            received INTEGER DEFAULT 0, chunks INTEGER DEFAULT 0, started_by TEXT, started_at TEXT);
        CREATE INDEX IF NOT EXISTS ix_files_folder ON files(folder_id);
        CREATE INDEX IF NOT EXISTS ix_files_sha ON files(sha256);
        CREATE INDEX IF NOT EXISTS ix_folders_parent ON folders(parent_id);
        """)
        if not con.execute("SELECT 1 FROM folders WHERE id='root'").fetchone():
            t = now_iso()
            con.execute("INSERT INTO folders VALUES ('root', NULL, 'Archivos', 1, 'Sistema', ?, NULL, NULL)", (t,))
            for name, pub in (("Productos", 1), ("Contenido TikTok", 1), ("Privado", 0)):
                con.execute("INSERT INTO folders VALUES (?, 'root', ?, ?, 'Sistema', ?, NULL, NULL)", (new_id("D"), name, pub, t))
        # Finanzas: admin-only folder for purchase tickets (fixed id, see ADMIN_ONLY_ROOTS)
        if not con.execute("SELECT 1 FROM folders WHERE id='finanzas'").fetchone():
            con.execute("INSERT INTO folders VALUES ('finanzas', 'root', 'Finanzas', 0, 'Sistema', ?, NULL, NULL)", (now_iso(),))


def new_id(prefix="F"):
    return prefix + secrets.token_hex(5)


app = FastAPI(title="Vel Papier Files", version="1.0.0")
app.add_middleware(
    CORSMiddleware, allow_origins=ORIGINS or ["https://dashboard.velpapier.com"],
    allow_methods=["GET", "POST", "PUT", "OPTIONS"], allow_headers=["Authorization", "Content-Type"],
    expose_headers=["Content-Disposition"],
)

# ─── auth ──────────────────────────────────────────────────────────────────
_who_cache = {}


def whoami(token):
    if not token:
        return None
    hit = _who_cache.get(token)
    if hit and hit[0] > time.time():
        return hit[1]
    url = API_URL + "?action=whoami&token=" + urllib.parse.quote(token)
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            data = json.loads(r.read().decode("utf-8"))
    except Exception as e:  # Apps Script down -> nobody can log in for a moment
        log.warning("whoami failed: %s", e)
        return None
    ident = {"name": data.get("name") or "?", "role": data.get("role") or ""} if data.get("role") else None
    _who_cache[token] = (time.time() + (300 if ident else 30), ident)
    if len(_who_cache) > 500:
        _who_cache.clear()
    return ident


def need_user(authorization, t=None):
    token = ""
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    token = token or (t or "")
    ident = whoami(token)
    if not ident:
        raise HTTPException(401, "Sesión no válida. Vuelve a entrar al dashboard.")
    return ident


def need_admin(ident):
    if ident.get("role") != "admin":
        raise HTTPException(403, "Solo para administradores")


# Folders whose whole subtree only admins may browse. Files inside are still served by their
# secret per-file link to logged-in users (the dashboard hands those links out per permission).
ADMIN_ONLY_ROOTS = {"finanzas"}


def is_admin(ident):
    return bool(ident) and ident.get("role") == "admin"


def is_admin_only(con, fid):
    return any(p["id"] in ADMIN_ONLY_ROOTS for p in folder_path(con, fid))


def guard_folder(con, fid, ident):
    if not is_admin(ident) and is_admin_only(con, fid):
        raise HTTPException(403, "Carpeta solo para administradores")


# ─── helpers ───────────────────────────────────────────────────────────────
def folder_row(con, fid):
    return con.execute("SELECT * FROM folders WHERE id=?", (fid,)).fetchone()


def folder_path(con, fid):
    out, cur, hops = [], fid, 0
    while cur and hops < 30:
        r = folder_row(con, cur)
        if not r:
            break
        out.append({"id": r["id"], "name": r["name"], "public": bool(r["public"])})
        cur, hops = r["parent_id"], hops + 1
    return list(reversed(out))


def is_public(con, fid):
    # a folder is public only if it and every parent is public
    return all(p["public"] for p in folder_path(con, fid))


def safe_name(name):
    name = os.path.basename(str(name or "archivo")).strip().replace("\x00", "")
    return name[:180] or "archivo"


def file_out(con, r, pub_cache=None):
    pub_cache = pub_cache if pub_cache is not None else {}
    if r["folder_id"] not in pub_cache:
        pub_cache[r["folder_id"]] = is_public(con, r["folder_id"])
    pub = pub_cache[r["folder_id"]]
    q = urllib.parse.quote(r["name"])
    base = PUBLIC_BASE
    d = {
        "id": r["id"], "name": r["name"], "folder_id": r["folder_id"], "mime": r["mime"], "size": r["size"],
        "width": r["width"], "height": r["height"], "duration": r["duration"], "uploaded_by": r["uploaded_by"],
        "uploaded_at": r["uploaded_at"], "trashed_at": r["trashed_at"], "public": pub,
        "kind": kind_of(r["mime"]),
        "thumb_url": f"{base}/t/{r['id']}/{r['token']}.jpg" if r["has_thumb"] else "",
        "url": f"{base}/f/{r['id']}/{r['token']}/{q}",
        "web_url": f"{base}/w/{r['id']}/{r['token']}.jpg" if r["has_web"] else "",
    }
    return d


def kind_of(mime):
    mime = mime or ""
    if mime.startswith("image/"):
        return "image"
    if mime.startswith("video/"):
        return "video"
    if mime == "application/pdf":
        return "pdf"
    return "file"


def make_previews(fid, path, mime):
    """Creates web + thumb JPEGs. Returns (width, height, duration, has_web, has_thumb)."""
    w = h = None
    dur = None
    has_web = has_thumb = 0
    web = os.path.join(DATA, "web", fid + ".jpg")
    thumb = os.path.join(DATA, "thumb", fid + ".jpg")
    try:
        if (mime or "").startswith("image/"):
            with Image.open(path) as im:
                im = ImageOps.exif_transpose(im)
                w, h = im.size
                if im.mode not in ("RGB", "L"):
                    bg = Image.new("RGB", im.size, (255, 255, 255))
                    rgba = im.convert("RGBA")
                    bg.paste(rgba, mask=rgba.split()[3])
                    im = bg
                else:
                    im = im.convert("RGB")
                big = im.copy()
                big.thumbnail((WEB_MAX, WEB_MAX), Image.LANCZOS)
                big.save(web, "JPEG", quality=88, optimize=True, progressive=True)
                has_web = 1
                im.thumbnail((THUMB_MAX, THUMB_MAX), Image.LANCZOS)
                im.save(thumb, "JPEG", quality=80, optimize=True)
                has_thumb = 1
        elif (mime or "").startswith("video/"):
            probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                                    "stream=width,height:format=duration", "-of", "json", path],
                                   capture_output=True, text=True, timeout=60)
            try:
                info = json.loads(probe.stdout or "{}")
                st = (info.get("streams") or [{}])[0]
                w, h = st.get("width"), st.get("height")
                dur = float((info.get("format") or {}).get("duration") or 0) or None
            except Exception:
                pass
            frame = thumb + ".png"
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", "1", "-i", path, "-frames:v", "1", frame],
                           capture_output=True, timeout=120)
            if not os.path.exists(frame):
                subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", path, "-frames:v", "1", frame],
                               capture_output=True, timeout=120)
            if os.path.exists(frame):
                with Image.open(frame) as im:
                    im = im.convert("RGB")
                    im.thumbnail((THUMB_MAX, THUMB_MAX), Image.LANCZOS)
                    im.save(thumb, "JPEG", quality=80)
                os.remove(frame)
                has_thumb = 1
    except Exception as e:  # a broken preview never blocks the upload itself
        log.warning("preview failed for %s: %s", fid, e)
    return w, h, dur, has_web, has_thumb


# ─── basic ─────────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    return {"ok": True}


@app.get("/api/me")
def me(authorization: str = Header(None)):
    return need_user(authorization)


@app.get("/api/list")
def list_folder(folder: str = "root", authorization: str = Header(None)):
    ident = need_user(authorization)
    with db() as con:
        f = folder_row(con, folder)
        if not f or f["trashed_at"]:
            raise HTTPException(404, "Carpeta no encontrada")
        guard_folder(con, folder, ident)
        folders = con.execute("SELECT * FROM folders WHERE parent_id=? AND trashed_at IS NULL ORDER BY name COLLATE NOCASE", (folder,)).fetchall()
        files = con.execute("SELECT * FROM files WHERE folder_id=? AND trashed_at IS NULL ORDER BY uploaded_at DESC", (folder,)).fetchall()
        cache = {}
        return {
            "folder": {"id": f["id"], "name": f["name"], "public": bool(f["public"]), "effective_public": is_public(con, f["id"])},
            "path": folder_path(con, folder),
            "folders": [{"id": r["id"], "name": r["name"], "public": bool(r["public"]),
                         "files": folder_file_count(con, r["id"]), "subfolders": folder_subfolder_count(con, r["id"]),
                         "created_by": r["created_by"], "created_at": r["created_at"]} for r in folders
                        if is_admin(ident) or r["id"] not in ADMIN_ONLY_ROOTS],
            "files": [file_out(con, r, cache) for r in files],
        }


@app.get("/api/recent")
def recent(kind: str = "", limit: int = 200, authorization: str = Header(None)):
    ident = need_user(authorization)
    limit = max(1, min(limit, 1000))
    with db() as con:
        sql = "SELECT * FROM files WHERE trashed_at IS NULL"
        args = []
        if kind == "image":
            sql += " AND mime LIKE 'image/%'"
        elif kind == "video":
            sql += " AND mime LIKE 'video/%'"
        rows = con.execute(sql + " ORDER BY uploaded_at DESC LIMIT ?", args + [limit]).fetchall()
        cache, paths, out = {}, {}, []
        for r in rows:
            if not is_admin(ident) and is_admin_only(con, r["folder_id"]):
                continue
            d = file_out(con, r, cache)
            if r["folder_id"] not in paths:
                paths[r["folder_id"]] = " / ".join(p["name"] for p in folder_path(con, r["folder_id"])[1:])
            d["folder_path"] = paths[r["folder_id"]]
            out.append(d)
        return {"files": out}


@app.get("/api/search")
def search(q: str = "", authorization: str = Header(None)):
    ident = need_user(authorization)
    q = q.strip()
    if len(q) < 2:
        return {"files": [], "folders": []}
    like = "%" + q.replace("%", "") + "%"
    with db() as con:
        files = con.execute("SELECT * FROM files WHERE trashed_at IS NULL AND name LIKE ? ORDER BY uploaded_at DESC LIMIT 300", (like,)).fetchall()
        folders = con.execute("SELECT * FROM folders WHERE trashed_at IS NULL AND id<>'root' AND name LIKE ? LIMIT 100", (like,)).fetchall()
        cache, out = {}, []
        for r in files:
            if not is_admin(ident) and is_admin_only(con, r["folder_id"]):
                continue
            d = file_out(con, r, cache)
            d["folder_path"] = " / ".join(p["name"] for p in folder_path(con, r["folder_id"])[1:])
            out.append(d)
        return {"files": out, "folders": [{"id": r["id"], "name": r["name"], "public": bool(r["public"]),
                                           "path": " / ".join(p["name"] for p in folder_path(con, r["id"])[1:])} for r in folders
                                          if is_admin(ident) or not is_admin_only(con, r["id"])]}


@app.get("/api/trash")
def trash_list(authorization: str = Header(None)):
    ident = need_user(authorization)
    with db() as con:
        files = con.execute("SELECT * FROM files WHERE trashed_at IS NOT NULL ORDER BY trashed_at DESC LIMIT 1000").fetchall()
        if not is_admin(ident):
            files = [r for r in files if not is_admin_only(con, r["folder_id"])]
        folders = con.execute("SELECT * FROM folders WHERE trashed_at IS NOT NULL ORDER BY trashed_at DESC").fetchall()
        cache, out = {}, []
        for r in files:
            d = file_out(con, r, cache)
            d["trashed_by"] = r["trashed_by"]
            out.append(d)
        return {"files": out, "folders": [{"id": r["id"], "name": r["name"], "trashed_at": r["trashed_at"],
                                           "trashed_by": r["trashed_by"]} for r in folders], "days": TRASH_DAYS}


@app.get("/api/usage")
def usage(authorization: str = Header(None)):
    need_user(authorization)
    du = shutil.disk_usage(DATA)
    with db() as con:
        r = con.execute("SELECT COUNT(*) n, COALESCE(SUM(size),0) s FROM files WHERE trashed_at IS NULL").fetchone()
        t = con.execute("SELECT COUNT(*) n, COALESCE(SUM(size),0) s FROM files WHERE trashed_at IS NOT NULL").fetchone()
    backup = None
    try:
        with open(os.path.join(DATA, "backup_status.json")) as fh:
            backup = json.load(fh)
    except Exception:
        pass
    return {"disk_total": du.total, "disk_used": du.used, "disk_free": du.free,
            "files": r["n"], "files_bytes": r["s"], "trash_files": t["n"], "trash_bytes": t["s"], "backup": backup}


# ─── organize ──────────────────────────────────────────────────────────────
@app.post("/api/folder")
def create_folder(body: dict = Body(...), authorization: str = Header(None)):
    ident = need_user(authorization)
    name = safe_name(body.get("name"))[:80]
    parent = body.get("parent_id") or "root"
    with _db_lock, db() as con:
        p = folder_row(con, parent)
        if not p or p["trashed_at"]:
            raise HTTPException(404, "Carpeta no encontrada")
        guard_folder(con, parent, ident)
        if con.execute("SELECT 1 FROM folders WHERE parent_id=? AND name=? AND trashed_at IS NULL", (parent, name)).fetchone():
            raise HTTPException(400, "Ya existe una carpeta con ese nombre aquí")
        fid = new_id("D")
        pub = 1 if body.get("public", p["public"]) else 0
        con.execute("INSERT INTO folders VALUES (?,?,?,?,?,?,NULL,NULL)", (fid, parent, name, pub, ident["name"], now_iso()))
    return {"ok": True, "id": fid}


@app.post("/api/folder_from_files")
def folder_from_files(body: dict = Body(...), authorization: str = Header(None)):
    # Archivos "drag photos to make a folder" flow: create the folder and
    # move the dropped files into it in one transaction, so a mid-way failure
    # never leaves a half-made folder or half-moved files.
    ident = need_user(authorization)
    name = safe_name(body.get("name"))[:80]
    parent = body.get("parent_id") or "root"
    file_ids = body.get("file_ids") or []
    if not file_ids:
        raise HTTPException(400, "No hay fotos para mover")
    with _db_lock, db() as con:
        p = folder_row(con, parent)
        if not p or p["trashed_at"]:
            raise HTTPException(404, "Carpeta no encontrada")
        if con.execute("SELECT 1 FROM folders WHERE parent_id=? AND name=? AND trashed_at IS NULL", (parent, name)).fetchone():
            raise HTTPException(400, "Ya existe una carpeta con ese nombre aquí")
        fid = new_id("D")
        con.execute("INSERT INTO folders VALUES (?,?,?,?,?,?,NULL,NULL)", (fid, parent, name, p["public"], ident["name"], now_iso()))
        for file_id in file_ids:
            con.execute("UPDATE files SET folder_id=? WHERE id=?", (fid, file_id))
    return {"ok": True, "id": fid}


@app.post("/api/rename")
def rename(body: dict = Body(...), authorization: str = Header(None)):
    need_user(authorization)
    name = safe_name(body.get("name"))
    tid = body.get("id")
    with _db_lock, db() as con:
        if body.get("kind") == "folder":
            if tid == "root":
                raise HTTPException(400, "La carpeta principal no se puede renombrar")
            con.execute("UPDATE folders SET name=? WHERE id=?", (name[:80], tid))
        else:
            con.execute("UPDATE files SET name=? WHERE id=?", (name, tid))
    return {"ok": True}


@app.post("/api/visibility")
def visibility(body: dict = Body(...), authorization: str = Header(None)):
    ident = need_user(authorization)
    need_admin(ident)
    fid = body.get("folder_id")
    if fid == "root":
        raise HTTPException(400, "La carpeta principal siempre es pública")
    with _db_lock, db() as con:
        con.execute("UPDATE folders SET public=? WHERE id=?", (1 if body.get("public") else 0, fid))
    return {"ok": True}


def _descendants(con, fid):
    out, stack = [], [fid]
    while stack:
        cur = stack.pop()
        out.append(cur)
        stack.extend(r["id"] for r in con.execute("SELECT id FROM folders WHERE parent_id=?", (cur,)).fetchall())
    return out


def folder_file_count(con, fid):
    # recursive: a folder's count includes files sitting in its subfolders,
    # not just direct children (Vel: "0 archivos" was wrong when the 8
    # photos were one level down).
    ids = _descendants(con, fid)
    q = ",".join("?" * len(ids))
    return con.execute(f"SELECT COUNT(*) FROM files WHERE folder_id IN ({q}) AND trashed_at IS NULL", ids).fetchone()[0]


def folder_subfolder_count(con, fid):
    return con.execute("SELECT COUNT(*) FROM folders WHERE parent_id=? AND trashed_at IS NULL", (fid,)).fetchone()[0]


@app.post("/api/move")
def move(body: dict = Body(...), authorization: str = Header(None)):
    ident = need_user(authorization)
    to = body.get("to") or "root"
    with _db_lock, db() as con:
        dest = folder_row(con, to)
        if not dest or dest["trashed_at"]:
            raise HTTPException(404, "Carpeta destino no encontrada")
        guard_folder(con, to, ident)
        for fid in body.get("folder_ids") or []:
            if fid == "root" or to in _descendants(con, fid):
                raise HTTPException(400, "No puedes mover una carpeta dentro de sí misma")
            con.execute("UPDATE folders SET parent_id=? WHERE id=?", (to, fid))
        for fid in body.get("file_ids") or []:
            con.execute("UPDATE files SET folder_id=? WHERE id=?", (to, fid))
    return {"ok": True}


@app.post("/api/trash")
def trash(body: dict = Body(...), authorization: str = Header(None)):
    ident = need_user(authorization)
    t = now_iso()
    with _db_lock, db() as con:
        for fid in body.get("file_ids") or []:
            con.execute("UPDATE files SET trashed_at=?, trashed_by=? WHERE id=? AND trashed_at IS NULL", (t, ident["name"], fid))
        for fid in body.get("folder_ids") or []:
            if fid == "root":
                continue
            for d in _descendants(con, fid):
                con.execute("UPDATE folders SET trashed_at=?, trashed_by=? WHERE id=? AND trashed_at IS NULL", (t, ident["name"], d))
                con.execute("UPDATE files SET trashed_at=?, trashed_by=? WHERE folder_id=? AND trashed_at IS NULL", (t, ident["name"], d))
    return {"ok": True}


@app.post("/api/restore")
def restore(body: dict = Body(...), authorization: str = Header(None)):
    need_user(authorization)
    with _db_lock, db() as con:
        for fid in body.get("folder_ids") or []:
            for d in _descendants(con, fid):
                con.execute("UPDATE folders SET trashed_at=NULL, trashed_by=NULL WHERE id=?", (d,))
                con.execute("UPDATE files SET trashed_at=NULL, trashed_by=NULL WHERE folder_id=?", (d,))
        for fid in body.get("file_ids") or []:
            r = con.execute("SELECT folder_id FROM files WHERE id=?", (fid,)).fetchone()
            if not r:
                continue
            f = folder_row(con, r["folder_id"])
            target = r["folder_id"] if f and not f["trashed_at"] else "root"   # parent folder gone -> back to root
            con.execute("UPDATE files SET trashed_at=NULL, trashed_by=NULL, folder_id=? WHERE id=?", (target, fid))
    return {"ok": True}


def _delete_file_from_disk(con, r):
    for p in (r["orig_path"], os.path.join(DATA, "web", r["id"] + ".jpg"), os.path.join(DATA, "thumb", r["id"] + ".jpg")):
        try:
            if p and os.path.exists(p):
                os.remove(p)
        except Exception as e:
            log.warning("delete failed %s: %s", p, e)
    con.execute("DELETE FROM files WHERE id=?", (r["id"],))


@app.post("/api/purge")
def purge(body: dict = Body(...), authorization: str = Header(None)):
    ident = need_user(authorization)
    need_admin(ident)
    n = 0
    with _db_lock, db() as con:
        ids = body.get("file_ids")
        rows = con.execute("SELECT * FROM files WHERE trashed_at IS NOT NULL").fetchall() if body.get("all") else \
            [r for r in (con.execute("SELECT * FROM files WHERE id=?", (i,)).fetchone() for i in (ids or [])) if r and r["trashed_at"]]
        for r in rows:
            _delete_file_from_disk(con, r)
            n += 1
        if body.get("all"):
            con.execute("DELETE FROM folders WHERE trashed_at IS NOT NULL AND id NOT IN (SELECT DISTINCT folder_id FROM files)")
    log.info("purge by %s: %d files", ident["name"], n)
    return {"ok": True, "deleted": n}


# ─── upload (chunked) ──────────────────────────────────────────────────────
@app.post("/api/upload/init")
def upload_init(body: dict = Body(...), authorization: str = Header(None)):
    ident = need_user(authorization)
    size = int(body.get("size") or 0)
    if size <= 0:
        raise HTTPException(400, "Archivo vacío")
    if size > MAX_FILE:
        raise HTTPException(400, "El archivo pasa de 4 GB")
    folder = body.get("folder_id") or "root"
    with _db_lock, db() as con:
        f = folder_row(con, folder)
        if not f or f["trashed_at"]:
            raise HTTPException(404, "Carpeta no encontrada")
        guard_folder(con, folder, ident)
        uid = new_id("U")
        chunks = (size + CHUNK - 1) // CHUNK
        con.execute("INSERT INTO uploads VALUES (?,?,?,?,?,0,?,?,?)",
                    (uid, safe_name(body.get("name")), size, str(body.get("mime") or "")[:100], folder, chunks, ident["name"], now_iso()))
    open(os.path.join(DATA, "tmp", uid), "wb").close()
    return {"upload_id": uid, "chunk_size": CHUNK, "chunks": chunks}


@app.put("/api/upload/{uid}/{n}")
async def upload_chunk(uid: str, n: int, request: Request, authorization: str = Header(None)):
    need_user(authorization)
    with db() as con:
        u = con.execute("SELECT * FROM uploads WHERE id=?", (uid,)).fetchone()
    if not u:
        raise HTTPException(404, "Subida no encontrada (¿expiró?). Vuelve a subir el archivo.")
    if n < u["received"]:
        return {"ok": True, "received": u["received"]}          # resent chunk after a network blip
    if n != u["received"]:
        raise HTTPException(409, "Parte fuera de orden")
    data = await request.body()
    if not data or len(data) > CHUNK:
        raise HTTPException(400, "Parte inválida")
    with open(os.path.join(DATA, "tmp", uid), "ab") as fh:
        fh.write(data)
    with _db_lock, db() as con:
        con.execute("UPDATE uploads SET received=received+1 WHERE id=?", (uid,))
    return {"ok": True, "received": n + 1}


@app.post("/api/upload/{uid}/complete")
def upload_complete(uid: str, authorization: str = Header(None)):
    ident = need_user(authorization)
    tmp = os.path.join(DATA, "tmp", uid)
    with db() as con:
        u = con.execute("SELECT * FROM uploads WHERE id=?", (uid,)).fetchone()
    if not u or not os.path.exists(tmp):
        raise HTTPException(404, "Subida no encontrada")
    if os.path.getsize(tmp) != u["size"]:
        raise HTTPException(400, "El archivo llegó incompleto. Vuelve a subirlo.")
    name = u["name"]
    ext = os.path.splitext(name)[1].lower()[:10]
    mime = u["mime"] or mimetypes.guess_type(name)[0] or "application/octet-stream"
    if ext in (".heic", ".heif"):
        mime = "image/heic"
    sha = hashlib.sha256()
    with open(tmp, "rb") as fh:
        for block in iter(lambda: fh.read(1024 * 1024), b""):
            sha.update(block)
    digest = sha.hexdigest()
    fid = new_id("F")
    stamp = datetime.now(timezone.utc)
    dest_dir = os.path.join(DATA, "orig", stamp.strftime("%Y"), stamp.strftime("%m"))
    os.makedirs(dest_dir, exist_ok=True)
    dest = os.path.join(dest_dir, fid + ext)
    shutil.move(tmp, dest)
    w, h, dur, has_web, has_thumb = make_previews(fid, dest, mime)
    with _db_lock, db() as con:
        dup = con.execute("SELECT id, name, folder_id FROM files WHERE sha256=? AND trashed_at IS NULL LIMIT 1", (digest,)).fetchone()
        con.execute("INSERT INTO files (id, folder_id, name, ext, mime, size, width, height, duration, sha256, token, orig_path, "
                    "has_web, has_thumb, uploaded_by, uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (fid, u["folder_id"], name, ext, mime, u["size"], w, h, dur, digest, secrets.token_urlsafe(12),
                     dest, has_web, has_thumb, ident["name"], now_iso()))
        con.execute("DELETE FROM uploads WHERE id=?", (uid,))
        r = con.execute("SELECT * FROM files WHERE id=?", (fid,)).fetchone()
        out = file_out(con, r)
    if dup:
        out["duplicate_of"] = {"id": dup["id"], "name": dup["name"], "folder_id": dup["folder_id"]}
    log.info("upload %s %s (%d bytes) by %s", fid, name, u["size"], ident["name"])
    return out


# ─── serving ───────────────────────────────────────────────────────────────
def _file_by_token(fid, token):
    with db() as con:
        r = con.execute("SELECT * FROM files WHERE id=?", (fid,)).fetchone()
        if not r or not secrets.compare_digest(str(r["token"]), str(token)):
            raise HTTPException(404, "No encontrado")
        return r, is_public(con, r["folder_id"])


def _check_private(pub, trashed, t, authorization):
    if pub and not trashed:
        return
    need_user(authorization, t)        # private or trashed -> logged-in team only


@app.get("/f/{fid}/{token}/{name}")
def get_file(fid: str, token: str, name: str, dl: int = 0, t: str = Query(None), authorization: str = Header(None)):
    r, pub = _file_by_token(fid, token)
    _check_private(pub, r["trashed_at"], t, authorization)
    if not os.path.exists(r["orig_path"]):
        raise HTTPException(404, "El archivo ya no está en el disco")
    return FileResponse(r["orig_path"], media_type=r["mime"], filename=r["name"],
                        content_disposition_type="attachment" if dl else "inline",
                        headers={"Cache-Control": "public, max-age=86400" if pub else "private, max-age=600"})


@app.get("/w/{fid}/{token}.jpg")
def get_web(fid: str, token: str, t: str = Query(None), authorization: str = Header(None)):
    r, pub = _file_by_token(fid, token)
    _check_private(pub, r["trashed_at"], t, authorization)
    p = os.path.join(DATA, "web", fid + ".jpg")
    if not os.path.exists(p):
        raise HTTPException(404, "Sin versión web")
    return FileResponse(p, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=604800" if pub else "private, max-age=600"})


@app.get("/t/{fid}/{token}.jpg")
def get_thumb(fid: str, token: str):
    _file_by_token(fid, token)
    p = os.path.join(DATA, "thumb", fid + ".jpg")
    if not os.path.exists(p):
        raise HTTPException(404, "Sin miniatura")
    return FileResponse(p, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=604800"})


@app.get("/api/zip")
def zip_files(background: BackgroundTasks, ids: str = "", t: str = Query(None), authorization: str = Header(None)):
    need_user(authorization, t)
    id_list = [i for i in ids.split(",") if i][:500]
    if not id_list:
        raise HTTPException(400, "Nada que descargar")
    fd, path = tempfile.mkstemp(suffix=".zip", dir=os.path.join(DATA, "tmp"))
    os.close(fd)
    used = set()
    with db() as con, zipfile.ZipFile(path, "w", zipfile.ZIP_STORED, allowZip64=True) as z:
        for fid in id_list:
            r = con.execute("SELECT * FROM files WHERE id=?", (fid,)).fetchone()
            if not r or not os.path.exists(r["orig_path"]):
                continue
            n, base, ext, k = r["name"], os.path.splitext(r["name"])[0], os.path.splitext(r["name"])[1], 1
            while n in used:
                k += 1
                n = f"{base} ({k}){ext}"
            used.add(n)
            z.write(r["orig_path"], n)
    background.add_task(lambda: os.path.exists(path) and os.remove(path))
    return FileResponse(path, media_type="application/zip", filename="velpapier_" + datetime.now().strftime("%Y%m%d_%H%M") + ".zip")


# ─── Finanzas tickets: Archivos/Finanzas/<yyyy-mm>/<proveedor>/ ─────────────
# Upload: any logged-in dashboard user (Apps Script decides who may attach it to an expense).
# Place / read: only Apps Script, with the secret in /data/fin_key.txt (Script Property VPFILES_FIN_KEY).
FIN_KEY_PATH = os.path.join(DATA, "fin_key.txt")
FIN_MAX = 25 * 1024 * 1024


def fin_key():
    if not os.path.exists(FIN_KEY_PATH):
        with open(FIN_KEY_PATH, "w") as fh:
            fh.write(secrets.token_urlsafe(32))
    with open(FIN_KEY_PATH) as fh:
        return fh.read().strip()


def need_fin_key(key):
    if not key or not secrets.compare_digest(str(key), fin_key()):
        raise HTTPException(401, "Llave de Finanzas inválida")   # TROUBLESHOOT: Script Property VPFILES_FIN_KEY must equal /data/fin_key.txt


def fin_month(periodo=""):
    p = str(periodo or "")
    if len(p) == 7 and p[4] == "-" and p[:4].isdigit() and p[5:].isdigit():
        return p
    from datetime import timedelta
    return datetime.now(timezone(timedelta(hours=-6))).strftime("%Y-%m")   # Mexico City (no DST)


def ensure_folder(con, parent, name):
    name = safe_name(name).replace("/", "-")[:80] or "Sin nombre"
    r = con.execute("SELECT id FROM folders WHERE parent_id=? AND name=? AND trashed_at IS NULL", (parent, name)).fetchone()
    if r:
        return r["id"]
    fid = new_id("D")
    con.execute("INSERT INTO folders VALUES (?,?,?,0,'Sistema',?,NULL,NULL)", (fid, parent, name, now_iso()))
    return fid


@app.post("/api/fin/upload")
async def fin_upload(request: Request, name: str = "ticket.jpg", mime: str = "", periodo: str = "", authorization: str = Header(None)):
    ident = need_user(authorization)
    data = await request.body()
    if not data:
        raise HTTPException(400, "Archivo vacío")
    if len(data) > FIN_MAX:
        raise HTTPException(400, "El archivo pasa de 25 MB")
    name = safe_name(name)
    ext = os.path.splitext(name)[1].lower()[:10] or ".jpg"
    mime = (mime or mimetypes.guess_type(name)[0] or "application/octet-stream")[:100]
    if not (mime.startswith("image/") or mime == "application/pdf"):
        raise HTTPException(400, "Solo fotos o PDF")
    fid = new_id("F")
    stamp = datetime.now(timezone.utc)
    dest_dir = os.path.join(DATA, "orig", stamp.strftime("%Y"), stamp.strftime("%m"))
    os.makedirs(dest_dir, exist_ok=True)
    dest = os.path.join(dest_dir, fid + ext)
    with open(dest, "wb") as fh:
        fh.write(data)
    w, h, dur, has_web, has_thumb = make_previews(fid, dest, mime)
    with _db_lock, db() as con:
        folder = ensure_folder(con, ensure_folder(con, "finanzas", fin_month(periodo)), "Sin proveedor")
        con.execute("INSERT INTO files (id, folder_id, name, ext, mime, size, width, height, duration, sha256, token, orig_path, "
                    "has_web, has_thumb, uploaded_by, uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (fid, folder, name, ext, mime, len(data), w, h, dur, hashlib.sha256(data).hexdigest(), secrets.token_urlsafe(12),
                     dest, has_web, has_thumb, ident["name"], now_iso()))
        out = file_out(con, con.execute("SELECT * FROM files WHERE id=?", (fid,)).fetchone())
    log.info("fin upload %s %s (%d bytes) by %s", fid, name, len(data), ident["name"])
    return out


FIN_KEEP_MAX = 1600     # long side kept after the expense is saved (the AI already read the sharp upload)
FIN_KEEP_Q = 75


def fin_shrink(ids):
    """Background: replace saved ticket originals with a 1600 px / 75% JPEG. Web + thumb copies stay."""
    for fid in ids:
        try:
            with db() as con:
                r = con.execute("SELECT * FROM files WHERE id=?", (fid,)).fetchone()
                if not r or r["mime"] != "image/jpeg" or not is_admin_only(con, r["folder_id"]):
                    continue
            if max(r["width"] or 0, r["height"] or 0) <= FIN_KEEP_MAX or not os.path.exists(r["orig_path"]):
                continue
            with Image.open(r["orig_path"]) as im:
                im = ImageOps.exif_transpose(im).convert("RGB")
                im.thumbnail((FIN_KEEP_MAX, FIN_KEEP_MAX), Image.LANCZOS)
                tmp = r["orig_path"] + ".tmp"
                im.save(tmp, "JPEG", quality=FIN_KEEP_Q, optimize=True)
                w, h = im.size
            with open(tmp, "rb") as fh:
                digest = hashlib.sha256(fh.read()).hexdigest()
            size = os.path.getsize(tmp)
            os.replace(tmp, r["orig_path"])
            with _db_lock, db() as con:
                con.execute("UPDATE files SET size=?, width=?, height=?, sha256=? WHERE id=?", (size, w, h, digest, fid))
            log.info("fin shrink %s %d -> %d bytes", fid, r["size"] or 0, size)
        except Exception as e:
            log.warning("fin shrink %s failed: %s", fid, e)


@app.post("/api/fin/place")
def fin_place(background: BackgroundTasks, body: dict = Body(...), x_fin_key: str = Header(None)):
    need_fin_key(x_fin_key)
    ids = [str(i) for i in (body.get("ids") or [])][:200]
    moved = 0
    with _db_lock, db() as con:
        dest = ensure_folder(con, ensure_folder(con, "finanzas", fin_month(body.get("periodo"))), body.get("vendor") or "Sin proveedor")
        for fid in ids:
            r = con.execute("SELECT folder_id FROM files WHERE id=?", (fid,)).fetchone()
            if r and r["folder_id"] != dest and is_admin_only(con, r["folder_id"]):   # only ever moves files already under Finanzas
                con.execute("UPDATE files SET folder_id=? WHERE id=?", (dest, fid))
                moved += 1
    background.add_task(fin_shrink, ids)   # runs after the answer is sent: saving never waits for it
    return {"ok": True, "moved": moved, "folder_id": dest}


@app.get("/api/fin/file/{fid}")
def fin_file(fid: str, x_fin_key: str = Header(None)):
    need_fin_key(x_fin_key)
    with db() as con:
        r = con.execute("SELECT * FROM files WHERE id=?", (fid,)).fetchone()
        if not r or not is_admin_only(con, r["folder_id"]):
            raise HTTPException(404, "No encontrado")
    if not os.path.exists(r["orig_path"]):
        raise HTTPException(404, "El archivo ya no está en el disco")
    return FileResponse(r["orig_path"], media_type=r["mime"], filename=r["name"])


fin_key()   # create the secret on first start


# ─── housekeeping ──────────────────────────────────────────────────────────
def housekeeping_loop():
    while True:
        try:
            cutoff = datetime.fromtimestamp(time.time() - TRASH_DAYS * 86400, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            with _db_lock, db() as con:
                old = con.execute("SELECT * FROM files WHERE trashed_at IS NOT NULL AND trashed_at < ?", (cutoff,)).fetchall()
                for r in old:
                    _delete_file_from_disk(con, r)
                con.execute("DELETE FROM folders WHERE trashed_at IS NOT NULL AND trashed_at < ? "
                            "AND id NOT IN (SELECT DISTINCT folder_id FROM files)", (cutoff,))
                stale = con.execute("SELECT id FROM uploads WHERE started_at < ?",
                                    (datetime.fromtimestamp(time.time() - 86400, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),)).fetchall()
                for s in stale:
                    p = os.path.join(DATA, "tmp", s["id"])
                    if os.path.exists(p):
                        os.remove(p)
                    con.execute("DELETE FROM uploads WHERE id=?", (s["id"],))
            if old:
                log.info("housekeeping: purged %d files older than %d days in trash", len(old), TRASH_DAYS)
            for fn in os.listdir(os.path.join(DATA, "tmp")):   # leftover zips
                p = os.path.join(DATA, "tmp", fn)
                if fn.endswith(".zip") and time.time() - os.path.getmtime(p) > 3600:
                    os.remove(p)
        except Exception as e:
            log.warning("housekeeping error: %s", e)
        time.sleep(6 * 3600)


@app.on_event("startup")
def startup():
    init_db()
    threading.Thread(target=housekeeping_loop, daemon=True).start()
    log.info("vp-files ready, data=%s public=%s", DATA, PUBLIC_BASE)


@app.exception_handler(HTTPException)
def http_err(request, exc):
    return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)

@app.exception_handler(HTTPException)
def http_err(request, exc):
    return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)
