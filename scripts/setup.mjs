// Tải whisper.cpp (bản CPU cho Windows) và model large-v3-turbo vào dự án. Chạy: npm run setup
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "whisper", "Release", "whisper-cli.exe");
const model = path.join(root, "models", "ggml-large-v3-turbo-q5_0.bin");

async function download(url, dest) {
  console.log(`Đang tải ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Tải thất bại (${res.status}): ${url}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}

if (!fs.existsSync(cli)) {
  const zip = path.join(root, "bin", "whisper.zip");
  await download("https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip", zip);
  fs.mkdirSync(path.join(root, "bin", "whisper"), { recursive: true });
  execFileSync("powershell", ["-NoProfile", "-Command",
    `Expand-Archive -LiteralPath "${zip}" -DestinationPath "${path.join(root, "bin", "whisper")}" -Force`]);
  fs.rmSync(zip);
}
if (!fs.existsSync(model)) {
  await download("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin", model);
}
console.log("Xong.");
