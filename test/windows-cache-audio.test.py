import base64
import contextlib
import hashlib
import importlib.util
import io
import pathlib
import sqlite3
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch


sys.dont_write_bytecode = True
module_path = pathlib.Path(__file__).resolve().parents[1] / "scripts/windows-cache-audio.py"
spec = importlib.util.spec_from_file_location("windows_cache_audio", module_path)
cache_audio = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache_audio)


class CacheAudioTests(unittest.TestCase):
    def test_recovery_saves_only_matching_payload_and_discards_vendor_output(self):
        encrypted = b"synthetic encrypted audio and mac"
        digest = hashlib.sha256(encrypted).hexdigest()

        class FakeCache:
            def __init__(self, path):
                print("private vendor diagnostic")

            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

            def keys(self):
                return ["private matching cache key", "unrelated cache key"]

            def get_cachefile(self, key):
                return [encrypted if key.startswith("private") else b"unrelated payload"]

        fake_reader = types.ModuleType("ccl_chromium_reader.ccl_chromium_cache")
        fake_reader.guess_cache_class = lambda path: FakeCache
        fake_package = types.ModuleType("ccl_chromium_reader")
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            source = root / "unified.db"
            cache_path = root / "cache"
            cache_path.mkdir()
            with contextlib.closing(sqlite3.connect(source)) as db:
                db.execute("CREATE TABLE messages(timestamp INTEGER,msg_type TEXT,media_filehash TEXT,media_enc_filehash TEXT)")
                db.execute("INSERT INTO messages VALUES(?,?,?,?)", (int(time.time()), "ptt", None, digest))
                db.commit()
            output = io.StringIO()
            with patch.dict(sys.modules, {"ccl_chromium_reader": fake_package,
                                          "ccl_chromium_reader.ccl_chromium_cache": fake_reader}), contextlib.redirect_stdout(output):
                result = cache_audio.recover_cache_audio(source, cache_path, root)
            self.assertEqual(output.getvalue(), "")
            self.assertEqual(result["encrypted_saved"], 1)
            self.assertEqual(result["plain_saved"], 0)
            self.assertEqual((root / ".whatmcp-encrypted" / digest).read_bytes(), encrypted)
            self.assertFalse((root / ".whatmcp-plain").exists())
            self.assertEqual(cache_audio.expected_audio_hashes(source)[3], True)

    def test_hash_encodings_and_invalid_lengths(self):
        digest = hashlib.sha256(b"expected audio").digest()
        self.assertEqual(cache_audio.normalize_hash(digest.hex().upper()), digest.hex())
        self.assertEqual(cache_audio.normalize_hash(base64.b64encode(digest).decode()), digest.hex())
        self.assertEqual(cache_audio.normalize_hash(base64.urlsafe_b64encode(digest).decode().rstrip("=")), digest.hex())
        self.assertIsNone(cache_audio.normalize_hash("not a hash"))
        self.assertIsNone(cache_audio.normalize_hash(b"short"))

    def test_exact_hash_required_and_existing_file_verified(self):
        payload = b"OggS synthetic audio"
        digest = hashlib.sha256(payload).hexdigest()
        with tempfile.TemporaryDirectory() as temporary:
            destination = pathlib.Path(temporary) / ".whatmcp-plain"
            self.assertIsNone(cache_audio.preserve_matching_payload(b"unrelated", {digest: True}, destination))
            self.assertFalse(destination.exists())
            self.assertEqual(cache_audio.preserve_matching_payload(payload, {digest: True}, destination), ("saved", digest))
            self.assertEqual((destination / digest).read_bytes(), payload)
            self.assertEqual(cache_audio.preserve_matching_payload(payload, {digest: True}, destination), ("reused", digest))
            (destination / digest).write_bytes(b"damaged")
            self.assertEqual(cache_audio.preserve_matching_payload(payload, {digest: True}, destination), ("saved", digest))
            self.assertEqual((destination / digest).read_bytes(), payload)
            self.assertEqual([path.name for path in destination.iterdir()], [digest])

    def test_selection_recent_audio_only_and_limit(self):
        now = 1800000000
        digest = hashlib.sha256(b"audio").hexdigest()
        with tempfile.TemporaryDirectory() as temporary:
            source = pathlib.Path(temporary) / "unified.db"
            with contextlib.closing(sqlite3.connect(source)) as db:
                db.execute("CREATE TABLE messages(timestamp INTEGER,msg_type TEXT,media_filehash TEXT,media_enc_filehash TEXT)")
                db.executemany("INSERT INTO messages VALUES(?,?,?,?)", [
                    (now - 1, "ptt", digest, digest),
                    ((now - 2) * 1000, "audio", digest, digest),
                    (now - 3, "video", digest, digest),
                    (now - 8 * 86400, "ptt", digest, digest),
                ])
                db.commit()
            plain, encrypted, count, available = cache_audio.expected_audio_hashes(source, 7, 200, now)
            self.assertTrue(available)
            self.assertEqual(count, 2)
            self.assertEqual(set(plain), {digest})
            self.assertEqual(set(encrypted), {digest})
            self.assertEqual(cache_audio.expected_audio_hashes(source, 7, 1, now)[2], 1)


if __name__ == "__main__":
    unittest.main()
