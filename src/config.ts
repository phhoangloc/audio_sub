import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// .env: KEY=value mỗi dòng, ví dụ PORT=4000
const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const i = line.indexOf("=");
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (i > 0 && !key.startsWith("#") && value) process.env[key] ??= value;
  }
}

export const LANGS: Record<string, string | null> = {
  "Tự động": null, "Tiếng Việt": "vi", English: "en", 日本語: "ja",
  한국어: "ko", 中文: "zh", Français: "fr", Deutsch: "de", Español: "es",
};
export const FORMATS = ["srt", "vtt", "txt"] as const;
export type Format = (typeof FORMATS)[number];

export interface Segment { start: number; end: number; text: string }
