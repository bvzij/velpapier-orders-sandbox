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
    need_user(authorization)
    with db() as con:
        f = folder_row(con, folder)
        if not f or f["trashed_at"]:
            raise HTTPException(404, "Carpeta no encontrada")
        folders = con.execute("SELECT f.*, (SELECT COUNT(*) FROM files x WHERE x.folder_id=f.id AND x.trashed_at IS NULL) AS n "
                              "FROM folders f WHERE parent_id=? AND trashed_at IS NULL ORDER BY name COLLATE NOCASE", (folder,)).fetchall()
        files = con.execute("SELECT * FROM files WHERE folder_id=? AND trashed_at IS NULL ORDER BY uploaded_at DESC", (folder,)).fetchall()
        cache = {}
        return {
            "folder": {"id": f["id"], "name": f["name"], "public": bool(f["public"]), "effective_public": is_public(con, f["id"])},
            "path": folder_path(con, folder),
            "folders": [{"id": r["id"], "name": r["name"], "public": bool(r["public"]), "files": r["n"],
                         "created_by": r["created_by"], "created_at": r["created_at"]} for r in folders],
            "files": [file_out(con, r, cache) for r in files],
        }


@app.get("/api/recent")
def recent(kind: str = "", limit: int = 200, authorization: str = Header(None)):
    need_user(authorization)
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
            d = file_out(con, r, cache)
            if r["folder_id"] not in paths:
                paths[r["folder_id"]] = " / ".join(p["name"] for p in folder_path(con, r["folder_id"])[1:])
            d["folder_path"] = paths[r["folder_id"]]
            out.append(d)
        return {"files": out}


@app.get("/api/search")
def search(q: str = "", authorization: str = Header(None)):
    need_user(authorization)
    q = q.strip()
    if len(q) < 2:
        return {"files": [], "folders": []}
    like = "%" + q.replace("%", "") + "%"
    with db() as con:
        files = con.execute("SELECT * FROM files WHERE trashed_at IS NULL AND name LIKE ? ORDER BY uploaded_at DESC LIMIT 300", (like,)).fetchall()
        folders = con.execute("SELECT * FROM folders WHERE trashed_at IS NULL AND id<>'root' AND name LIKE ? LIMIT 100", (like,)).fetchall()
        cache, out = {}, []
        for r in files:
            d = file_out(con, r, cache)
            d["folder_path"] = " / ".join(p["name"] for p in folder_path(con, r["folder_id"])[1:])
            out.append(d)
        return {"files": out, "folders": [{"id": r["id"], "name": r["name"], "public": bool(r["public"]),
                                           "path": " / ".join(p["name"] for p in folder_path(con, r["id"])[1:])} for r in folders]}


@app.get("/api/trash")
def trash_list(authorization: str = Header(None)):
    need_user(authorization)
    with db() as con:
        files = con.execute("SELECT * FROM files WHERE trashed_at IS NOT NULL ORDER BY trashed_at DESC LIMIT 1000").fetchall()
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


@app.post("/api/move")
def move(body: dict = Body(...), authorization: str = Header(None)):
    need_user(authorization)
    to = body.get("to") or "root"
    with _db_lock, db() as con:
        dest = folder_row(con, to)
        if not dest or dest["trashed_at"]:
            raise HTTPException(404, "Carpeta destino no encontrada")
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
