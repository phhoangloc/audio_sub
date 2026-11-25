import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Segment } from "./config.js";

const ffmpegPath: string | null = createRequire(import.meta.url)("ffmpeg-static");
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-transcribe";
const CHUNK = 600; // giây: cắt âm thanh thành từng đoạn 10 phút để gửi inline và có tiến độ
const SENTENCE_END = /[.!?。！？…]["')\]]?$/; // dấu kết câu: gặp thì mới ngắt dòng
const CJK = /[぀-ヿ㐀-鿿가-힯]/;
const FIX_CLAUDE = /\b(?:cloud|clawed?|clod|claud|claude)([\s-]*)code\b/gi; // hay nghe nhầm / viết thường "Claude Code"

interface Callbacks {
  onStatus: (m: string) => void;
  onProgress: (f: number) => void;
  onSegment: (s: Segment) => void;
}

/** Giải mã [start, start+dur) của file thành mp3 16 kHz mono (nhỏ, đủ cho nhận dạng giọng nói). */
function decode(file: string, out: string, start: number, dur: number | null): Promise<void> {
  if (!ffmpegPath) return Promise.reject(new Error("ffmpeg not found."));
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  if (start) args.push("-ss", String(start));
  if (dur) args.push("-t", String(dur));
  args.push("-i", file, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", out);
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg error: ${err.trim().slice(-300)}`))));
  });
}

/** Độ dài (giây) của file, đọc từ dòng "Duration" ffmpeg in ra. */
function duration(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error("ffmpeg not found."));
    const p = spawn(ffmpegPath, ["-hide_banner", "-i", file]);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", () => {
      const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
      m ? resolve(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) : reject(new Error("Could not read the file duration."));
    });
  });
}

interface Word { start: number; end: number; text: string }

const sec = (v: unknown) => parseFloat(String(v)); // "1.600s" -> 1.6

/** "MM:SS.s" hoặc "HH:MM:SS.s" -> giây. */
function parseStamp(s: unknown): number {
  const parts = String(s).trim().split(":").map(Number);
  return !parts.length || parts.some(Number.isNaN) ? NaN : parts.reduce((acc, v) => acc * 60 + v, 0);
}

const HOTWORDS = "Claude Code, Claude, Anthropic";
const LANG_NAMES: Record<string, string> = {
  vi: "Vietnamese", en: "English", ja: "Japanese", ko: "Korean",
  zh: "Chinese", fr: "French", de: "German", es: "Spanish",
};

/** Các key trong .env: GEMINI_API_KEY, GEMINI_API_KEY_2, GEMINI_API_KEY_3... (hoặc nhiều key cách nhau bằng dấu phẩy). */
function apiKeys(): string[] {
  const keys = [process.env.GEMINI_API_KEY, ...Object.keys(process.env).filter((k) => /^GEMINI_API_KEY_\d+$/.test(k)).sort().map((k) => process.env[k])]
    .flatMap((v) => (v ?? "").split(","))
    .map((k) => k.trim())
    .filter(Boolean);
  return [...new Set(keys)];
}
let keyIdx = 0; // key đang dùng; giữ nguyên giữa các lần gọi cho tới khi key đó hết quota

/** Gửi một đoạn mp3 cho Gemini, nhận lại danh sách từ kèm mốc thời gian (tính từ đầu đoạn). */
async function askGemini(mp3: string, lang: string | null): Promise<Word[]> {
  const keys = apiKeys();
  if (!keys.length) throw new Error("Missing GEMINI_API_KEY. Add your key to the .env file (get one at https://aistudio.google.com/apikey).");
  const audio = { inline_data: { mime_type: "audio/mp3", data: fs.readFileSync(mp3).toString("base64") } };
  // gemini-*-transcribe là model ASR thuần: không nhận prompt, không có JSON mode; mốc từng từ bật qua audioTranscriptionConfig.
  // Các model còn lại (gemini-3.8-flash...) là LLM: nhờ prompt + JSON schema trả về từng câu kèm mốc thời gian.
  const asr = /transcribe/.test(MODEL);
  const language = lang ? (LANG_NAMES[lang] ?? lang) : null;
  const prompt =
    `Transcribe this audio verbatim${language ? ` in ${language}` : " in the language spoken"}. ` +
    `Split it into subtitle lines, one complete sentence per line, each ending with a period (or ? / ! where appropriate). ` +
    `Never break a line in the middle of a sentence. ` +
    `For every line give start and end timestamps in MM:SS.s format (minutes, seconds, one decimal) relative to the beginning of this audio, as precise as possible. ` +
    `Do not translate, summarize, or describe sounds. Skip music and silence. Proper nouns that may appear: ${HOTWORDS}.`;
  const body = asr
    ? {
        contents: [{ parts: [audio] }],
        generationConfig: { audioTranscriptionConfig: { wordTimestamp: true, languageCodes: lang ? [lang] : [] } },
      }
    : {
        contents: [{ parts: [audio, { text: prompt }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: { start: { type: "STRING" }, end: { type: "STRING" }, text: { type: "STRING" } },
              required: ["start", "end", "text"],
            },
          },
        },
      };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    // hết quota (429) hoặc key bị từ chối (403) thì đổi sang key kế tiếp ngay, không chờ
    let res!: Response;
    for (let tried = 0; tried < keys.length; tried++) {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": keys[keyIdx % keys.length] },
        body: JSON.stringify(body),
      });
      if (res.status !== 429 && res.status !== 403) break;
      if (tried < keys.length - 1) keyIdx++;
    }
    if (res.ok) {
      const data: any = await res.json();
      const parts: any[] = data?.candidates?.[0]?.content?.parts ?? [];
      const words: Word[] = [];
      if (asr) {
        for (const p of parts) {
          for (const w of p?.audioTranscription?.words ?? []) {
            const text = String(w.word ?? "").trim(), start = sec(w.startOffset), end = sec(w.endOffset);
            if (text && !Number.isNaN(start) && !Number.isNaN(end)) words.push({ start, end: Math.max(start, end), text });
          }
        }
      } else {
        const json = parts.map((p) => p.text ?? "").join("");
        let rows: any = [];
        try { rows = json ? JSON.parse(json) : []; } catch { throw new Error("Gemini returned unreadable data. Try again."); }
        for (const r of Array.isArray(rows) ? rows : []) {
          const text = String(r?.text ?? "").trim(), start = parseStamp(r?.start), end = parseStamp(r?.end);
          // mỗi câu coi như một "từ" lớn: vòng ngắt dòng bên dưới vẫn gộp/ngắt theo dấu kết câu
          if (text && !Number.isNaN(start) && !Number.isNaN(end)) words.push({ start, end: Math.max(start, end), text });
        }
      }
      // đoạn không có tiếng nói thì không có từ nào; chỉ coi là lỗi khi model báo dừng bất thường
      const reason = data?.candidates?.[0]?.finishReason ?? data?.promptFeedback?.blockReason;
      if (!words.length && reason && reason !== "STOP") throw new Error(`Gemini returned no result (${reason}).`);
      return words;
    }
    lastErr = `Gemini error ${res.status}: ${(await res.text()).slice(0, 300)}`;
    if (res.status !== 429 && res.status < 500) break; // lỗi do request/key thì thử lại cũng vô ích
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  throw new Error(lastErr);
}

export async function transcribe(
  file: string, lang: string | null, cb: Callbacks, start = 0, end: number | null = null,
): Promise<Segment[]> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audio_sub_"));
  try {
    cb.onStatus("Reading the audio file...");
    const total = end !== null ? end - start : (await duration(file)) - start;
    const segments: Segment[] = [];
    const chunks = Math.max(1, Math.ceil(total / CHUNK));
    let line: Segment | null = null; // câu đang gom dở (có thể kéo qua ranh giới giữa hai đoạn)
    const flush = () => {
      if (!line) return;
      line.text = line.text.replace(FIX_CLAUDE, "Claude$1Code");
      segments.push(line);
      cb.onSegment(line);
      line = null;
    };
    for (let i = 0; i < chunks; i++) {
      const offset = start + i * CHUNK;
      const len = Math.min(CHUNK, start + total - offset);
      const mp3 = path.join(tmp, `part${i}.mp3`);
      await decode(file, mp3, offset, len);
      cb.onStatus(chunks > 1 ? `Transcribing with Gemini (${i + 1}/${chunks})...` : "Transcribing with Gemini...");
      for (const w of await askGemini(mp3, lang)) {
        const ws = offset + Math.min(w.start, len), we = offset + Math.min(w.end, len);
        if (!line) line = { start: ws, end: we, text: w.text };
        else {
          line.text += (CJK.test(line.text.slice(-1)) || CJK.test(w.text[0]) ? "" : " ") + w.text;
          line.end = we;
        }
        if (SENTENCE_END.test(w.text)) flush(); // chỉ ngắt dòng sau dấu kết câu
      }
      cb.onProgress((i + 1) / chunks);
    }
    flush();
    return segments;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
