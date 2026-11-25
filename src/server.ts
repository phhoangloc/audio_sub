/** Web UI cho audio_sub: nhập link YouTube / tải file lên -> subtitle.
 *  Chạy: npm start  ->  http://127.0.0.1:5000/type/ */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { FORMATS, LANGS, ROOT, type Format, type Segment } from "./config.js";
import { formatSegments, parseTime } from "./format.js";
import { transcribe } from "./gemini.js";
import { downloadMedia, isYoutubeUrl } from "./youtube.js";

interface Job {
  status: "queued" | "running" | "done" | "error";
  progress: number;
  message: string;
  segments: Segment[];
  name: string;
  url?: string;
  audio?: string | null;
  file?: string | null;
}

interface Meta { name: string; url: string; audio: string | null; saved: number; segments: Segment[] }

const WORK_DIR = path.join(os.tmpdir(), "audio_sub_jobs");
const LIBRARY_DIR = path.join(ROOT, "library"); // nơi lưu các bài đã bấm "Lưu"
const UPLOAD_LIMIT = 2 * 1024 ** 3; // 2 GB
fs.mkdirSync(WORK_DIR, { recursive: true });
fs.mkdirSync(LIBRARY_DIR, { recursive: true });

const jobs = new Map<string, Job>();

// Chỉ xử lý một video tại một thời điểm.
let queue: Promise<unknown> = Promise.resolve();
const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
};

const newId = () => crypto.randomBytes(16).toString("hex");
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isFormat = (f: unknown): f is Format => FORMATS.includes(f as Format);

// Toàn bộ route nằm dưới BASE_PATH (.env, mặc định /type); đặt BASE_PATH=/ để chạy ở gốc.
const BASE_PATH = "/" + (process.env.BASE_PATH ?? "/type").replace(/^\/+|\/+$/g, "");
const server = express();
const app = express.Router();
app.use(express.json());
const upload = multer({ dest: path.join(WORK_DIR, "incoming"), limits: { fileSize: UPLOAD_LIMIT } });

function render(file: string, vars: Record<string, string> = {}): string {
  let html = fs.readFileSync(path.join(ROOT, "templates", file), "utf8");
  for (const [k, v] of Object.entries(vars)) html = html.replaceAll(k, v);
  return html;
}
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

app.get("/", (_req, res) => {
  res.type("html").send(render("index.html", {
    __LANG_OPTIONS__: Object.keys(LANGS).map((l) => `<option>${escapeHtml(l)}</option>`).join(""),
    __FORMAT_BUTTONS__: FORMATS.map((f) =>
      `<button data-fmt="${f}" class="${f === "srt" ? "on" : ""}">${f.toUpperCase()}</button>`).join(""),
  }));
});

app.get("/dictation", (_req, res) => {
  res.type("html").send(render("dictation.html"));
});

app.get("/dictation-penguin", (_req, res) => {
  res.type("html").send(render("dictation-penguin.html"));
});

async function subtitleWorker(id: string, lang: string | null, upl: string | null, start: number, end: number | null) {
  const job = jobs.get(id)!;
  const work = path.join(WORK_DIR, id);
  fs.mkdirSync(work, { recursive: true });
  try {
    await exclusive(async () => {
      let file = upl;
      if (file) {
        Object.assign(job, { status: "running", progress: 0 });
      } else {
        Object.assign(job, { status: "running", message: "Downloading audio from YouTube..." });
        const [p, title] = await downloadMedia(job.url!, work, "audio", (progress, message) => Object.assign(job, { progress, message }));
        file = p;
        Object.assign(job, { name: title, progress: 0 });
      }
      await transcribe(file, lang, {
        onStatus: (message) => (job.message = message),
        onProgress: (progress) => (job.progress = progress),
        onSegment: (s) => job.segments.push(s), // thêm dần để giao diện hiện từng câu ngay khi có
      }, start, end);
    });
    job.status = "done";
    job.message = `Done — ${job.segments.length} subtitle lines.`;
  } catch (e) {
    job.status = "error";
    job.message = errMsg(e);
  } finally {
    if (!upl) fs.rmSync(work, { recursive: true, force: true }); // file tải lên được giữ lại để phát lại từng câu
  }
}

