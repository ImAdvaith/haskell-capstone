#!/usr/bin/env python3
"""
Bridge server: Flask API that wraps the Haskell peer_cli / torrent_cli binaries
and the DHT REST API, streaming chunk-level download events via SSE.
"""

import hashlib
import json
import math
import os
import queue
import subprocess
import threading
import time

from flask import Flask, Response, jsonify, request, send_from_directory
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(BASE_DIR)   # haskell-capstone/
PEER_CLI = os.path.join(ROOT_DIR, "peer_cli")
TORRENT_CLI = os.path.join(ROOT_DIR, "torrent_cli")
UPLOAD_DIR = os.path.join(ROOT_DIR, "uploads")
DOWNLOAD_DIR = os.path.join(ROOT_DIR, "downloads")
DHT_BASE = "http://127.0.0.1:8080"
CHUNK_SIZE = 262144   # 256 KB  – must match TorrentClient.hs

os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(DOWNLOAD_DIR, exist_ok=True)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(65536), b""):
            h.update(block)
    return h.hexdigest()


def dht_peers(file_hash: str) -> list[str]:
    """Return all peers for a hash from the DHT server."""
    import urllib.request
    try:
        url = f"{DHT_BASE}/getall/{file_hash}"
        with urllib.request.urlopen(url, timeout=3) as r:
            body = r.read().decode().strip()
        if not body or body == "Not found":
            return []
        return [p.strip() for p in body.split(",") if p.strip()]
    except Exception:
        return []


def dht_register(file_hash: str, peer_ip: str) -> bool:
    """Register a file hash → peer_ip mapping in the DHT."""
    import urllib.request
    try:
        url = f"{DHT_BASE}/store/{file_hash}/{peer_ip}"
        req = urllib.request.Request(url, method="POST")
        with urllib.request.urlopen(req, timeout=3):
            pass
        return True
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Routes — static
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return send_from_directory(BASE_DIR, "index.html")


@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory(BASE_DIR, filename)


# ---------------------------------------------------------------------------
# Routes — API
# ---------------------------------------------------------------------------

@app.route("/api/status")
def status():
    return jsonify({"status": "ok", "dht": DHT_BASE})


@app.route("/api/files")
def list_files():
    """Return files available in upload & download dirs."""
    results = []
    for d, kind in [(UPLOAD_DIR, "shared"), (DOWNLOAD_DIR, "downloaded")]:
        for fname in os.listdir(d):
            fpath = os.path.join(d, fname)
            if os.path.isfile(fpath):
                results.append({
                    "name": fname,
                    "kind": kind,
                    "size": os.path.getsize(fpath),
                    "hash": fname if len(fname) == 64 else None,
                    "path": fpath,
                })
    return jsonify(results)


@app.route("/api/upload", methods=["POST"])
def upload():
    """
    Receive a file, save it, compute its SHA-256, register with DHT.
    Query param: peer_ip (default: 127.0.0.1:<port>)
    """
    if "file" not in request.files:
        return jsonify({"error": "No file in request"}), 400

    f = request.files["file"]
    peer_ip = request.form.get("peer_ip", "127.0.0.1:8888")

    # Save under original name first, then under hash
    orig_name = f.filename or "upload"
    tmp_path = os.path.join(UPLOAD_DIR, orig_name)
    f.save(tmp_path)

    file_hash = sha256_file(tmp_path)
    final_path = os.path.join(UPLOAD_DIR, file_hash)
    os.rename(tmp_path, final_path)

    size = os.path.getsize(final_path)
    num_chunks = max(1, math.ceil(size / CHUNK_SIZE))

    dht_register(file_hash, peer_ip)

    return jsonify({
        "hash": file_hash,
        "name": orig_name,
        "size": size,
        "num_chunks": num_chunks,
        "peer_ip": peer_ip,
        "registered": True,
    })


@app.route("/api/peers/<file_hash>")
def peers(file_hash: str):
    return jsonify({"hash": file_hash, "peers": dht_peers(file_hash)})


