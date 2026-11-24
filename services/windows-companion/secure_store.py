"""
Windows DPAPI 本地安全密钥存储（含非 Windows 开发环境受限权限回退）
----------------------------------------------------------------
在 Windows 上通过 ctypes 直接调用系统 crypt32.dll 的 CryptProtectData /
CryptUnprotectData，将配对 sharedSecret 绑定到当前 Windows 登录用户加密落盘。
在 Linux/WSL 开发测试环境清晰标明回退为 0600 权限文件，绝不伪装成真实 DPAPI。
"""

from __future__ import annotations

import base64
import ctypes
import json
import os
import sys
from pathlib import Path
from typing import Optional

IS_WINDOWS = sys.platform == "win32"

if IS_WINDOWS:
    from ctypes import wintypes

    class DATA_BLOB(ctypes.Structure):
        _fields_ = [
            ("cbData", wintypes.DWORD),
            ("pbData", ctypes.POINTER(ctypes.c_char)),
        ]

    _crypt32 = ctypes.windll.crypt32
    _kernel32 = ctypes.windll.kernel32

    def _dpapi_protect(plaintext: bytes) -> bytes:
        buf = ctypes.create_string_buffer(plaintext, len(plaintext))
        blob_in = DATA_BLOB(len(plaintext), buf)
        blob_out = DATA_BLOB()
        ok = _crypt32.CryptProtectData(
            ctypes.byref(blob_in),
            "DormSleepSharedSecret",
            None,
            None,
            None,
            0x01,  # CRYPTPROTECT_UI_FORBIDDEN
            ctypes.byref(blob_out),
        )
        if not ok:
            raise OSError("Windows DPAPI CryptProtectData failed")
        try:
            return ctypes.string_at(blob_out.pbData, blob_out.cbData)
        finally:
            _kernel32.LocalFree(blob_out.pbData)

    def _dpapi_unprotect(ciphertext: bytes) -> bytes:
        buf = ctypes.create_string_buffer(ciphertext, len(ciphertext))
        blob_in = DATA_BLOB(len(ciphertext), buf)
        blob_out = DATA_BLOB()
        ok = _crypt32.CryptUnprotectData(
            ctypes.byref(blob_in),
            None,
            None,
            None,
            None,
            0x01,
            ctypes.byref(blob_out),
        )
        if not ok:
            raise OSError("Windows DPAPI CryptUnprotectData failed")
        try:
            return ctypes.string_at(blob_out.pbData, blob_out.cbData)
        finally:
            _kernel32.LocalFree(blob_out.pbData)


class LocalSecretStore:
    def __init__(self, file_path: Path):
        self.file_path = file_path
        self.backend = "WINDOWS_DPAPI" if IS_WINDOWS else "POSIX_DEV_FALLBACK"

    def save_secret(self, pair_id: str, shared_secret: str) -> None:
        self.file_path.parent.mkdir(parents=True, exist_ok=True)
        raw = shared_secret.encode("utf-8")
        if IS_WINDOWS:
            blob = _dpapi_protect(raw)
        else:
            blob = raw

        payload = {
            "backend": self.backend,
            "pairId": pair_id,
            "blobB64": base64.b64encode(blob).decode("ascii"),
        }
        tmp = self.file_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, self.file_path)

    def load_secret(self, expected_pair_id: Optional[str] = None) -> Optional[str]:
        if not self.file_path.is_file():
            return None
        try:
            payload = json.loads(self.file_path.read_text(encoding="utf-8"))
        except Exception:
            return None
        if expected_pair_id and payload.get("pairId") != expected_pair_id:
            return None
        blob = base64.b64decode(payload["blobB64"])
        if payload.get("backend") == "WINDOWS_DPAPI":
            if not IS_WINDOWS:
                raise RuntimeError("DPAPI 加密密钥仅可在原 Windows 宿主机解密")
            return _dpapi_unprotect(blob).decode("utf-8")
        return blob.decode("utf-8")

    def clear_secret(self) -> None:
        if self.file_path.exists():
            self.file_path.unlink()
