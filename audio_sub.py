"""Audio -> subtitle (SRT/VTT/TXT) using faster-whisper.

GUI:  python audio_sub.py
CLI:  python audio_sub.py input.mp3 [-m small] [-l vi] [-f srt|vtt|txt]
"""
import argparse
import os
import queue
import threading
from pathlib import Path

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")


def _preload_vc_runtime():
    """Nạp VC++ runtime mới (thư mục vc_runtime) trước ctranslate2/onnxruntime.

    MSVCP140.dll cũ trong System32 (14.13) làm crash access violation trên một số máy Windows.
    """
    if os.name != "nt":
        return
    import ctypes
    d = Path(__file__).parent / "vc_runtime"
    for name in ("vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll"):
        p = d / name
        if p.is_file():
            try:
                ctypes.WinDLL(str(p))
            except OSError:
                pass


_preload_vc_runtime()

MODELS = ["tiny", "base", "small", "medium", "large-v3"]
LANGS = {"Tự động": None, "Tiếng Việt": "vi", "English": "en", "日本語": "ja",
         "한국어": "ko", "中文": "zh", "Français": "fr", "Deutsch": "de", "Español": "es"}
FORMATS = ["srt", "vtt", "txt"]
AUDIO_TYPES = [("Audio/Video", "*.mp3 *.wav *.m4a *.flac *.ogg *.aac *.wma *.mp4 *.mkv *.webm *.mov"),
               ("Tất cả", "*.*")]


def _ts(t: float, sep: str) -> str:
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{s:02}{sep}{ms:03}"


def format_segments(segments, fmt: str) -> str:
    if fmt == "txt":
        return "\n".join(s["text"] for s in segments) + "\n"
    sep = "," if fmt == "srt" else "."
    out = ["WEBVTT\n"] if fmt == "vtt" else []
    for i, s in enumerate(segments, 1):
        if fmt == "srt":
            out.append(str(i))
        out.append(f"{_ts(s['start'], sep)} --> {_ts(s['end'], sep)}")
        out.append(s["text"])
        out.append("")
    return "\n".join(out)


def transcribe(path, model_name, language, on_status=print, on_progress=lambda f: None):
    from faster_whisper import WhisperModel

    on_status(f"Đang tải model '{model_name}' (lần đầu sẽ tải về, có thể mất vài phút)...")
    model = WhisperModel(model_name, device="auto", compute_type="auto")
    on_status("Đang nhận dạng giọng nói...")
    gen, info = model.transcribe(str(path), language=language, vad_filter=True)
    on_status(f"Ngôn ngữ: {info.language} ({info.language_probability:.0%}) — thời lượng {info.duration:.0f}s")
    segments = []
    for seg in gen:
        segments.append({"start": seg.start, "end": seg.end, "text": seg.text.strip()})
        if info.duration:
            on_progress(min(seg.end / info.duration, 1.0))
    on_progress(1.0)
    return segments


def run_cli(args):
    segs = transcribe(args.input, args.model, args.lang,
                      on_progress=lambda f: print(f"\r{f:.0%}", end="", flush=True))
    out = Path(args.output) if args.output else Path(args.input).with_suffix("." + args.format)
    out.write_text(format_segments(segs, args.format), encoding="utf-8")
    print(f"\nĐã lưu: {out}")