async function downloadWorker(id: string, url: string, kind: "audio" | "video") {
  const job = jobs.get(id)!;
  const work = path.join(WORK_DIR, id);
  fs.mkdirSync(work, { recursive: true });
  try {
    Object.assign(job, { status: "running", message: "Downloading from YouTube..." });
    const [file, name] = await downloadMedia(url, work, kind, (progress, message) => Object.assign(job, { progress, message }));
    Object.assign(job, { file, name, progress: 1, status: "done", message: "Download complete." });
  } catch (e) {
    Object.assign(job, { status: "error", message: errMsg(e) });
    fs.rmSync(work, { recursive: true, force: true });
  }
}

app.post("/api/jobs", upload.single("file"), (req, res) => {
  const upl = req.file;
  const data: Record<string, unknown> = upl ? req.body : req.body ?? {};
  const url = String(data.url ?? "").trim();
  const mode = String(data.mode ?? "subtitle");
  const langName = String(data.lang ?? "Auto");
  const bad = (error: string) => {
    if (upl) fs.rmSync(upl.path, { force: true });
    return res.status(400).json({ error });
  };
  if (!upl && !isYoutubeUrl(url)) return bad("Invalid link. Paste a YouTube link (youtube.com or youtu.be).");
  if (!(langName in LANGS)) return bad("Invalid parameter.");
  let start: number | null, end: number | null;
  try {
    start = parseTime(data.start);
    end = parseTime(data.end);
  } catch {
    return bad("Invalid time. Use a format like 90, 1:30 or 1:02:03.");
  }
  if (end !== null && end <= (start ?? 0)) return bad("The end time must be after the start time.");

  const id = newId();
  if (mode === "audio" || mode === "video") {
    if (!isYoutubeUrl(url)) return bad("Invalid link.");
    jobs.set(id, { status: "queued", progress: 0, message: "Waiting...", segments: [], name: "media", file: null });
    void downloadWorker(id, url, mode);
    return res.json({ id });
  }

  let uploadPath: string | null = null;
  let name = "subtitle";
  if (upl) {
    const original = Buffer.from(upl.originalname, "latin1").toString("utf8"); // multer đọc tên file là latin1
    const work = path.join(WORK_DIR, id);
    fs.mkdirSync(work, { recursive: true });
    name = path.parse(original).name || "subtitle";
    uploadPath = path.join(work, "upload" + (path.extname(original) || ".bin"));
    fs.renameSync(upl.path, uploadPath);
  }
  jobs.set(id, { status: "queued", progress: 0, message: "Waiting...", segments: [], name, audio: uploadPath, url });
  void subtitleWorker(id, LANGS[langName], uploadPath, start ?? 0, end);
  res.json({ id });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Not found." });
  res.json({
    status: job.status, progress: job.progress, message: job.message, segments: job.segments,
    name: job.name, url: job.url ?? "", has_audio: Boolean(job.audio),
  });
});

app.put("/api/jobs/:id/segments/:idx", (req, res) => {
  const job = jobs.get(req.params.id);
  const idx = Number(req.params.idx);
  const text = String(req.body?.text ?? "").trim();
  if (!job || !["running", "done"].includes(job.status) || !Number.isInteger(idx) || idx < 0 || idx >= job.segments.length || !text) {
    return res.status(400).json({ error: "Could not edit." });
  }
  job.segments[idx].text = text;
  const metaPath = path.join(LIBRARY_DIR, req.params.id, "meta.json");
  if (fs.existsSync(metaPath)) { // bài đã lưu: ghi luôn chỉnh sửa vào thư viện
    const meta: Meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    meta.segments = job.segments;
    fs.writeFileSync(metaPath, JSON.stringify(meta));
  }
  res.json({ ok: true });
});

app.get("/api/jobs/:id/file", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== "done" || !job.file) return res.status(404).json({ error: "File not ready." });
  res.download(job.file, `${job.name}${path.extname(job.file)}`);
});

app.get("/api/jobs/:id/audio", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job?.audio) return res.status(404).json({ error: "No audio file." });
  res.sendFile(path.resolve(job.audio)); // hỗ trợ Range để tua
});

