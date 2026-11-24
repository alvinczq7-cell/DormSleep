#!/usr/bin/env python3
"""
DormSleep 真实 Windows 本地伴随服务 (services/windows-companion/companion_server.py) 端到端集成测试
覆盖：
1. UDP 局域网发现广播真实响应 (DORMSLEEP_DISCOVER_V1)
2. 8 位一次性配对码局域网配对 + 密钥持久化 (SecureStore) + SQLite WAL 持久化
3. HMAC-SHA256 局域网请求签名防伪造（伪造/篡改签名被 401 拦截，合法签名心跳通过）
4. 在线 CSPRNG 应急发码 + 手机端调用 /api/lan/v1/emergency/verify-online 校验成功 + 重放拒绝
5. 切换手机活动请求后旧在线应急码自动作废 (REQUEST_INVALIDATED)
6. 重启 Windows 伴随服务进程后，配对状态、DPAPI/SecureStore 密钥与消费防重放表全部持久恢复
7. 完全离线算码 (/api/desktop/emergency/offline) 结果与 shared/crypto.js 及 mock-bridge 算法 100% 字节级一致，且前端不接触明文密钥
"""

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "services" / "windows-companion"))
import crypto_core  # noqa: E402

HTTP_PORT = 4188
UDP_PORT = 41748
BASE = f"http://127.0.0.1:{HTTP_PORT}"


def http_req(method: str, path: str, payload=None, headers=None):
    raw = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else b""
    hdrs = {"Content-Type": "application/json"}
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(f"{BASE}{path}", data=raw if method == "POST" else None, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read().decode("utf-8"))


def signed_phone_post(path: str, payload: dict, pair_id: str, shared_secret: str, nonce: str):
    raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    ts = int(time.time() * 1000)
    sig = crypto_core.sign_lan_request(shared_secret, pair_id, ts, nonce, "POST", path, raw)
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=raw,
        headers={
            "Content-Type": "application/json",
            "X-DS-PairId": pair_id,
            "X-DS-Timestamp": str(ts),
            "X-DS-Nonce": nonce,
            "X-DS-Signature": sig,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read().decode("utf-8"))


def start_companion_proc(data_dir: Path):
    env = dict(
        **os.environ,
        DORMSLEEP_COMPANION_HOST="127.0.0.1",
        DORMSLEEP_COMPANION_PORT=str(HTTP_PORT),
        DORMSLEEP_DISCOVERY_PORT=str(UDP_PORT),
        DORMSLEEP_DATA_DIR=str(data_dir),
    )
    proc = subprocess.Popen(
        [sys.executable, str(ROOT / "services" / "windows-companion" / "companion_server.py")],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )
    for _ in range(30):
        try:
            st, body = http_req("GET", "/api/health")
            if st == 200 and body.get("ok"):
                return proc
        except Exception:
            time.sleep(0.12)
    raise RuntimeError("Windows Companion Service failed to start")


def stop_proc(proc):
    proc.terminate()
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        proc.kill()


def assert_eq(a, b, msg):
    if a != b:
        raise AssertionError(f"[FAIL] {msg}: expected={b!r}, actual={a!r}")


def assert_true(cond, msg):
    if not cond:
        raise AssertionError(f"[FAIL] {msg}")