def run_gui():
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk

    root = tk.Tk()
    root.title("Audio → Subtitle")
    root.geometry("760x560")
    q = queue.Queue()
    state = {"segments": [], "file": None}

    file_var = tk.StringVar()
    model_var = tk.StringVar(value="small")
    lang_var = tk.StringVar(value="Tự động")
    fmt_var = tk.StringVar(value="srt")
    status_var = tk.StringVar(value="Chọn file âm thanh để bắt đầu.")

    top = ttk.Frame(root, padding=10)
    top.pack(fill="x")
    ttk.Entry(top, textvariable=file_var).grid(row=0, column=0, sticky="ew", padx=(0, 6))
    ttk.Button(top, text="Chọn file...", command=lambda: browse()).grid(row=0, column=1)
    top.columnconfigure(0, weight=1)

    opts = ttk.Frame(root, padding=(10, 0))
    opts.pack(fill="x")
    for i, (label, var, values) in enumerate([
            ("Model", model_var, MODELS), ("Ngôn ngữ", lang_var, list(LANGS)), ("Định dạng", fmt_var, FORMATS)]):
        ttk.Label(opts, text=label).grid(row=0, column=i * 2, padx=(0, 4))
        ttk.Combobox(opts, textvariable=var, values=values, state="readonly", width=12).grid(
            row=0, column=i * 2 + 1, padx=(0, 14))

    btns = ttk.Frame(root, padding=10)
    btns.pack(fill="x")
    start_btn = ttk.Button(btns, text="Bắt đầu tạo subtitle", command=lambda: start())
    start_btn.pack(side="left")
    save_btn = ttk.Button(btns, text="Lưu...", state="disabled", command=lambda: save())
    save_btn.pack(side="left", padx=6)

    bar = ttk.Progressbar(root, maximum=1.0)
    bar.pack(fill="x", padx=10)
    ttk.Label(root, textvariable=status_var).pack(anchor="w", padx=10, pady=4)

    text = tk.Text(root, wrap="word")
    text.pack(fill="both", expand=True, padx=10, pady=(0, 10))

    def browse():
        p = filedialog.askopenfilename(filetypes=AUDIO_TYPES)
        if p:
            file_var.set(p)

    def render():
        text.delete("1.0", "end")
        text.insert("1.0", format_segments(state["segments"], fmt_var.get()))

    fmt_var.trace_add("write", lambda *_: state["segments"] and render())

    def start():
        p = file_var.get().strip()
        if not p or not Path(p).is_file():
            messagebox.showerror("Lỗi", "Hãy chọn một file âm thanh hợp lệ.")
            return
        state["file"] = p
        start_btn.config(state="disabled")
        save_btn.config(state="disabled")
        bar["value"] = 0
        text.delete("1.0", "end")

        def work():
            try:
                segs = transcribe(p, model_var.get(), LANGS[lang_var.get()],
                                  on_status=lambda m: q.put(("status", m)),
                                  on_progress=lambda f: q.put(("progress", f)))
                q.put(("done", segs))
            except Exception as e:  # noqa: BLE001
                q.put(("error", str(e)))

        threading.Thread(target=work, daemon=True).start()

    def save():
        fmt = fmt_var.get()
        default = Path(state["file"]).with_suffix("." + fmt).name
        p = filedialog.asksaveasfilename(initialfile=default, defaultextension="." + fmt,
                                         initialdir=str(Path(state["file"]).parent))
        if p:
            Path(p).write_text(format_segments(state["segments"], fmt), encoding="utf-8")
            status_var.set(f"Đã lưu: {p}")

    def poll():
        try:
            while True:
                kind, val = q.get_nowait()
                if kind == "status":
                    status_var.set(val)
                elif kind == "progress":
                    bar["value"] = val
                elif kind == "done":
                    state["segments"] = val
                    render()
                    status_var.set(f"Xong — {len(val)} dòng subtitle.")
                    start_btn.config(state="normal")
                    save_btn.config(state="normal")
                elif kind == "error":
                    status_var.set("Lỗi.")
                    start_btn.config(state="normal")
                    messagebox.showerror("Lỗi", val)
        except queue.Empty:
            pass
        root.after(100, poll)

    poll()
    root.mainloop()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Tạo subtitle từ file âm thanh")
    ap.add_argument("input", nargs="?", help="file âm thanh (bỏ trống để mở GUI)")
    ap.add_argument("-m", "--model", default="small", choices=MODELS)
    ap.add_argument("-l", "--lang", default=None, help="mã ngôn ngữ, vd vi, en (mặc định: tự nhận diện)")
    ap.add_argument("-f", "--format", default="srt", choices=FORMATS)
    ap.add_argument("-o", "--output")
    a = ap.parse_args()
    run_cli(a) if a.input else run_gui()
