"""Offline protocol checks with synthetic recognizers; never read private audio."""
import importlib.util
import io
import json
import pathlib
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("local_whisper", pathlib.Path(__file__).parents[1] / "src/transcription/local-whisper.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class LocalWhisperTests(unittest.TestCase):
    def run_helper(self, behavior, action="serve"):
        calls = []

        class Model:
            def __init__(self, path, **kwargs):
                self.device = kwargs["device"]
                calls.append(self.device)
                self.assert_local = kwargs["local_files_only"]
                if behavior == "load_failure" and self.device == "cuda":
                    raise RuntimeError("private model path must not be printed")

            def transcribe(self, audio, **kwargs):
                if behavior == "inference_failure" and self.device == "cuda":
                    def broken():
                        raise RuntimeError("missing CUDA DLL")
                        yield
                    return broken(), None
                return iter([types.SimpleNamespace(text=" fala sintética ")]), None

        modules = {
            "faster_whisper": types.SimpleNamespace(WhisperModel=Model),
            "ctranslate2": types.SimpleNamespace(get_cuda_device_count=lambda: 1,
                get_supported_compute_types=lambda device: {"int8", "int8_float16"}),
            "av": types.SimpleNamespace(__version__="16.0.1"),
        }
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            for name in ("model.bin", "config.json", "tokenizer.json", "audio.wav"):
                (root / name).write_bytes(b"synthetic")
            audio = str(root / "audio.wav")
            stdin = io.StringIO(json.dumps({"audio": audio}) + "\n" + json.dumps({"audio": audio}) + "\n")
            output = io.StringIO()
            with patch.dict(sys.modules, modules), patch.object(sys, "argv", ["helper", action, "--model-path", directory]), \
                 patch.object(sys, "stdin", stdin), patch.object(sys, "stdout", output):
                code = helper.main()
            return code, [json.loads(line) for line in output.getvalue().splitlines()], calls

    def test_server_reuses_gpu_model_for_two_requests(self):
        code, replies, calls = self.run_helper("ok")
        self.assertEqual(code, 0)
        self.assertEqual(replies, [{"available": True, "device": "cuda"},
                                  {"text": "fala sintética"}, {"text": "fala sintética"}])
        self.assertEqual(calls, ["cuda"])

    def test_missing_gpu_dependencies_fall_back_to_local_cpu(self):
        code, replies, calls = self.run_helper("load_failure")
        self.assertEqual(code, 0)
        self.assertEqual(replies[0]["device"], "cpu")
        self.assertEqual(calls, ["cuda", "cpu"])
        self.assertTrue(all(reply.get("text") == "fala sintética" for reply in replies[1:]))

    def test_lazy_gpu_inference_failure_is_retried_on_cpu_once(self):
        code, replies, calls = self.run_helper("inference_failure")
        self.assertEqual(code, 0)
        self.assertEqual(calls, ["cuda", "cpu"])
        self.assertEqual(replies[1:], [{"text": "fala sintética"}, {"text": "fala sintética"}])

    def test_probe_does_not_load_model(self):
        code, replies, calls = self.run_helper("ok", "probe")
        self.assertEqual(code, 0)
        self.assertTrue(replies[0]["available"])
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