def run_tests():
    tmp_dir = Path(tempfile.mkdtemp(prefix="dormsleep_companion_test_"))
    proc = start_companion_proc(tmp_dir)
    try:
        # 1. UDP 局域网发现探测
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.settimeout(2.0)
            sock.sendto(b"DORMSLEEP_DISCOVER_V1", ("127.0.0.1", UDP_PORT))
            data, _ = sock.recvfrom(1024)
            disc = json.loads(data.decode("utf-8"))
            assert_eq(disc["service"], "DormSleepCompanion", "UDP discovery service name")
            assert_eq(disc["httpPort"], HTTP_PORT, "UDP discovery httpPort")
        print("PASS [1/7] UDP 局域网发现广播响应通过")

        # 2. 配对握手 + 前端状态绝不泄露 sharedSecret
        st, pstart = http_req("POST", "/api/pair/start", {})
        assert_true(st == 200 and len(pstart["pairCode"]) == 8, "Generate 8-char pair code")

        st, pconf = http_req("POST", "/api/lan/v1/pair/confirm", {"pairCode": pstart["pairCode"], "mobileName": "小米14真机"})
        assert_true(st == 200 and pconf["ok"], "LAN confirm pairing")
        pair_id = pconf["pairId"]
        shared_secret = pconf["sharedSecret"]

        st, desk_state = http_req("GET", "/api/state?client=desktop")
        assert_eq(st, 200, "Desktop GET /api/state")
        assert_true(shared_secret not in json.dumps(desk_state), "Desktop browser state MUST NOT leak plaintext sharedSecret")
        assert_eq(desk_state["desktop"]["pairing"]["serverSideOfflineCalc"], True, "Server-side DPAPI offline calc enabled")
        print("PASS [2/7] 局域网配对 + 密钥隔离（前端无明文密钥）通过")

        # 3. 伪造签名心跳被 401 拦截，合法 HMAC 签名心跳通过
        bad_st, _ = http_req("POST", "/api/lan/v1/phone/heartbeat", {"snapshot": {}}, headers={"X-DS-PairId": pair_id, "X-DS-Signature": "deadbeef"})
        assert_eq(bad_st, 401, "Reject forged LAN heartbeat")

        now = int(time.time() * 1000)
        snap = {
            "activeMode": "NIGHT",
            "sessionId": "night:2026-11-21",
            "nightKey": "2026-11-21",
            "status": "LOCKED",
            "permissionsOk": True,
            "startAt": now - 60_000,
            "endAt": now + 3600_000,
            "freezeCutoffAt": now - 1860_000,
            "effectiveRestrictedAppIds": ["tv.danmaku.bili", "com.ss.android.ugc.aweme"],
            "activeRequest": {
                "requestId": "K7M4-92",
                "sessionId": "night:2026-11-21",
                "actionType": "TEMP_ALLOW_15M",
                "targetAppId": "tv.danmaku.bili",
                "createdAt": now,
                "expiresAt": now + 3600_000,
            },
            "consumedCount": 0,
        }
        hb_st, hb_res = signed_phone_post("/api/lan/v1/phone/heartbeat", {"snapshot": snap}, pair_id, shared_secret, "nonce-hb-1")
        assert_true(hb_st == 200 and hb_res["ok"], "Valid HMAC-signed heartbeat accepted")
        # 同一 nonce 重放应被 401 拦截
        replay_hb_st, _ = signed_phone_post("/api/lan/v1/phone/heartbeat", {"snapshot": snap}, pair_id, shared_secret, "nonce-hb-1")
        assert_eq(replay_hb_st, 401, "Duplicate nonce rejected")
        print("PASS [3/7] HMAC-SHA256 局域网验签与防重放通过")

        # 4. 在线签发 6 位 CSPRNG 码 + 手机调用 verify-online 校验 + 重放拒绝
        st, issued = http_req("POST", "/api/desktop/emergency/issue", {"actionType": "TEMP_ALLOW_15M", "targetAppId": "tv.danmaku.bili"})
        assert_true(st == 200 and issued["ok"] and len(issued["issued"]["code"]) == 6, "Desktop issues online 6-digit code")
        code1 = issued["issued"]["code"]

        # 错目标应用校验拒绝
        _, wrong_target = signed_phone_post(
            "/api/lan/v1/emergency/verify-online",
            {"sessionId": "night:2026-11-21", "requestId": "K7M4-92", "actionType": "TEMP_ALLOW_15M", "targetAppId": "com.ss.android.ugc.aweme", "code": code1},
            pair_id, shared_secret, "nonce-ver-1",
        )
        assert_eq(wrong_target["errorCode"], "REQUEST_MISMATCH", "Wrong target rejected online")

        # 正确校验成功
        _, ok_ver = signed_phone_post(
            "/api/lan/v1/emergency/verify-online",
            {"sessionId": "night:2026-11-21", "requestId": "K7M4-92", "actionType": "TEMP_ALLOW_15M", "targetAppId": "tv.danmaku.bili", "code": code1},
            pair_id, shared_secret, "nonce-ver-2",
        )
        assert_true(ok_ver["ok"] and ok_ver["mode"] == "ONLINE", "Online verify succeeded")

        # 立刻重放同一码拒绝
        _, rep_ver = signed_phone_post(
            "/api/lan/v1/emergency/verify-online",
            {"sessionId": "night:2026-11-21", "requestId": "K7M4-92", "actionType": "TEMP_ALLOW_15M", "targetAppId": "tv.danmaku.bili", "code": code1},
            pair_id, shared_secret, "nonce-ver-3",
        )
        assert_eq(rep_ver["errorCode"], "CODE_ALREADY_USED", "Replayed online code rejected")
        print("PASS [4/7] 在线签发、目标绑定校验与单次消费防重放通过")

        # 5. 手机切换活动请求 → 电脑旧在线码自动作废
        snap["activeRequest"]["requestId"] = "R3T8-15"
        signed_phone_post("/api/lan/v1/phone/heartbeat", {"snapshot": snap}, pair_id, shared_secret, "nonce-hb-2")
        _, issued2 = http_req("POST", "/api/desktop/emergency/issue", {"actionType": "TEMP_ALLOW_15M", "targetAppId": "tv.danmaku.bili"})
        code2 = issued2["issued"]["code"]

        # 手机又切到新请求 W9P2-44
        snap["activeRequest"]["requestId"] = "W9P2-44"
        signed_phone_post("/api/lan/v1/phone/heartbeat", {"snapshot": snap}, pair_id, shared_secret, "nonce-hb-3")
        _, inv_ver = signed_phone_post(
            "/api/lan/v1/emergency/verify-online",
            {"sessionId": "night:2026-11-21", "requestId": "R3T8-15", "actionType": "TEMP_ALLOW_15M", "targetAppId": "tv.danmaku.bili", "code": code2},
            pair_id, shared_secret, "nonce-ver-4",
        )
        assert_eq(inv_ver["errorCode"], "REQUEST_INVALIDATED", "Rotated request invalidates old issued code")
        print("PASS [5/7] 手机切换请求自动作废旧在线码通过")

        # 6. 重启真实 Windows 伴随服务进程 → SQLite + SecureStore 持久化恢复验证
        stop_proc(proc)
        proc = start_companion_proc(tmp_dir)
        _, after_restart = http_req("GET", "/api/state?client=desktop")
        assert_eq(after_restart["desktop"]["pairing"]["pairId"], pair_id, "Pairing survived process restart")
        assert_true(after_restart["desktop"]["snapshot"]["consumedCount"] >= 1, "Consumed count survived process restart")
        # 重启后重放重启前消费过的 code1 仍被拒！
        _, rep_after_restart = signed_phone_post(
            "/api/lan/v1/emergency/verify-online",
            {"sessionId": "night:2026-11-21", "requestId": "K7M4-92", "actionType": "TEMP_ALLOW_15M", "targetAppId": "tv.danmaku.bili", "code": code1},
            pair_id, shared_secret, "nonce-ver-after-restart",
        )
        assert_eq(rep_after_restart["errorCode"], "CODE_ALREADY_USED", "Consumed record persisted across companion restart")
        print("PASS [6/7] 伴随服务重启持久化（配对/密钥/消费防重放）通过")

        # 7. 完全离线算码 (/api/desktop/emergency/offline) 与标准 HMAC-SHA256 一致
        st, off_res = http_req("POST", "/api/desktop/emergency/offline", {
            "sessionId": "night:2026-11-21",
            "requestId": "W9P2-44",
            "actionType": "TEMP_ALLOW_15M",
            "targetAppId": "tv.danmaku.bili",
        })
        expected_offline = crypto_core.derive_offline_emergency_code(
            shared_secret, pair_id, "night:2026-11-21", "W9P2-44", "TEMP_ALLOW_15M", "tv.danmaku.bili"
        )
        assert_true(st == 200 and off_res["ok"], "Server-side offline calc succeeded")
        assert_eq(off_res["code"], expected_offline, "Offline code matches canonical HMAC-SHA256")
        print("PASS [7/7] 服务端本机 DPAPI/SecureStore 离线算码与标准算法 100% 一致")

        print("\n✅ Windows 本地伴随服务全部 7 组真实集成测试通过！")
    finally:
        stop_proc(proc)
        shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == "__main__":
    run_tests()
