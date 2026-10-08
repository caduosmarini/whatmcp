"""Recover recent audio cache payloads by exact WhatsApp content hash only.

The live cache is opened read-only with Windows sharing enabled. No URLs,
credentials, message bodies, or encryption keys are written or logged.
"""
import argparse
import base64
import contextlib
import ctypes
import hashlib
import io
import json
import pathlib
import re
import sqlite3
import sys
import tempfile
import time


def normalize_hash(value):
    if isinstance(value, (bytes, bytearray)):
        return bytes(value).hex() if len(value) == 32 else None
    if not isinstance(value, str):
        return None
    value = value.strip()
    if re.fullmatch(r"[0-9a-fA-F]{64}", value):
        return value.lower()
    try:
        raw = base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)
        return raw.hex() if len(raw) == 32 else None
    except (ValueError, TypeError):
        return None


def expected_audio_hashes(source, days=7, limit=200, now=None):
    cutoff = int((time.time() if now is None else now) - days * 86400)
    with contextlib.closing(sqlite3.connect(pathlib.Path(source).resolve().as_uri() + "?mode=ro", uri=True)) as db:
        columns = {row[1] for row in db.execute("PRAGMA table_info(messages)")}
        required = {"timestamp", "msg_type", "media_filehash", "media_enc_filehash"}
        if not required.issubset(columns):
            return {}, {}, 0, False
        rows = db.execute("""SELECT media_filehash, media_enc_filehash FROM messages
            WHERE msg_type IN ('audio','ptt') AND
              (CASE WHEN timestamp > 100000000000 THEN timestamp / 1000 ELSE timestamp END) >= ?
            ORDER BY (CASE WHEN timestamp > 100000000000 THEN timestamp / 1000 ELSE timestamp END) DESC
            LIMIT ?""", (cutoff, limit)).fetchall()
    plain, encrypted = {}, {}
    for filehash, enc_filehash in rows:
        if digest := normalize_hash(filehash):
            plain[digest] = True
        if digest := normalize_hash(enc_filehash):
            encrypted[digest] = True
    return plain, encrypted, len(rows), True


@contextlib.contextmanager
def shared_cache_reads(cache_path):
    """Adapt the vendor's Path.open to Win32 read sharing without copying the cache."""
    if sys.platform != "win32":
        yield
        return
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                 wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.ReadFile.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD,
                               ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID]
    kernel.ReadFile.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    original = pathlib.Path.open
    cache_root = pathlib.Path(cache_path).resolve()

    def open_shared(path, mode="r", *args, **kwargs):
        if mode != "rb" or not path.resolve().is_relative_to(cache_root):
            return original(path, mode, *args, **kwargs)
        handle = kernel.CreateFileW(str(path), 0x80000000, 7, None, 3, 0x80, None)
        if handle == ctypes.c_void_p(-1).value:
            raise OSError(ctypes.get_last_error(), "shared cache open failed")
        data = io.BytesIO()
        try:
            buffer = ctypes.create_string_buffer(1024 * 1024)
            count = wintypes.DWORD()
            while True:
                if not kernel.ReadFile(handle, buffer, len(buffer), ctypes.byref(count), None):
                    raise OSError(ctypes.get_last_error(), "shared cache read failed")
                if count.value == 0:
                    break
                data.write(buffer.raw[:count.value])
        finally:
            kernel.CloseHandle(handle)
        data.seek(0)
        return data

    pathlib.Path.open = open_shared
    try:
        yield
    finally:
        pathlib.Path.open = original


def preserve_matching_payload(payload, expected, folder):
    """Return saved/reused only for a nonempty payload matching an expected SHA-256."""
    if not payload:
        return None
    digest = hashlib.sha256(payload).hexdigest()
    if digest not in expected:
        return None
    target = pathlib.Path(folder) / digest
    if target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest() == digest:
        return "reused", digest
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = None
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent, prefix=".cache-", delete=False) as writer:
            temp = pathlib.Path(writer.name)
            writer.write(payload)
        temp.replace(target)
    finally:
        if temp is not None:
            temp.unlink(missing_ok=True)
    return "saved", digest


def recover_cache_audio(source, cache_path, vendor, days=7, limit=200):
    summary = {"messages_considered": 0, "plain_hashes_expected": 0,
               "encrypted_hashes_expected": 0, "entries_scanned": 0,
               "plain_saved": 0, "plain_reused": 0,
               "encrypted_saved": 0, "encrypted_reused": 0,
               "entry_errors": 0, "metadata_available": False}
    plain, encrypted, messages, available = expected_audio_hashes(source, days, limit)
    summary.update(messages_considered=messages, plain_hashes_expected=len(plain),
                   encrypted_hashes_expected=len(encrypted), metadata_available=available)
    if not plain and not encrypted:
        return summary
    if not pathlib.Path(cache_path).is_dir():
        summary["cache_unavailable"] = True
        return summary
    sys.path.insert(0, str(pathlib.Path(vendor).resolve()))
    from ccl_chromium_reader.ccl_chromium_cache import guess_cache_class
    destination = pathlib.Path(source).resolve().parent
    seen_plain, seen_encrypted = set(), set()
    # Vendor diagnostics may contain raw cache keys; discard them entirely.
    with shared_cache_reads(cache_path), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        cache_class = guess_cache_class(cache_path)
        if cache_class is None:
            summary["cache_unavailable"] = True
            return summary
        with cache_class(cache_path) as cache:
            for key in cache.keys():
                try:
                    for payload in cache.get_cachefile(key):
                        summary["entries_scanned"] += 1
                        for kind, expected, seen in (("plain", plain, seen_plain),
                                                     ("encrypted", encrypted, seen_encrypted)):
                            match = preserve_matching_payload(payload, expected, destination / (".whatmcp-" + kind))
                            if match and match[1] not in seen:
                                summary[kind + "_" + match[0]] += 1
                                seen.add(match[1])
                except Exception:
                    summary["entry_errors"] += 1
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--cache", required=True)
    parser.add_argument("--vendor", required=True)
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--limit", type=int, default=200)
    args = parser.parse_args()
    if args.days < 1 or args.limit < 1:
        parser.error("days and limit must be positive")
    try:
        result = recover_cache_audio(args.source, args.cache, args.vendor, args.days, args.limit)
    except Exception as error:
        # Do not print exception messages: vendor failures can include cache keys.
        print(json.dumps({"error_type": type(error).__name__}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