app.get("/api/jobs/:id/result", (req, res) => {
  const job = jobs.get(req.params.id);
  const fmt = String(req.query.fmt ?? "srt");
  if (!job || job.status !== "done" || !isFormat(fmt)) return res.status(404).json({ error: "Result not ready." });
  if (req.query.download) {
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(job.name)}.${fmt}`);
  }
  res.type("text/plain; charset=utf-8").send(formatSegments(job.segments, fmt));
});

const libDir = (id: string): string | null => {
  if (!/^[A-Za-z0-9]+$/.test(id)) return null;
  const d = path.join(LIBRARY_DIR, id);
  return fs.existsSync(path.join(d, "meta.json")) ? d : null;
};
const readMeta = (d: string): Meta => JSON.parse(fs.readFileSync(path.join(d, "meta.json"), "utf8"));

app.post("/api/jobs/:id/save", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== "done" || !job.segments.length || !/^[A-Za-z0-9]+$/.test(req.params.id)) {
    return res.status(400).json({ error: "No result to save yet." });
  }
  const d = path.join(LIBRARY_DIR, req.params.id);
  fs.mkdirSync(d, { recursive: true });
  let audioName: string | null = null;
  if (job.audio && fs.existsSync(job.audio)) {
    audioName = "audio" + path.extname(job.audio);
    if (path.resolve(job.audio) !== path.resolve(d, audioName)) fs.copyFileSync(job.audio, path.join(d, audioName));
  }
  const meta: Meta = { name: job.name, url: job.url ?? "", audio: audioName, saved: Date.now() / 1000, segments: job.segments };
  fs.writeFileSync(path.join(d, "meta.json"), JSON.stringify(meta));
  res.json({ ok: true });
});

app.get("/api/library", (_req, res) => {
  const items = fs.readdirSync(LIBRARY_DIR)
    .filter((id) => libDir(id))
    .map((id) => {
      const m = readMeta(path.join(LIBRARY_DIR, id));
      return { id, name: m.name, saved: m.saved, count: m.segments.length };
    })
    .sort((a, b) => b.saved - a.saved);
  res.json(items);
});

app.post("/api/library/:id/load", (req, res) => {
  const d = libDir(req.params.id);
  if (!d) return res.status(404).json({ error: "Not found." });
  const m = readMeta(d);
  jobs.set(req.params.id, {
    status: "done", progress: 1, message: `Opened — ${m.segments.length} subtitle lines.`,
    segments: m.segments, name: m.name, url: m.url, audio: m.audio ? path.join(d, m.audio) : null,
  });
  res.json({ id: req.params.id, url: m.url, name: m.name });
});

app.patch("/api/library/:id", (req, res) => {
  const d = libDir(req.params.id);
  if (!d) return res.status(404).json({ error: "Not found." });
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name) return res.status(400).json({ error: "Name cannot be empty." });
  const m = readMeta(d);
  m.name = name;
  fs.writeFileSync(path.join(d, "meta.json"), JSON.stringify(m));
  const job = jobs.get(req.params.id);
  if (job) job.name = name;
  res.json({ ok: true, name });
});

app.delete("/api/library/:id", (req, res) => {
  const d = libDir(req.params.id);
  if (!d) return res.status(404).json({ error: "Not found." });
  fs.rmSync(d, { recursive: true, force: true });
  res.json({ ok: true });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "File too large (max 2 GB)." });
  }
  res.status(500).json({ error: errMsg(err) });
});

if (BASE_PATH !== "/") {
  // Link tương đối (api/jobs...) chỉ đúng khi URL kết thúc bằng "/".
  server.get(BASE_PATH, (req, res, next) => {
    if (req.path.endsWith("/")) return next();
    res.redirect(301, `${BASE_PATH}/${req.url.slice(req.path.length)}`);
  });
}
server.use(BASE_PATH, app);

const PORT = Number(process.env.PORT) || 5000;
server.listen(PORT, "127.0.0.1", () => console.log(`http://127.0.0.1:${PORT}${BASE_PATH === "/" ? "" : BASE_PATH + "/"}`));
