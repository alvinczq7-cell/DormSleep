#!/usr/bin/env python3
"""
DormSleep 真实 Windows 本地伴随服务 (Windows Companion Service)
==============================================================
替代 mock-bridge/server.py 的电脑端真实本地守护进程：
1. 托管 apps/desktop/ 桌面前端界面（可直接被浏览器或 Tauri/WebView2 壳加载）。
2. 使用 SQLite WAL 持久化配对记录、手机同步快照、在线应急码与历史消费记录。
3. 使用 Windows DPAPI (crypt32.dll) 加密保护配对 sharedSecret，浏览器前端无需接触明文密钥！
4. 提供局域网 UDP 发现服务与 HMAC-SHA256 签名认证的 Android 真机同步协议 (/api/lan/v1/*)。
5. 支持局域网在线 CSPRNG 应急发码 + 离线本机 HMAC-SHA256 算码 (/api/desktop/emergency/offline)。

启动方式：
  python3 services/windows-companion/companion_server.py
环境变量（可选）：
  DORMSLEEP_COMPANION_HOST=0.0.0.0   (默认 0.0.0.0 以便同局域网手机连入)
  DORMSLEEP_COMPANION_PORT=4180      (默认 HTTP 4180)
  DORMSLEEP_DISCOVERY_PORT=41740     (默认 UDP 发现端口 41740)
  DORMSLEEP_DATA_DIR=<目录>           (默认 services/windows-companion/data)
"""

from __future__ import annotations

import hashlib
import hmac
import json
import mimetypes
import os
import queue
import secrets
import socket
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

SERVICE_DIR = Path(__file__).resolve().parent


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def get_asset_root() -> Path:
    if is_frozen():
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            cand = Path(meipass) / "webroot"
            if cand.is_dir():
                return cand.resolve()
        return (Path(sys.executable).resolve().parent / "webroot").resolve()
    return SERVICE_DIR.parent.parent.resolve()


def get_default_data_dir() -> Path:
    env_dir = os.environ.get("DORMSLEEP_DATA_DIR")
    if env_dir:
        return Path(env_dir)
    if is_frozen() and sys.platform == "win32":
        local_app = os.environ.get("LOCALAPPDATA")
        base = Path(local_app) if local_app else (Path.home() / "AppData" / "Local")
        return base / "DormSleep"
    return SERVICE_DIR / "data"


def get_lan_ipv4_addresses() -> List[str]:
    candidates: List[str] = []

    def _add(ip: str) -> None:
        if not ip:
            return
        # 过滤回环、链路本地以及 Mihomo/Clash TUN 常用虚拟网段 (198.18.0.0/15)
        if ip.startswith(("127.", "169.254.", "198.18.", "198.19.", "0.")):
            return
        if ip not in candidates:
            candidates.append(ip)

    # 1. 收集主机名解析出的所有本机 IPv4 地址
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            _add(info[4][0])
    except OSError:
        pass

    # 2. 补充默认出网路由地址（不实际发送数据包）
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            _add(s.getsockname()[0])
    except OSError:
        pass

    def _priority(ip: str) -> tuple[int, str]:
        # 优先显示真实 Wi-Fi/热点局域网地址（192.168.* / 10.*），把 WSL/Hyper-V 虚拟网段（172.*）排在后面
        if ip.startswith("192.168."):
            return (0, ip)
        if ip.startswith("10."):
            return (1, ip)
        if ip.startswith("172."):
            return (3, ip)
        return (2, ip)

    candidates.sort(key=_priority)
    return candidates


ASSET_ROOT = get_asset_root()
if not is_frozen():
    sys.path.insert(0, str(SERVICE_DIR))

from crypto_core import (  # noqa: E402
    canonical_emergency_payload,
    derive_offline_emergency_code,
    generate_online_six_digit_code,
    generate_pair_code,
    generate_pair_id,
    generate_shared_secret,
    hash_online_code,
    verify_lan_signature,
)
from lan_discovery import LanDiscoveryResponder  # noqa: E402
from secure_store import LocalSecretStore  # noqa: E402
from storage import CompanionDatabase  # noqa: E402