@app.route("/api/download", methods=["POST"])
def download():
    """
    Trigger a parallel chunk download.
    Body: {"hash": "<sha256>"}
    Returns SSE stream of chunk events.
    """
    data = request.get_json(force=True, silent=True) or {}
    file_hash = data.get("hash", "").strip()
    if not file_hash:
        return jsonify({"error": "hash required"}), 400

    # Discover peers
    peer_list = dht_peers(file_hash)
    if not peer_list:
        return jsonify({"error": "No peers found for this hash"}), 404

    # Try to find file size from first peer
    total_size = _probe_size(file_hash, peer_list)
    if total_size is None:
        # Fall back to a reasonable default for demo
        total_size = CHUNK_SIZE * max(1, len(peer_list))

    num_chunks = max(1, math.ceil(total_size / CHUNK_SIZE))

    event_q: queue.Queue = queue.Queue()

    def worker():
        """Simulate parallel chunk downloads, pushing SSE events."""
        threads = []
        for idx in range(num_chunks):
            peer = peer_list[idx % len(peer_list)]
            t = threading.Thread(
                target=_download_chunk,
                args=(file_hash, idx, num_chunks, peer, total_size, event_q),
                daemon=True,
            )
            threads.append(t)

        # Stagger starts slightly for visual effect
        for idx, t in enumerate(threads):
            time.sleep(min(0.05, 0.3 / max(num_chunks, 1)))
            t.start()

        for t in threads:
            t.join()

        event_q.put({"type": "complete", "hash": file_hash, "chunks": num_chunks, "peers": peer_list})

    threading.Thread(target=worker, daemon=True).start()

    def stream():
        yield _sse({"type": "init", "hash": file_hash, "peers": peer_list,
                     "num_chunks": num_chunks, "total_size": total_size})
        while True:
            try:
                evt = event_q.get(timeout=60)
                yield _sse(evt)
                if evt.get("type") == "complete":
                    break
            except queue.Empty:
                yield _sse({"type": "heartbeat"})

    return Response(stream(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _sse(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


def _probe_size(file_hash: str, peers: list[str]) -> int | None:
    """HEAD request to first peer to get Content-Length."""
    import urllib.request
    for peer in peers:
        try:
            url = f"http://{peer}/{file_hash}"
            req = urllib.request.Request(url, method="HEAD")
            with urllib.request.urlopen(req, timeout=4) as r:
                cl = r.headers.get("Content-Length")
                if cl:
                    return int(cl)
        except Exception:
            continue
    return None


def _download_chunk(
    file_hash: str,
    idx: int,
    total_chunks: int,
    peer: str,
    total_size: int,
    q: queue.Queue,
):
    start = idx * CHUNK_SIZE
    end = min(total_size - 1, start + CHUNK_SIZE - 1)
    byte_count = end - start + 1

    q.put({"type": "chunk_start", "chunk": idx, "peer": peer,
            "start": start, "end": end})

    out_path = os.path.join(DOWNLOAD_DIR, f"{file_hash}.part{idx}")
    file_url = f"http://{peer}/{file_hash}"

    # Build the same shell script as TorrentClient.hs
    script = (
        "set -e; "
        'curl -sS --fail "$1" | tail -c +$(( $2 + 1 )) | head -c "$3" > "$4"; '
        'actual=$(wc -c < "$4"); '
        '[ "$actual" -eq "$3" ]'
    )

    t0 = time.time()
    try:
        result = subprocess.run(
            ["sh", "-c", script, "--", file_url, str(start), str(byte_count), out_path],
            capture_output=True, timeout=60,
        )
        elapsed = round(time.time() - t0, 3)
        if result.returncode == 0:
            q.put({"type": "chunk_done", "chunk": idx, "peer": peer,
                    "bytes": byte_count, "elapsed": elapsed})
        else:
            q.put({"type": "chunk_error", "chunk": idx, "peer": peer,
                    "error": result.stderr.decode(errors="replace")[:200]})
    except subprocess.TimeoutExpired:
        q.put({"type": "chunk_error", "chunk": idx, "peer": peer,
                "error": "timeout"})
    except Exception as exc:
        q.put({"type": "chunk_error", "chunk": idx, "peer": peer,
                "error": str(exc)})


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print("Bridge server starting on http://0.0.0.0:5050")
    app.run(host="0.0.0.0", port=5050, threaded=True, debug=False)
