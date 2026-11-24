"""
DormSleep 共享密码学核心（Windows 本地伴随服务）
--------------------------------------------
严格使用标准密码学原语（secrets CSPRNG, HMAC-SHA256, SHA-256, RFC 4226 截断），
与前端 shared/crypto.js 以及 Android 端 DormSleepCrypto.kt 保持 100% 字节级一致。
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from typing import Optional

PAIR_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
REQ_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


def generate_pair_code() -> str:
    return "".join(secrets.choice(PAIR_ALPHABET) for _ in range(8))


def generate_shared_secret() -> str:
    return secrets.token_hex(32)  # 256-bit random hex key


def generate_pair_id() -> str:
    return f"pair_{secrets.token_hex(6)}"


def generate_online_six_digit_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def canonical_emergency_payload(
    pair_id: str,
    session_id: str,
    request_id: str,
    action_type: str,
    target_app_id: Optional[str],
) -> str:
    target = "ALL" if action_type == "END_TONIGHT" else (target_app_id or "ALL")
    return f"{pair_id}|{session_id}|{request_id.strip().upper()}|{action_type}|{target}"


def derive_offline_emergency_code(
    shared_secret: str,
    pair_id: str,
    session_id: str,
    request_id: str,
    action_type: str,
    target_app_id: Optional[str],
) -> str:
    """标准 HMAC-SHA256 + RFC 4226 Dynamic Truncation（6 位数字）。"""
    msg = canonical_emergency_payload(pair_id, session_id, request_id, action_type, target_app_id)
    digest = hmac.new(
        shared_secret.encode("utf-8"),
        msg.encode("utf-8"),
        hashlib.sha256,
    ).digest()
    offset = digest[-1] & 0x0F
    binary = (
        ((digest[offset] & 0x7F) << 24)
        | ((digest[offset + 1] & 0xFF) << 16)
        | ((digest[offset + 2] & 0xFF) << 8)
        | (digest[offset + 3] & 0xFF)
    )
    return f"{binary % 1_000_000:06d}"


def hash_online_code(salt: str, code: str, payload: str) -> str:
    return hashlib.sha256(f"{salt}|{code.strip()}|{payload}".encode("utf-8")).hexdigest()


def sign_lan_request(
    shared_secret: str,
    pair_id: str,
    timestamp_ms: int,
    nonce: str,
    method: str,
    path: str,
    body_bytes: bytes,
) -> str:
    """局域网设备间请求 HMAC-SHA256 签名，防同网段伪造请求。"""
    body_sha = hashlib.sha256(body_bytes).hexdigest()
    signing_str = f"{pair_id}|{timestamp_ms}|{nonce}|{method.upper()}|{path}|{body_sha}"
    return hmac.new(
        shared_secret.encode("utf-8"),
        signing_str.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def verify_lan_signature(
    shared_secret: str,
    pair_id: str,
    timestamp_ms: int,
    nonce: str,
    method: str,
    path: str,
    body_bytes: bytes,
    provided_sig: str,
    now_ms: int,
    max_skew_ms: int = 5 * 60 * 1000,
) -> bool:
    if not provided_sig or abs(now_ms - timestamp_ms) > max_skew_ms:
        return False
    expected = sign_lan_request(shared_secret, pair_id, timestamp_ms, nonce, method, path, body_bytes)
    return hmac.compare_digest(expected, provided_sig.strip().lower())