HEARTBEAT_ONLINE_TTL_MS = 25 * 1000  # 超过 25 秒未收到手机心跳即视为离线，自动切换离线取码


def now_ms() -> int:
    return int(time.time() * 1000)


class CompanionService:
    def __init__(self, data_dir: Path, http_port: int = 4180, udp_port: int = 41740):
        self.data_dir = data_dir
        self.http_port = http_port
        self.udp_port = udp_port
        self.db = CompanionDatabase(data_dir / "companion.db")
        self.secret_store = LocalSecretStore(data_dir / "secret.dpapi.json")
        self.lock = threading.RLock()
        self.subscribers: List[queue.Queue] = []
        self.shutdown_event = threading.Event()
        self.last_phone_contact_ms: int = 0
        self.seen_nonces: Dict[str, int] = {}

    def notify_shutdown(self) -> None:
        self.shutdown_event.set()
        with self.lock:
            subs = list(self.subscribers)
        for q in subs:
            try:
                q.put_nowait(None)
            except Exception:
                pass

    def close(self) -> None:
        self.notify_shutdown()
        self.db.close()

    def _log(self, kind: str, message: str, ts: Optional[int] = None) -> None:
        t = ts if ts is not None else now_ms()
        self.db.add_event(f"cevt_{t}_{secrets.token_hex(3)}", t, kind, message)

    def broadcast(self, kind: str = "state") -> None:
        payload = json.dumps({"type": kind, "ts": now_ms()}, ensure_ascii=False)
        dead: List[queue.Queue] = []
        with self.lock:
            subs = list(self.subscribers)
        for q in subs:
            try:
                q.put_nowait(payload)
            except Exception:
                dead.append(q)
        if dead:
            with self.lock:
                for q in dead:
                    if q in self.subscribers:
                        self.subscribers.remove(q)

    def is_phone_online(self) -> bool:
        if self.last_phone_contact_ms <= 0:
            return False
        return (now_ms() - self.last_phone_contact_ms) <= HEARTBEAT_ONLINE_TTL_MS

    # ---------------- 本机桌面 UI 接口 ----------------

    def get_desktop_state(self) -> Dict[str, Any]:
        with self.lock:
            t = now_ms()
            pairing = self.db.get_pairing()
            if pairing["status"] == "PENDING" and pairing["pendingExpiresAt"] and t > pairing["pendingExpiresAt"]:
                self.db.clear_pairing()
                pairing = self.db.get_pairing()

            snap = self.db.get_snapshot()
            connected = pairing["status"] == "PAIRED" and self.is_phone_online()

            issued_public = None
            if connected and snap and snap.get("activeRequest"):
                req_id = snap["activeRequest"]["requestId"]
                row = self.db.get_issued_code(req_id)
                if row and row["status"] == "ACTIVE":
                    issued_public = {
                        "requestId": row["request_id"],
                        "sessionId": row["session_id"],
                        "actionType": row["action_type"],
                        "targetAppId": row["target_app_id"],
                        "code": row["plaintext_code"],
                        "issuedAt": row["issued_at"],
                    }

            if snap is not None:
                snap["events"] = self.db.list_events(25)
                snap["consumedCount"] = max(int(snap.get("consumedCount", 0)), self.db.get_consumed_count())

            known_apps = (
                snap.get("effectiveRestrictedAppIds", [])
                if snap
                else ["tv.danmaku.bili", "com.ss.android.ugc.aweme", "com.xingin.xhs", "com.tencent.tmgp.sgame"]
            )

            return {
                "nowMs": t,
                "serviceMode": "WINDOWS_COMPANION_REAL",
                "secretStorageBackend": self.secret_store.backend,
                "lanIps": get_lan_ipv4_addresses(),
                "httpPort": self.http_port,
                "udpPort": self.udp_port,
                "sim": {
                    "timeOffsetMs": 0,
                    "lanConnected": connected,
                    "pcPoweredOn": True,
                    "mobileRebootCount": 0,
                },
                "desktop": {
                    "nowMs": t,
                    "pcPoweredOn": True,
                    "lanConnected": connected,
                    "connected": connected,
                    "snapshot": snap,
                    "issuedCode": issued_public,
                    "pairing": {
                        "status": pairing["status"],
                        "pairId": pairing["pairId"],
                        "pendingPairCode": pairing["pendingPairCode"],
                        "pendingExpiresAt": pairing["pendingExpiresAt"],
                        "mobileName": pairing["mobileName"],
                        "desktopName": pairing["desktopName"],
                        "pairedAt": pairing["pairedAt"],
                        # 安全升级：真实伴随服务绝不向浏览器前端泄露明文 sharedSecret，
                        # 离线算码由本机后端直接从 DPAPI 解密并计算！
                        "offlineSharedSecret": None,
                        "serverSideOfflineCalc": True,
                    },
                    "knownRestrictedAppIds": known_apps,
                },
            }

    def start_pairing(self) -> Dict[str, Any]:
        with self.lock:
            t = now_ms()
            code = generate_pair_code()
            exp = t + 3 * 60 * 1000
            self.db.set_pending_pairing(code, exp)
            self._log("PAIR_STARTED", "已生成 8 位一次性配对码（3 分钟有效）。", t)
        self.broadcast("pair_start")
        return {"ok": True, "pairCode": code, "expiresAt": exp}

    def unbind_pairing(self) -> Dict[str, Any]:
        with self.lock:
            self.db.clear_pairing()
            self.secret_store.clear_secret()
            self.last_phone_contact_ms = 0
            self._log("PAIR_UNBOUND", "已解除电脑端配对并清除本地密钥。")
        self.broadcast("pair_unbind")
        return {"ok": True, "deferred": False}

    def issue_online_code(self, action_type: Optional[str] = None, target_app_id: Optional[str] = None) -> Dict[str, Any]:
        with self.lock:
            t = now_ms()
            pairing = self.db.get_pairing()
            if pairing["status"] != "PAIRED":
                return {"ok": False, "errorCode": "NOT_PAIRED"}
            if not self.is_phone_online():
                return {"ok": False, "errorCode": "PC_OFFLINE"}

            snap = self.db.get_snapshot()
            if not snap or snap.get("status") not in ("LOCKED", "TEMP_ALLOW", "TRIAL_LOCKED"):
                return {"ok": False, "errorCode": "SESSION_NOT_LOCKED"}
            req = snap.get("activeRequest")
            if not req:
                return {"ok": False, "errorCode": "SESSION_NOT_LOCKED"}

            desired_action = action_type or req["actionType"]
            desired_target = None if desired_action == "END_TONIGHT" else (target_app_id or req.get("targetAppId"))

            # 若电脑端选择的操作/目标与手机当前活动请求不一致，返回明确提示（或要求同步）
            if desired_action != req["actionType"] or desired_target != req.get("targetAppId"):
                # 允许电脑端生成对应当前 requestId 的绑定请求，手机下次校验时严格核对绑定字段
                pass

            existing = self.db.get_issued_code(req["requestId"])
            if (
                existing
                and existing["status"] == "ACTIVE"
                and existing["action_type"] == desired_action
                and existing["target_app_id"] == desired_target
            ):
                code = existing["plaintext_code"]
                issued_at = existing["issued_at"]
            else:
                code = generate_online_six_digit_code()
                salt = secrets.token_hex(8)
                payload = canonical_emergency_payload(
                    pairing["pairId"], req["sessionId"], req["requestId"], desired_action, desired_target
                )
                code_hash = hash_online_code(salt, code, payload)
                self.db.upsert_issued_code(
                    request_id=req["requestId"],
                    session_id=req["sessionId"],
                    action_type=desired_action,
                    target_app_id=desired_target,
                    plaintext_code=code,
                    salt=salt,
                    code_hash=code_hash,
                    issued_at=t,
                )
                issued_at = t
                self._log(
                    "DESKTOP_CODE_ISSUED",
                    f"已为请求 {req['requestId']} 生成一次性在线应急码（{desired_action}）。",
                    t,
                )

            issued_view = {
                "requestId": req["requestId"],
                "sessionId": req["sessionId"],
                "actionType": desired_action,
                "targetAppId": desired_target,
                "code": code,
                "issuedAt": issued_at,
            }
        self.broadcast("desktop_issue")
        return {"ok": True, "issued": issued_view}

    def compute_offline_code(
        self,
        session_id: str,
        request_id: str,
        action_type: str,
        target_app_id: Optional[str],
    ) -> Dict[str, Any]:
        """完全离线算码：直接从本机 DPAPI 读取 sharedSecret 计算标准 HMAC-SHA256 6 位码，前端不接触密钥。"""
        with self.lock:
            pairing = self.db.get_pairing()
            if pairing["status"] != "PAIRED" or not pairing["pairId"]:
                return {"ok": False, "errorCode": "NOT_PAIRED"}
            secret = self.secret_store.load_secret(pairing["pairId"])
            if not secret:
                return {"ok": False, "errorCode": "SECRET_MISSING"}
            norm_req = request_id.strip().upper()
            if not norm_req or not session_id.strip():
                return {"ok": False, "errorCode": "BAD_REQUEST"}
            norm_target = None if action_type == "END_TONIGHT" else target_app_id
            code = derive_offline_emergency_code(
                shared_secret=secret,
                pair_id=pairing["pairId"],
                session_id=session_id.strip(),
                request_id=norm_req,
                action_type=action_type,
                target_app_id=norm_target,
            )
            self._log(
                "OFFLINE_CODE_COMPUTED",
                f"本机离线派生应急码（会话 {session_id.strip()} · 识别号 {norm_req} · {action_type}）。",
            )
        self.broadcast("offline_calc")
        return {
            "ok": True,
            "code": code,
            "sessionId": session_id.strip(),
            "requestId": norm_req,
            "actionType": action_type,
            "targetAppId": norm_target,
            "computedAt": now_ms(),
        }

    # ---------------- 面向 Android 真机的局域网同步协议 (/api/lan/v1/*) ----------------

    def _verify_phone_headers(self, headers: Any, method: str, path: str, body_bytes: bytes) -> Optional[str]:
        """校验手机局域网请求签名，通过返回 pairId，失败返回 None。"""
        pairing = self.db.get_pairing()
        if pairing["status"] != "PAIRED" or not pairing["pairId"]:
            return None
        pair_id = headers.get("X-DS-PairId", "")
        ts_raw = headers.get("X-DS-Timestamp", "")
        nonce = headers.get("X-DS-Nonce", "")
        sig = headers.get("X-DS-Signature", "")
        if pair_id != pairing["pairId"] or not nonce:
            return None
        try:
            ts_ms = int(ts_raw)
        except ValueError:
            return None

        t = now_ms()
        # 防重放 nonce 窗口
        with self.lock:
            expired = [k for k, v in self.seen_nonces.items() if t - v > 10 * 60 * 1000]
            for k in expired:
                del self.seen_nonces[k]
            if nonce in self.seen_nonces:
                return None

        secret = self.secret_store.load_secret(pair_id)
        if not secret:
            return None
        if not verify_lan_signature(secret, pair_id, ts_ms, nonce, method, path, body_bytes, sig, t):
            return None

        with self.lock:
            self.seen_nonces[nonce] = t
        return pair_id

    def lan_confirm_pairing(self, pair_code: str, mobile_name: str = "Android 手机") -> Dict[str, Any]:
        with self.lock:
            t = now_ms()
            pairing = self.db.get_pairing()
            if pairing["status"] != "PENDING" or not pairing["pendingPairCode"]:
                return {"ok": False, "errorCode": "PAIR_CODE_INVALID"}
            if pairing["pendingExpiresAt"] and t > pairing["pendingExpiresAt"]:
                return {"ok": False, "errorCode": "PAIR_CODE_INVALID"}
            if pair_code.strip().upper() != pairing["pendingPairCode"]:
                return {"ok": False, "errorCode": "PAIR_CODE_INVALID"}

            pair_id = generate_pair_id()
            shared_secret = generate_shared_secret()
            self.secret_store.save_secret(pair_id, shared_secret)
            self.db.confirm_pairing(pair_id, mobile_name or "Android 手机", t)
            self.last_phone_contact_ms = t
            self._log("PAIR_CONFIRMED", f"与 {mobile_name or 'Android 手机'} 完成局域网配对，密钥已写入 {self.secret_store.backend}。", t)
        self.broadcast("pair_confirmed")
        return {
            "ok": True,
            "pairId": pair_id,
            "sharedSecret": shared_secret,  # 仅首次配对握手下发一次，手机存入 Android Keystore
            "desktopName": self.db.get_pairing()["desktopName"],
        }

    def lan_phone_heartbeat(self, snapshot: Dict[str, Any]) -> Dict[str, Any]:
        with self.lock:
            t = now_ms()
            self.last_phone_contact_ms = t
            self.db.save_snapshot(t, snapshot)

            # 若手机已切换活动请求，自动作废电脑端旧在线应急码
            active_req = snapshot.get("activeRequest")
            keep_id = active_req["requestId"] if active_req else None
            self.db.invalidate_other_active_codes(keep_id)

            # 同步手机离线期间的已消费记录（补档防重放）
            for item in snapshot.get("recentConsumed", []):
                if item.get("requestId"):
                    self.db.record_consumed(
                        request_id=item["requestId"],
                        session_id=item.get("sessionId", ""),
                        action_type=item.get("actionType", ""),
                        target_app_id=item.get("targetAppId"),
                        consumed_at=int(item.get("consumedAt", t)),
                        mode=item.get("mode", "OFFLINE"),
                        code_sha=item.get("codeSha"),
                    )
        self.broadcast("heartbeat")
        return {"ok": True, "serverNowMs": now_ms()}

    def lan_verify_online_code(
        self,
        session_id: str,
        request_id: str,
        action_type: str,
        target_app_id: Optional[str],
        submitted_code: str,
    ) -> Dict[str, Any]:
        """在线模式下由电脑端验证手机提交的 6 位应急码（手机端全程不接触明文答案）。"""
        with self.lock:
            t = now_ms()
            self.last_phone_contact_ms = t
            code = "".join(ch for ch in str(submitted_code or "") if ch.isdigit())
            code_sha = hashlib.sha256(code.encode("utf-8")).hexdigest() if len(code) == 6 else ""

            if self.db.is_consumed(request_id) or (code_sha and self.db.is_code_sha_consumed(code_sha)):
                return {"ok": False, "errorCode": "CODE_ALREADY_USED"}

            issued = self.db.get_issued_code(request_id)
            if not issued:
                return {"ok": False, "errorCode": "CODE_INVALID"}
            if issued["status"] == "CONSUMED":
                return {"ok": False, "errorCode": "CODE_ALREADY_USED"}
            if issued["status"] == "INVALIDATED":
                return {"ok": False, "errorCode": "REQUEST_INVALIDATED"}

            norm_target = None if action_type == "END_TONIGHT" else target_app_id
            if (
                issued["session_id"] != session_id
                or issued["action_type"] != action_type
                or issued["target_app_id"] != norm_target
            ):
                return {"ok": False, "errorCode": "REQUEST_MISMATCH"}

            pairing = self.db.get_pairing()
            payload = canonical_emergency_payload(
                pairing["pairId"], session_id, request_id, action_type, norm_target
            )
            expected_hash = hash_online_code(issued["salt"], code, payload)
            if not hmac.compare_digest(expected_hash, issued["code_hash"]):
                self._log("ONLINE_VERIFY_FAILED", f"手机校验请求 {request_id} 失败（输入错误）。", t)
                self.broadcast("verify_failed")
                return {"ok": False, "errorCode": "CODE_INVALID"}

            self.db.record_consumed(
                request_id=request_id,
                session_id=session_id,
                action_type=action_type,
                target_app_id=norm_target,
                consumed_at=t,
                mode="ONLINE",
                code_sha=code_sha,
            )
            self._log("ONLINE_CODE_CONSUMED", f"应急码 {request_id} 已在线校验通过并一次性作废（{action_type}）。", t)
        self.broadcast("code_consumed")
        return {
            "ok": True,
            "mode": "ONLINE",
            "requestId": request_id,
            "sessionId": session_id,
            "actionType": action_type,
            "targetAppId": norm_target,
            "consumedAt": t,
        }


