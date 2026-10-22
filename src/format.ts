import type { Format, Segment } from "./config.js";

function ts(t: number, sep: string): string {
  let ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3_600_000); ms %= 3_600_000;
  const m = Math.floor(ms / 60_000); ms %= 60_000;
  const s = Math.floor(ms / 1000); ms %= 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(ms, 3)}`;
}

export function formatSegments(segments: Segment[], fmt: Format): string {
  if (fmt === "txt") return segments.map((s) => s.text).join("\n") + "\n";
  const sep = fmt === "srt" ? "," : ".";
  const out: string[] = fmt === "vtt" ? ["WEBVTT\n"] : [];
  segments.forEach((s, i) => {
    if (fmt === "srt") out.push(String(i + 1));
    out.push(`${ts(s.start, sep)} --> ${ts(s.end, sep)}`, s.text, "");
  });
  return out.join("\n");
}

/** '90', '1:30' hoặc '1:02:03' -> giây; rỗng -> null; sai định dạng -> ném lỗi. */
export function parseTime(value: unknown): number | null {
  const v = String(value ?? "").trim();
  if (!v) return null;
  const parts = v.split(":").map(Number);
  if (parts.length > 3 || parts.some((p) => !Number.isFinite(p) || p < 0)) throw new Error(v);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}
