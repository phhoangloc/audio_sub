import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, type Segment } from "./config.js";

const ffmpegPath: string | null = createRequire(import.meta.url)("ffmpeg-static");
const WHISPER_CLI = path.join(ROOT, "bin", "whisper", "Release", "whisper-cli.exe");
const MODEL = path.join(ROOT, "models", "ggml-large-v3-turbo-q5_0.bin");
const HOTWORDS = "Claude Code, Claude, Anthropic";
const PAUSE_BREAK = 0.5; // giây: người nói nghỉ từ mức này trở lên thì ngắt dòng
const CJK = /[぀-ヿ㐀-鿿가-힯]/;
const SENTENCE_END = /[.,!?;。、，．！？…]$/; // dấu kết thúc một dòng subtitle
const FIXES: [RegExp, string][] = [[/\b(?:cloud|clawed?|clod|claud)([\s-]*)code\b/gi, "Claude$1Code"]];

interface Callbacks {
  onStatus: (m: string) => void;
  onProgress: (f: number) => void;
  onSegment: (s: Segment) => void;
}

interface Word { start: number; end: number; text: string }

/** Giải mã [start, end) của file thành wav 16 kHz mono. */
function decode(file: string, out: string, start: number, end: number | null): Promise<void> {
  if (!ffmpegPath) return Promise.reject(new Error("Không tìm thấy ffmpeg."));
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  if (start) args.push("-ss", String(start));
  if (end) args.push("-t", String(end - start));
  args.push("-i", file, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out);
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg lỗi: ${err.trim().slice(-300)}`))));
  });
}

/**
 * whisper.cpp kéo dài mốc cuối của từ đứng trước chỗ nghỉ (có khi cả mấy giây) nên khoảng trống giữa hai từ
 * không phản ánh chỗ nghỉ. Ước lượng thời điểm từ thực sự dứt tiếng theo độ dài chữ, phần dư tính là nghỉ.
 */
const speechEnd = (w: Word) => Math.min(w.end, w.start + 0.15 + 0.1 * w.text.replace(/[^\p{L}\p{N}]/gu, "").length);

export async function transcribe(
  file: string, lang: string | null, cb: Callbacks, start = 0, end: number | null = null,
): Promise<Segment[]> {
  for (const f of [WHISPER_CLI, MODEL]) {
    if (!fs.existsSync(f)) throw new Error(`Thiếu ${path.relative(ROOT, f)}. Chạy: npm run setup`);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audio_sub_"));
  try {
    cb.onStatus("Đang đọc file âm thanh...");
    const wav = path.join(tmp, "audio.wav");
    await decode(file, wav, start, end);

    const segments: Segment[] = [];
    let line: Segment | null = null; // dòng đang gom dở
    let prev: Word | null = null;
    const flush = () => {
      if (!line) return;
      segments.push(line);
      cb.onSegment(line);
      line = null;
    };
    const addWord = (w: Word) => {
      let text = w.text;
      if (line && prev && (SENTENCE_END.test(prev.text) || w.start - speechEnd(prev) >= PAUSE_BREAK)) {
        line.end = Math.max(line.start, Math.min(prev.end, speechEnd(prev)));
        flush();
      }
      if (!line) line = { start: w.start, end: w.end, text: "" };
      line.text += (line.text && !CJK.test(line.text.slice(-1)) && !CJK.test(text[0]) ? " " : "") + text;
      line.end = w.end;
      prev = w;
    };

    cb.onStatus("Đang nhận dạng giọng nói...");
    const args = [
      "-m", MODEL, "-f", wav, "-l", lang ?? "auto", "-t", String(Math.min(8, os.cpus().length)),
      "-ml", "1", "-sow", // mỗi dòng kết quả là một từ kèm mốc thời gian
      "-mc", "0", // không dùng ngữ cảnh câu trước: lỗi lặp chữ không lan sang đoạn sau
      "-nth", "0.6", "-pp", "--prompt", HOTWORDS,
    ];
    await new Promise<void>((resolve, reject) => {
      const p = spawn(WHISPER_CLI, args, { cwd: path.dirname(WHISPER_CLI) });
      let buf = "", err = "";
      const lineRe = /^\[(\d+):(\d+):(\d+\.\d+) --> (\d+):(\d+):(\d+\.\d+)\]\s*(.*)$/;
      const sec = (h: string, m: string, s: string) => Number(h) * 3600 + Number(m) * 60 + Number(s);
      const handle = (l: string) => {
        const m = lineRe.exec(l.trim());
        if (!m) return;
        let text = m[7].trim();
        if (!text || /^[[(].*[\])]$/.test(text)) return; // [BLANK_AUDIO], (music)...
        for (const [pat, rep] of FIXES) text = text.replace(pat, rep);
        addWord({ start: start + sec(m[1], m[2], m[3]), end: start + sec(m[4], m[5], m[6]), text });
      };
      p.stdout.setEncoding("utf8");
      p.stdout.on("data", (d: string) => {
        buf += d;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? "";
        lines.forEach(handle);
      });
      p.stderr.setEncoding("utf8");
      p.stderr.on("data", (d: string) => {
        err = (err + d).slice(-2000);
        const m = [...d.matchAll(/progress =\s*(\d+)%/g)].pop();
        if (m) cb.onProgress(Number(m[1]) / 100);
      });
      p.on("error", reject);
      p.on("close", (code) => {
        if (buf) handle(buf);
        if (code === 0) resolve();
        else reject(new Error(`whisper.cpp lỗi (mã ${code}): ${err.trim().split(/\r?\n/).pop() ?? ""}`));
      });
    });
    flush();
    cb.onProgress(1);
    return segments;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