def make_handler(service: CompanionService):
    class CompanionHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: Any) -> None:
            pass

        def _is_loopback(self) -> bool:
            ip = self.client_address[0]
            return ip in ("127.0.0.1", "::1", "localhost")

        def _send_json(self, status: int, data: Dict[str, Any]) -> None:
            body = json.dumps(data, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)

        def _read_body(self) -> bytes:
            length = int(self.headers.get("Content-Length", "0") or "0")
            return self.rfile.read(length) if length > 0 else b""

        def do_OPTIONS(self) -> None:
            self.send_response(HTTPStatus.NO_CONTENT)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-DS-PairId, X-DS-Timestamp, X-DS-Nonce, X-DS-Signature")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self) -> None:
            path = urlparse(self.path).path

            if path == "/api/health":
                self._send_json(200, {
                    "ok": True,
                    "service": "DormSleepCompanion",
                    "storageBackend": service.secret_store.backend,
                    "httpPort": service.http_port,
                    "udpPort": service.udp_port,
                    "lanIps": get_lan_ipv4_addresses(),
                })
                return

            if path == "/api/state":
                if not self._is_loopback():
                    self._send_json(403, {"ok": False, "errorCode": "LOCAL_ONLY"})
                    return
                self._send_json(200, service.get_desktop_state())
                return

            if path == "/api/events":
                if not self._is_loopback():
                    self._send_json(403, {"ok": False, "errorCode": "LOCAL_ONLY"})
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "keep-alive")
                self.end_headers()

                q: queue.Queue = queue.Queue(maxsize=64)
                with service.lock:
                    service.subscribers.append(q)
                try:
                    self.wfile.write(f'data: {json.dumps({"type": "connected", "ts": now_ms()})}\n\n'.encode("utf-8"))
                    self.wfile.flush()
                    while not service.shutdown_event.is_set():
                        try:
                            msg = q.get(timeout=15.0)
                            if msg is None:
                                break
                            self.wfile.write(f"data: {msg}\n\n".encode("utf-8"))
                            self.wfile.flush()
                        except queue.Empty:
                            if service.shutdown_event.is_set():
                                break
                            self.wfile.write(b": keepalive\n\n")
                            self.wfile.flush()
                except Exception:
                    pass
                finally:
                    with service.lock:
                        if q in service.subscribers:
                            service.subscribers.remove(q)
                return

            # 仅本机可访问桌面静态界面
            if not self._is_loopback():
                self._send_json(403, {"ok": False, "errorCode": "LOCAL_ONLY"})
                return
            self._serve_static(path)

        def do_POST(self) -> None:
            path = urlparse(self.path).path
            raw = self._read_body()
            try:
                body = json.loads(raw.decode("utf-8")) if raw else {}
            except Exception:
                self._send_json(400, {"ok": False, "errorCode": "BAD_JSON"})
                return

            # 1) 面向同局域网 Android 手机的协议端点
            if path == "/api/lan/v1/pair/confirm":
                res = service.lan_confirm_pairing(body.get("pairCode", ""), body.get("mobileName", "Android 手机"))
                self._send_json(200, res)
                return

            if path == "/api/lan/v1/phone/heartbeat":
                if not service._verify_phone_headers(self.headers, "POST", path, raw):
                    self._send_json(401, {"ok": False, "errorCode": "UNAUTHORIZED"})
                    return
                res = service.lan_phone_heartbeat(body.get("snapshot", body))
                self._send_json(200, res)
                return

            if path == "/api/lan/v1/emergency/verify-online":
                if not service._verify_phone_headers(self.headers, "POST", path, raw):
                    self._send_json(401, {"ok": False, "errorCode": "UNAUTHORIZED"})
                    return
                res = service.lan_verify_online_code(
                    session_id=body.get("sessionId", ""),
                    request_id=body.get("requestId", ""),
                    action_type=body.get("actionType", ""),
                    target_app_id=body.get("targetAppId"),
                    submitted_code=body.get("code", ""),
                )
                self._send_json(200, res)
                return

            # 2) 仅限本机桌面 UI 调用的端点（防同宿舍他人远程触发电脑生成应急码！）
            if not self._is_loopback():
                self._send_json(403, {"ok": False, "errorCode": "LOCAL_ONLY"})
                return

            if path == "/api/pair/start":
                self._send_json(200, service.start_pairing())
            elif path == "/api/pair/unbind":
                self._send_json(200, service.unbind_pairing())
            elif path == "/api/desktop/emergency/issue":
                self._send_json(200, service.issue_online_code(body.get("actionType"), body.get("targetAppId")))
            elif path == "/api/desktop/emergency/offline":
                self._send_json(
                    200,
                    service.compute_offline_code(
                        session_id=body.get("sessionId", ""),
                        request_id=body.get("requestId", ""),
                        action_type=body.get("actionType", "TEMP_ALLOW_15M"),
                        target_app_id=body.get("targetAppId"),
                    ),
                )
            else:
                self._send_json(404, {"ok": False, "errorCode": "NOT_FOUND"})

        def _serve_static(self, raw_path: str) -> None:
            asset_root = get_asset_root()
            if raw_path == "/favicon.ico":
                ico_candidates = [
                    asset_root / "favicon.ico",
                    SERVICE_DIR / "assets" / "dormsleep.ico",
                ]
                for ico in ico_candidates:
                    if ico.is_file():
                        data = ico.read_bytes()
                        self.send_response(200)
                        self.send_header("Content-Type", "image/x-icon")
                        self.send_header("Content-Length", str(len(data)))
                        self.send_header("Cache-Control", "max-age=3600")
                        self.end_headers()
                        self.wfile.write(data)
                        return
                self.send_response(204)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return

            if raw_path in ("/", "", "/desktop", "/desktop/"):
                rel = "apps/desktop/index.html"
            elif raw_path.startswith("/desktop/"):
                rel = "apps/desktop/" + raw_path[len("/desktop/"):]
            elif raw_path.startswith("/shared/") or raw_path.startswith("/adapters/"):
                rel = raw_path.lstrip("/")
            else:
                rel = raw_path.lstrip("/")

            target = (asset_root / rel).resolve()
            if not target.is_relative_to(asset_root) or not target.is_file():
                self.send_response(404)
                self.send_header("Content-Length", "9")
                self.end_headers()
                self.wfile.write(b"Not Found")
                return

            ctype, _ = mimetypes.guess_type(str(target))
            if target.suffix == ".js":
                ctype = "application/javascript; charset=utf-8"
            elif target.suffix == ".css":
                ctype = "text/css; charset=utf-8"
            elif target.suffix == ".html":
                ctype = "text/html; charset=utf-8"
            elif not ctype:
                ctype = "application/octet-stream"

            data = target.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

    return CompanionHandler


class CompanionHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


class CompanionRuntime:
    """可嵌入系统托盘程序或命令行运行的统一伴随服务生命周期管理器。"""

    def __init__(
        self,
        host: Optional[str] = None,
        port: Optional[int] = None,
        udp_port: Optional[int] = None,
        data_dir: Optional[Path] = None,
    ):
        self.host = host or os.environ.get("DORMSLEEP_COMPANION_HOST", "0.0.0.0")
        self.port = int(port if port is not None else os.environ.get("DORMSLEEP_COMPANION_PORT", "4180"))
        self.udp_port = int(udp_port if udp_port is not None else os.environ.get("DORMSLEEP_DISCOVERY_PORT", "41740"))
        self.data_dir = Path(data_dir) if data_dir is not None else get_default_data_dir()
        self.data_dir.mkdir(parents=True, exist_ok=True)

        self.service: Optional[CompanionService] = None
        self.discovery: Optional[LanDiscoveryResponder] = None
        self.server: Optional[CompanionHTTPServer] = None
        self._http_thread: Optional[threading.Thread] = None
        self._started = False

    def start(self) -> None:
        if self._started:
            return
        self.service = CompanionService(self.data_dir, http_port=self.port, udp_port=self.udp_port)
        self.discovery = LanDiscoveryResponder(
            udp_port=self.udp_port,
            http_port=self.port,
            info_provider=lambda: self.service.db.get_pairing(),  # type: ignore[union-attr]
            bind_host=self.host if self.host != "127.0.0.1" else "127.0.0.1",
        )
        self.discovery.start()
        self.server = CompanionHTTPServer((self.host, self.port), make_handler(self.service))
        self._http_thread = threading.Thread(
            target=self.server.serve_forever,
            kwargs={"poll_interval": 0.3},
            name="DormSleepHTTP",
            daemon=True,
        )
        self._http_thread.start()
        self._started = True

    def stop(self) -> None:
        if not self._started:
            return
        self._started = False
        if self.service:
            self.service.notify_shutdown()
        if self.discovery:
            self.discovery.stop()
        if self.server:
            try:
                self.server.shutdown()
            except Exception:
                pass
            try:
                self.server.server_close()
            except Exception:
                pass
        if self._http_thread and self._http_thread.is_alive():
            self._http_thread.join(timeout=2.0)
        if self.service:
            self.service.close()

    def get_status_summary(self) -> str:
        if not self.service:
            return "未启动"
        st = self.service.get_desktop_state()
        d = st["desktop"]
        p = d["pairing"]
        if p["status"] == "UNPAIRED":
            return "尚未配对手机"
        if p["status"] == "PENDING":
            return "等待手机输入配对码"
        if not d["connected"]:
            return "未连接手机 · 支持离线取码"
        snap = d.get("snapshot")
        if not snap:
            return "已连接手机 · 同步状态中"
        status_map = {
            "IDLE": "已连接 · 待机中",
            "PRE_LOCK_REMINDER": "已连接 · 睡前收尾提醒中",
            "LOCKED": "手机夜间限制中",
            "TEMP_ALLOW": "手机临时放行 20 分钟中",
            "TRIAL_LOCKED": "白天试锁中",
            "NATURAL_ENDED": "已连接 · 今晨已自然结束",
            "ENDED_EARLY": "已连接 · 今晚已提前解除",
            "PAUSED_TONIGHT": "已连接 · 今晚已暂停",
            "PROTECTION_INTERRUPTED": "警告：手机权限异常",
        }
        return status_map.get(snap.get("status", "IDLE"), "已连接手机")


def run_companion() -> None:
    runtime = CompanionRuntime()
    runtime.start()
    assert runtime.service is not None
    lan_ips = get_lan_ipv4_addresses()
    print("[DormSleep Windows Companion] 本地伴随服务已启动")
    print(f"  - 桌面端本机界面：http://127.0.0.1:{runtime.port}/")
    if lan_ips:
        print(f"  - 局域网同步地址：http://{lan_ips[0]}:{runtime.port}/api/lan/v1/*")
    else:
        print(f"  - 局域网同步端口：http://{runtime.host}:{runtime.port}/api/lan/v1/*")
    print(f"  - UDP 局域网发现：UDP {runtime.udp_port} (DORMSLEEP_DISCOVER_V1)")
    print(f"  - 数据存储目录：{runtime.data_dir}")
    print(f"  - 密钥保护后端：{runtime.service.secret_store.backend}")
    try:
        while True:
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\n[DormSleep Windows Companion] 正在关闭…")
    finally:
        runtime.stop()


if __name__ == "__main__":
    run_companion()
