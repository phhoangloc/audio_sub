import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);

export function isYoutubeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return ["http:", "https:"].includes(u.protocol) && YOUTUBE_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

// yt-dlp: ưu tiên YT_DLP trong môi trường, rồi lệnh yt-dlp, cuối cùng là `python -m yt_dlp`.
const LAUNCHERS: string[][] = [
  ...(process.env.YT_DLP ? [[process.env.YT_DLP]] : []),
  ["yt-dlp"], ["python", "-m", "yt_dlp"], ["py", "-m", "yt_dlp"],
];

function run(args: string[], onLine: (l: string) => void, i = 0): Promise<void> {
  const [cmd, ...pre] = LAUNCHERS[i];
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, [...pre, ...args]);
    let err = "", buf = "", missing = false, started = false;
    p.stdout.on("data", (d) => {
      started = true;
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      lines.forEach(onLine);
    });
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e: NodeJS.ErrnoException) => {
      missing = e.code === "ENOENT";
      if (missing && i + 1 < LAUNCHERS.length) run(args, onLine, i + 1).then(resolve, reject);
      else reject(e.code === "ENOENT" ? new Error("Không tìm thấy yt-dlp (cài bằng: pip install yt-dlp).") : e);
    });
    p.on("close", (code) => {
      if (missing) return; // không có lệnh này: đã chuyển sang launcher kế (hoặc đã báo lỗi)
      if (code === 0) return resolve();
      // Crash khi khởi động (vd. 0xC0000142 thiếu DLL, không in gì): thử launcher kế tiếp.
      if (!started && !err.trim() && i + 1 < LAUNCHERS.length) return run(args, onLine, i + 1).then(resolve, reject);
      reject(new Error(err.trim().split("\n").pop() || `yt-dlp thoát với mã ${code}`));
    });
  });
}

/** Tải âm thanh (m4a/webm) hoặc video mp4 một file. Trả về [đường dẫn file, tiêu đề]. */
export async function downloadMedia(
  url: string, outDir: string, kind: "audio" | "video", onProgress: (frac: number, msg: string) => void,
): Promise<[string, string]> {
  const label = kind === "video" ? "video" : "âm thanh";
  const args = [
    "-f", kind === "video" ? "best[ext=mp4]/best" : "bestaudio[ext=m4a]/bestaudio",
    "-o", path.join(outDir, `${kind}.%(ext)s`),
    "--no-playlist", "--no-warnings", "--no-simulate", "--progress", "--newline",
    "--progress-template", "download:PROG %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s",
    "--print", "TITLE:%(title)s",
    // YouTube cần giải challenge JS: bật cả deno và node.
    "--js-runtimes", "deno", "--js-runtimes", "node", "--remote-components", "ejs:github",
  ];
  // Cookies: cookies.txt cạnh server, hoặc YTDLP_COOKIES_BROWSER=firefox|edge|chrome.
  const cookieFile = path.join(ROOT, "cookies.txt");
  if (fs.existsSync(cookieFile)) args.push("--cookies", cookieFile);
  else if (process.env.YTDLP_COOKIES_BROWSER) args.push("--cookies-from-browser", process.env.YTDLP_COOKIES_BROWSER);
  args.push(url);

  let title = "";
  await run(args, (line) => {
    if (line.startsWith("TITLE:")) title = line.slice(6);
    const m = /^(?:download:)?PROG (\d+)\s+(\d+|NA)\s+(\d+|NA)/.exec(line);
    if (m) {
      const total = Number(m[2]) || Number(m[3]);
      if (total) {
        const frac = Math.min(Number(m[1]) / total, 1);
        onProgress(frac, `Đang tải ${label} từ YouTube... ${Math.round(frac * 100)}%`);
      }
    }
  });
  const files = fs.readdirSync(outDir).filter((f) => f.startsWith(`${kind}.`) && !/\.(part|ytdl)$/.test(f));
  if (!files.length) throw new Error(`Không tải được ${label} từ link này.`);
  return [path.join(outDir, files[0]), title || "subtitle"];
}
