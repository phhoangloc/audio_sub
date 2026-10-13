"""Web UI cho audio_sub: nhập link YouTube -> subtitle.
Chạy: python web_app.py  ->  http://127.0.0.1:5000"""
import shutil
import tempfile
import threading
import uuid
from pathlib import Path
from urllib.parse import quote, urlparse

from flask import Flask, Response, jsonify, render_template, request, send_file

from audio_sub import FORMATS, LANGS, MODELS, format_segments, transcribe

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024**3  # 2 GB

WORK_DIR = Path(tempfile.gettempdir()) / "audio_sub_jobs"
WORK_DIR.mkdir(exist_ok=True)

YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}

jobs: dict[str, dict] = {}
run_lock = threading.Lock()  # chỉ xử lý một video tại một thời điểm


def is_youtube_url(url: str) -> bool:
    try:
        u = urlparse(url)
    except ValueError:
        return False
    return u.scheme in ("http", "https") and (u.hostname or "").lower() in YOUTUBE_HOSTS


def download_audio(url: str, out_dir: Path, job: dict, kind: str = "audio"):
    """Tải âm thanh (m4a/webm) hoặc video mp4 một file, không cần ffmpeg. Trả về (đường dẫn file, tiêu đề)."""
    import yt_dlp

    label = "video" if kind == "video" else "âm thanh"

    def hook(d):
        if d["status"] == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            if total:
                frac = d["downloaded_bytes"] / total
                job.update(progress=frac, message=f"Đang tải {label} từ YouTube... {frac:.0%}")

    opts = {
        "format": "best[ext=mp4]/best" if kind == "video" else "bestaudio[ext=m4a]/bestaudio",
        "outtmpl": str(out_dir / f"{kind}.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "progress_hooks": [hook],
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
    files = [p for p in out_dir.glob(f"{kind}.*") if p.suffix not in (".part", ".ytdl")]
    if not files:
        raise RuntimeError(f"Không tải được {label} từ link này.")
    return files[0], info.get("title") or "subtitle"


def _worker(job_id: str, url, model: str, lang, upload_path=None):
    job = jobs[job_id]
    work = WORK_DIR / job_id
    work.mkdir(exist_ok=True)
    try:
        with run_lock:
            if upload_path:
                path = upload_path
                job.update(status="running", progress=0.0)
            else:
                job.update(status="running", message="Đang tải âm thanh từ YouTube...")
                path, title = download_audio(url, work, job)
                job.update(name=title, progress=0.0)
            job["segments"] = transcribe(
                path, model, lang,
                on_status=lambda m: job.update(message=m),
                on_progress=lambda f: job.update(progress=f))
        job["status"] = "done"
        job["message"] = f"Xong — {len(job['segments'])} dòng subtitle."
    except Exception as e:  # noqa: BLE001
        job["status"] = "error"
        job["message"] = str(e)
    finally:
        if not upload_path:  # file tải lên được giữ lại để phát lại từng câu
            shutil.rmtree(work, ignore_errors=True)


@app.errorhandler(413)
def too_large(_):
    return jsonify(error="File quá lớn (tối đa 2 GB)."), 413


def _download_worker(job_id: str, url: str, kind: str):
    job = jobs[job_id]
    work = WORK_DIR / job_id
    work.mkdir(exist_ok=True)
    try:
        job.update(status="running", message="Đang tải từ YouTube...")
        path, title = download_audio(url, work, job, kind)
        job.update(file=path, name=title, progress=1.0, status="done", message="Đã tải xong.")
    except Exception as e:  # noqa: BLE001
        job.update(status="error", message=str(e))
        shutil.rmtree(work, ignore_errors=True)


@app.get("/")
def index():
    return render_template("index.html", models=MODELS, langs=list(LANGS), formats=FORMATS)


@app.post("/api/jobs")
def create_job():
    upload = request.files.get("file")
    data = request.form if upload else (request.get_json(silent=True) or {})
    url = (data.get("url") or "").strip()
    mode = data.get("mode", "subtitle")
    model = data.get("model", "small")
    lang_name = data.get("lang", "Tự động")
    if not upload and not is_youtube_url(url):
        return jsonify(error="Link không hợp lệ. Hãy dán link YouTube (youtube.com hoặc youtu.be)."), 400
    if model not in MODELS or lang_name not in LANGS:
        return jsonify(error="Tham số không hợp lệ."), 400

    if mode in ("audio", "video"):
        if not is_youtube_url(url):
            return jsonify(error="Link không hợp lệ."), 400
        job_id = uuid.uuid4().hex
        jobs[job_id] = {"status": "queued", "progress": 0.0, "message": "Đang chờ...",
                        "segments": [], "name": "media", "file": None}
        threading.Thread(target=_download_worker, args=(job_id, url, mode), daemon=True).start()
        return jsonify(id=job_id)

    job_id = uuid.uuid4().hex
    upload_path = None
    name = "subtitle"
    if upload:
        work = WORK_DIR / job_id
        work.mkdir(exist_ok=True)
        name = Path(upload.filename or "").stem or "subtitle"
        upload_path = work / ("upload" + (Path(upload.filename or "").suffix or ".bin"))
        upload.save(upload_path)
    jobs[job_id] = {"status": "queued", "progress": 0.0, "message": "Đang chờ...",
                    "segments": [], "name": name, "audio": upload_path}
    threading.Thread(target=_worker, args=(job_id, url, model, LANGS[lang_name], upload_path), daemon=True).start()
    return jsonify(id=job_id)


@app.get("/api/jobs/<job_id>")
def job_status(job_id):
    job = jobs.get(job_id)
    if not job:
        return jsonify(error="Không tìm thấy."), 404
    segs = job["segments"] if job["status"] == "done" else []
    return jsonify(status=job["status"], progress=job["progress"], message=job["message"], segments=segs)


@app.put("/api/jobs/<job_id>/segments/<int:idx>")
def edit_segment(job_id, idx):
    job = jobs.get(job_id)
    text = ((request.get_json(silent=True) or {}).get("text") or "").strip()
    if not job or job["status"] != "done" or not 0 <= idx < len(job["segments"]) or not text:
        return jsonify(error="Không sửa được."), 400
    job["segments"][idx]["text"] = text
    return jsonify(ok=True)


@app.get("/api/jobs/<job_id>/file")
def job_file(job_id):
    job = jobs.get(job_id)
    if not job or job["status"] != "done" or not job.get("file"):
        return jsonify(error="Chưa có file."), 404
    path = Path(job["file"])
    return send_file(path, as_attachment=True, download_name=f"{job['name']}{path.suffix}")


@app.get("/api/jobs/<job_id>/audio")
def job_audio(job_id):
    job = jobs.get(job_id)
    if not job or not job.get("audio"):
        return jsonify(error="Không có file âm thanh."), 404
    return send_file(job["audio"], conditional=True)


@app.get("/api/jobs/<job_id>/result")
def job_result(job_id):
    job = jobs.get(job_id)
    fmt = request.args.get("fmt", "srt")
    if not job or job["status"] != "done" or fmt not in FORMATS:
        return jsonify(error="Chưa có kết quả."), 404
    body = format_segments(job["segments"], fmt)
    headers = {}
    if request.args.get("download"):
        headers["Content-Disposition"] = f"attachment; filename*=UTF-8''{quote(job['name'])}.{fmt}"
    return Response(body, mimetype="text/plain; charset=utf-8", headers=headers)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, threaded=True)
