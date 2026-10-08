"""Offline-only faster-whisper probe, transcription, and persistent worker."""
import argparse
import contextlib
import gc
import io
import json
import os
import pathlib
import sys


class LocalRecognizer:
    def __init__(self, model_path):
        self.model_path = model_path
        self.model = None
        self.device = "cpu"
        self.dll_handles = []
        if os.name == "nt":
            directories = [pathlib.Path(sys.prefix) / "Lib" / "site-packages" / "nvidia" / package / "bin"
                           for package in ("cublas", "cudnn")]
            existing = [str(path) for path in directories if path.is_dir()]
            os.environ["PATH"] = os.pathsep.join(existing + [os.environ.get("PATH", "")])
            for directory in existing:
                self.dll_handles.append(os.add_dll_directory(directory))
        from faster_whisper import WhisperModel
        import ctranslate2
        import av
        if int(av.__version__.split(".")[0]) >= 19:
            raise ValueError("PyAV version incompatible; install pinned local requirements")
        for filename in ("model.bin", "config.json", "tokenizer.json"):
            file_path = model_path / filename
            if not file_path.is_file() or file_path.stat().st_size == 0:
                raise ValueError("cached model incomplete")
        if "int8" not in ctranslate2.get_supported_compute_types("cpu"):
            raise ValueError("CPU int8 unavailable")
        self.model_class = WhisperModel
        try:
            if ctranslate2.get_cuda_device_count() and "int8_float16" in ctranslate2.get_supported_compute_types("cuda"):
                self.device = "cuda"
        except Exception:
            pass

    def load(self):
        try:
            self.model = self.model_class(str(self.model_path.resolve()), device=self.device,
                                         compute_type="int8_float16" if self.device == "cuda" else "int8",
                                         cpu_threads=max(1, min(4, os.cpu_count() or 1)),
                                         local_files_only=True)
        except Exception:
            if self.device != "cuda":
                raise
            self.device = "cpu"
            self.load()

    def transcribe(self, audio, language):
        if not audio or not pathlib.Path(audio).is_file():
            raise ValueError("audio missing")
        if self.model is None:
            self.load()
        try:
            segments, _ = self.model.transcribe(audio, language=language, beam_size=5,
                                                vad_filter=True, condition_on_previous_text=False)
            return " ".join(segment.text.strip() for segment in segments).strip()
        except Exception:
            if self.device != "cuda":
                raise
            # Missing DLLs or insufficient VRAM fall back to offline CPU processing.
            self.model = None
            gc.collect()
            self.device = "cpu"
            self.load()
            return self.transcribe(audio, language)


def failure(error):
    # Avoid printing paths or audio contents in error traces.
    return {"available": False, "reason": "local Whisper unavailable", "error_type": type(error).__name__}


def emit(result):
    print(json.dumps(result, ensure_ascii=False), flush=True)


def main():
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["probe", "transcribe", "serve"])
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--audio")
    parser.add_argument("--language", default="pt")
    args = parser.parse_args()
    model_path = pathlib.Path(args.model_path)
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            recognizer = LocalRecognizer(model_path)
            if args.action == "probe":
                result = {"available": True, "reason": "cached local Whisper model and offline runtime ready"}
            elif args.action == "serve":
                recognizer.load()
                result = {"available": True, "device": recognizer.device}
            else:
                result = {"text": recognizer.transcribe(args.audio, args.language)}
    except Exception as error:
        emit(failure(error))
        return 0 if args.action == "probe" else 1
    emit(result)
    if args.action == "serve":
        for line in sys.stdin:
            try:
                request = json.loads(line)
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    result = {"text": recognizer.transcribe(request.get("audio"), args.language)}
            except Exception as error:
                result = failure(error)
            emit(result)
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
