#!/usr/bin/env python3
"""
DormSleep 端到端前端资源与核心业务规则自动化验收脚本。
覆盖：
1. 静态资源与双端 HTML/JS/CSS 可访问性校验
2. 配对闭环与安全隔离（手机视图绝不包含在线明文应急码与共享密钥）
3. 演示流程 A：1 分钟后开始 + 停留在受限应用内自动拦截 + 在线即显取码 + 输错提示 + 15 分钟单应用放行 + 其余受限仍拦 + 到期自动拉回 + 旧码重放拒绝
4. 演示流程 B：不取码到点自然结束，双端同步恢复
5. 规则 1：固定今晚修改截止时间不可通过反复推迟延长 + 冻结期放宽应用限制次晚生效
6. 规则 2：应急请求绑定（会话/操作/目标应用）+ 切换即作废旧请求 + 重启持久化防重放
7. 离线场景：23:30 电脑关机 -> 跨午夜凌晨 01:00 开机且局域网断开 -> 完全离线 HMAC-SHA256 取码与校验
8. 竞态场景：自然结束与应急校验同时发生时的一致性
9. 权限撤销告警与遗失电脑锁定中 24 小时冷却
"""

import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "mock-bridge"))
import server as bridge_mod  # noqa: E402

PORT = 4199
BASE = f"http://127.0.0.1:{PORT}"


def http_get(path: str):
    with urllib.request.urlopen(f"{BASE}{path}", timeout=5) as resp:
        return resp.status, resp.headers.get("Content-Type", ""), resp.read()


def http_post(path: str, payload: dict):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8"))


def get_state(client: str = "all"):
    _, _, raw = http_get(f"/api/state?client={client}")
    return json.loads(raw.decode("utf-8"))


def assert_eq(actual, expected, label):
    if actual != expected:
        raise AssertionError(f"[FAIL] {label}: expected={expected!r}, actual={actual!r}")


def assert_true(cond, label):
    if not cond:
        raise AssertionError(f"[FAIL] {label}")


def run_all_tests():
    # 启动独立端口服务进程
    env = dict(**__import__("os").environ, DORMSLEEP_PORT=str(PORT))
    proc = subprocess.Popen(
        [sys.executable, str(ROOT / "mock-bridge" / "server.py"), str(PORT)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )
    try:
        # 等待服务就绪
        for _ in range(30):
            try:
                status, _, _ = http_get("/api/state")
                if status == 200:
                    break
            except Exception:
                time.sleep(0.15)
        else:
            raise RuntimeError("Mock server failed to start")

        # 1. 验证全部静态资源可正常返回
        static_paths = [
            "/",
            "/mobile/",
            "/mobile/styles.css",
            "/mobile/store.js",
            "/mobile/app.js",
            "/desktop/",
            "/desktop/styles.css",
            "/desktop/store.js",
            "/desktop/app.js",
            "/shared/constants.js",
            "/shared/protocol.js",
            "/shared/crypto.js",
            "/shared/scheduleEngine.js",
            "/adapters/interfaces.js",
            "/adapters/mockHttpClient.js",
            "/adapters/mobileSystemAdapter.js",
            "/adapters/desktopSystemAdapter.js",
        ]
        for sp in static_paths:
            code, _, body = http_get(sp)
            assert_eq(code, 200, f"GET {sp}")
            assert_true(len(body) > 50, f"Non-empty {sp}")
        print("PASS [1/9] 全部静态页面与 JS/CSS 模块返回 200")

        # 2. 重置并验证首次配对 + 安全隔离
        http_post("/api/sim/reset", {"autoPair": False})
        _, pair_start = http_post("/api/pair/start", {})
        assert_true(pair_start["ok"] and len(pair_start["pairCode"]) == 8, "Generate 8-char pair code")
        _, bad_confirm = http_post("/api/pair/confirm", {"pairCode": "WRONG999"})
        assert_eq(bad_confirm["ok"], False, "Reject invalid pair code")
        _, ok_confirm = http_post("/api/pair/confirm", {"pairCode": pair_start["pairCode"]})
        assert_true(ok_confirm["ok"], "Confirm valid pair code")

        st_mob = get_state("mobile")["mobile"]
        assert_true("sharedSecret" not in json.dumps(st_mob), "Mobile view MUST NOT expose sharedSecret")
        assert_true("plaintextCode" not in json.dumps(st_mob), "Mobile view MUST NOT expose plaintextCode")
        print("PASS [2/9] 首次配对与手机端密钥/明文隔离校验通过")

        # 3. 规则 1：固定当晚截止时间不可通过反复推迟延长 + 冻结期放宽调整次晚生效
        http_post("/api/sim/reset", {"autoPair": True})
        # 先将时间跳到常规开始前 60 分钟（尚未冻结）
        st0 = get_state()
        orig_cutoff = st0["mobile"]["live"]["freezeCutoffAt"]
        now_ms = st0["nowMs"]
        target_before_freeze = orig_cutoff - 30 * 60 * 1000
        delta_s = int((target_before_freeze - now_ms) / 1000)
        http_post("/api/sim/time", {"action": "DELTA", "deltaSeconds": delta_s})

        # 尝试用「仅改今晚」把开始时间往后推 2 小时（如 01:30）
        _, ov_res = http_post("/api/mobile/tonight-override", {"mode": "CUSTOM_TIME", "start": "01:30", "end": "08:00"})
        assert_true(ov_res["ok"], "Apply tonight override before freeze")
        st1 = get_state()["mobile"]["live"]
        assert_eq(st1["freezeCutoffAt"], orig_cutoff, "Freeze cutoff MUST remain fixed and NOT extend after postponing")
        assert_true(st1["tonightOverride"]["nextRegularResumeAt"] > st1["startAt"], "nextRegularResumeAt populated")

        # 把时间推进到 orig_cutoff 之后 5 分钟（虽然离 01:30 还有很久，但已过固定截止时间！）
        http_post("/api/sim/time", {"action": "DELTA", "deltaSeconds": 35 * 60})
        st2 = get_state()["mobile"]["live"]
        assert_eq(st2["isFrozen"], True, "Frozen after fixed cutoff even when tonight start was postponed")
        _, frozen_ov = http_post("/api/mobile/tonight-override", {"mode": "PAUSE_TONIGHT"})
        assert_eq(frozen_ov["ok"], False, "Tonight override blocked after fixed cutoff")
        assert_eq(frozen_ov["errorCode"], "FROZEN_MODIFICATION", "Exact error code FROZEN_MODIFICATION")

        # 冻结期内尝试移除受限应用 tv.danmaku.bili（放宽限制），应推迟到下一晚生效
        _, app_relax = http_post("/api/mobile/apps", {
            "restrictedAppIds": ["com.ss.android.ugc.aweme"],
            "exemptAppIds": ["edu.campus.card", "com.auth.campus", "tv.danmaku.bili"],
        })
        assert_true(app_relax["ok"] and app_relax["deferredToNextNight"], "Relaxing apps during freeze defers to next night")
        st3 = get_state()["mobile"]
        assert_true("tv.danmaku.bili" in st3["live"]["effectiveRestrictedAppIds"], "Bilibili STILL restricted tonight")
        assert_true("tv.danmaku.bili" not in st3["pendingNextNight"]["restrictedAppIds"], "Bilibili removed in pendingNextNight")
        print("PASS [3/9] 固定截止时间防延长 + 冻结期放宽限制次晚生效通过")

        # 4. 演示流程 A：1 分钟后开始 + 停留在受限应用内自动拦截 + 在线即显取码 + 输错 + 15 分钟单应用放行 + 切换作废 + 到期自动拉回 + 重启后旧码仍失效
        http_post("/api/sim/reset", {"autoPair": True})
        http_post("/api/sim/start-in-one-minute", {"durationMinutes": 45})
        # 用户此时停留在哔哩哔哩内
        http_post("/api/mobile/foreground", {"appId": "tv.danmaku.bili"})
        st_pre = get_state()["mobile"]
        assert_eq(st_pre["live"]["status"], "PRE_LOCK_REMINDER", "In pre-lock reminder")
        assert_eq(st_pre["shouldShowOverlay"], False, "No overlay before lock start")

        # 快进到锁定开始：停留在哔哩哔哩内自动弹出拦截页！
        http_post("/api/sim/time", {"action": "JUMP_LOCK_START"})
        st_locked = get_state()
        assert_eq(st_locked["mobile"]["live"]["status"], "LOCKED", "Mobile auto-locked")
        assert_eq(st_locked["mobile"]["shouldShowOverlay"], True, "Overlay auto-triggered while staying inside restricted app")
        assert_eq(st_locked["desktop"]["snapshot"]["status"], "LOCKED", "Desktop synced LOCKED")

        # 电脑端立即生成临时放行码（绑定哔哩哔哩）
        _, issue1 = http_post("/api/desktop/emergency/issue", {"actionType": "TEMP_ALLOW_15M", "targetAppId": "tv.danmaku.bili"})
        assert_true(issue1["ok"], "Desktop issues online code immediately")
        code1 = issue1["issued"]["code"]
        req1_id = issue1["issued"]["requestId"]

        # 确认手机端状态视图里绝不包含该明文码
        assert_true(code1 not in json.dumps(get_state("mobile")), "Plaintext code NOT leaked to mobile state")

        # 手机端切换目标应用到抖音 → 旧请求 req1 与旧码 code1 立即作废！
        _, prep2 = http_post("/api/mobile/emergency/prepare", {"actionType": "TEMP_ALLOW_15M", "targetAppId": "com.ss.android.ugc.aweme"})
        assert_true(prep2["ok"] and prep2["rotated"], "Switching target app rotates requestId")
        assert_true(prep2["request"]["requestId"] != req1_id, "New requestId differs from old")

        # 用旧码 code1 尝试校验 → 应返回 REQUEST_INVALIDATED
        _, inv_try = http_post("/api/mobile/emergency/verify", {"code": code1})
        assert_eq(inv_try["ok"], False, "Invalidated code rejected")
        assert_eq(inv_try["errorCode"], "REQUEST_INVALIDATED", "Exact error REQUEST_INVALIDATED")

        # 切回哔哩哔哩并由电脑重新签发新码
        http_post("/api/mobile/emergency/prepare", {"actionType": "TEMP_ALLOW_15M", "targetAppId": "tv.danmaku.bili"})
        _, issue2 = http_post("/api/desktop/emergency/issue", {"actionType": "TEMP_ALLOW_15M", "targetAppId": "tv.danmaku.bili"})
        code2 = issue2["issued"]["code"]

        # 先输错一次，确认提示与计数
        wrong_code = "000000" if code2 != "000000" else "999999"
        _, wrong_res = http_post("/api/mobile/emergency/verify", {"code": wrong_code})
        assert_eq(wrong_res["ok"], False, "Wrong code rejected")
        assert_true(wrong_res["wrongAttempts"] >= 1, "Wrong attempts incremented")

        # 输入正确码 code2 → 仅放行哔哩哔哩 15 分钟
        _, ok_verify = http_post("/api/mobile/emergency/verify", {"code": code2})
        assert_true(ok_verify["ok"] and ok_verify["actionType"] == "TEMP_ALLOW_15M", "Temp allow 15m granted")
        st_allow = get_state()
        assert_eq(st_allow["mobile"]["live"]["status"], "TEMP_ALLOW", "Mobile in TEMP_ALLOW")
        assert_eq(st_allow["desktop"]["snapshot"]["status"], "TEMP_ALLOW", "Desktop synced TEMP_ALLOW")
        assert_eq(st_allow["mobile"]["shouldShowOverlay"], False, "Overlay hidden while inside allowed Bilibili")

        # 此时打开抖音仍被拦截！
        http_post("/api/mobile/foreground", {"appId": "com.ss.android.ugc.aweme"})
        assert_eq(get_state("mobile")["mobile"]["shouldShowOverlay"], True, "Other restricted app Douyin STILL intercepted during Bilibili allow")
        # 回到哔哩哔哩继续停留，快进到 15 分钟到期 → 自动拉回拦截页！
        http_post("/api/mobile/foreground", {"appId": "tv.danmaku.bili"})
        assert_eq(get_state("mobile")["mobile"]["shouldShowOverlay"], False, "Bilibili allowed before expiry")
        http_post("/api/sim/time", {"action": "JUMP_ALLOW_END"})
        st_relocked = get_state("mobile")["mobile"]
        assert_eq(st_relocked["live"]["status"], "LOCKED", "Auto relocked after 15m")
        assert_eq(st_relocked["shouldShowOverlay"], True, "Overlay auto-retriggered while staying inside Bilibili at 15m expiry")

        # 模拟手机重启，验证重启后状态保持 LOCKED 且旧码 code2 仍然不可重放！
        _, rb = http_post("/api/sim/reboot-mobile", {})
        assert_eq(rb["status"], "LOCKED", "State survives mobile reboot")
        assert_true(rb["consumedCount"] >= 1, "Consumed requests survive mobile reboot")
        _, replay_after_reboot = http_post("/api/mobile/emergency/verify", {"code": code2})
        assert_eq(replay_after_reboot["ok"], False, "Consumed code rejected after reboot")
        assert_eq(replay_after_reboot["errorCode"], "CODE_ALREADY_USED", "Exact error CODE_ALREADY_USED after reboot")
        print("PASS [4/9] 演示流程 A（停留在应用内拦截/取码/切换作废/20分到期拉回/重启后旧码防重放）全部通过")

        # 5. 演示流程 B：不取码自然结束
        http_post("/api/sim/time", {"action": "JUMP_NATURAL_END"})
        st_nat = get_state()
        assert_eq(st_nat["mobile"]["live"]["status"], "NATURAL_ENDED", "Mobile natural ended")
        assert_eq(st_nat["desktop"]["snapshot"]["status"], "NATURAL_ENDED", "Desktop synced natural ended")
        assert_eq(st_nat["mobile"]["shouldShowOverlay"], False, "Overlay cleared on natural end")
        print("PASS [5/9] 演示流程 B（不取码自然结束，双端同步恢复）通过")

        # 6. 23:30 电脑关机 → 凌晨 01:00 开机且局域网断开（完全离线取码 + 跨午夜会话一致 + 错误目标拒绝）
        http_post("/api/sim/reset", {"autoPair": True})
        http_post("/api/sim/network", {"pcPoweredOn": False, "lanConnected": False})
        http_post("/api/sim/time", {"action": "JUMP_LOCK_START"})
        http_post("/api/sim/time", {"action": "JUMP_NIGHT_0100"})
        # 01:00 电脑开机，但局域网仍处于 AP 隔离断开状态
        http_post("/api/sim/network", {"pcPoweredOn": True, "lanConnected": False})
        st_off = get_state()
        assert_eq(st_off["mobile"]["live"]["status"], "LOCKED", "Phone locked at 01:00 across midnight")
        assert_eq(st_off["desktop"]["connected"], False, "Desktop sees offline mode")

        mob_req = st_off["mobile"]["live"]["activeRequest"]
        pair_id = st_off["desktop"]["pairing"]["pairId"]
        secret = st_off["desktop"]["pairing"]["offlineSharedSecret"]

        # 电脑端错误选了 END_TONIGHT 算出的码，手机端当前是 TEMP_ALLOW_15M → 应提示 REQUEST_MISMATCH
        wrong_action_code = bridge_mod.derive_offline_code(
            secret, pair_id, mob_req["sessionId"], mob_req["requestId"], "END_TONIGHT", None
        )
        _, mismatch_res = http_post("/api/mobile/emergency/verify", {"code": wrong_action_code})
        assert_eq(mismatch_res["ok"], False, "Mismatched offline action rejected")
        assert_eq(mismatch_res["errorCode"], "REQUEST_MISMATCH", "Exact error REQUEST_MISMATCH")

        # 电脑端按匹配参数算出的离线 HMAC 码 → 手机本地校验成功！
        right_offline_code = bridge_mod.derive_offline_code(
            secret, pair_id, mob_req["sessionId"], mob_req["requestId"], mob_req["actionType"], mob_req["targetAppId"]
        )
        _, off_ok = http_post("/api/mobile/emergency/verify", {"code": right_offline_code})
        assert_true(off_ok["ok"] and off_ok["mode"] == "OFFLINE", "Offline HMAC code verified locally")
        assert_true(off_ok["nextRequestId"] != mob_req["requestId"], "RequestId rotated to new random ID after offline consume")

        # 离线场景下重放旧码 → 拒绝并提示 CODE_ALREADY_USED
        _, off_replay = http_post("/api/mobile/emergency/verify", {"code": right_offline_code})
        assert_eq(off_replay["ok"], False, "Offline old code replay rejected")
        assert_eq(off_replay["errorCode"], "CODE_ALREADY_USED", "Offline replay returns CODE_ALREADY_USED")
        print("PASS [6/9] 23:30 电脑关机→01:00 开机断网离线取码、目标绑定与防重放通过")

        # 7. 并发/边界：自然结束与应急解锁同时发生
        http_post("/api/sim/network", {"pcPoweredOn": True, "lanConnected": True})
        http_post("/api/sim/time", {"action": "JUMP_NATURAL_END"})
        _, race_res = http_post("/api/mobile/emergency/verify", {"code": "123456"})
        assert_eq(race_res["ok"], False, "Verify after natural end returns clean failure")
        assert_eq(race_res["errorCode"], "SESSION_ALREADY_ENDED", "Returns SESSION_ALREADY_ENDED cleanly")
        print("PASS [7/9] 自然结束与应急解锁竞态一致性通过")

        # 8. 权限撤销告警 + 锁定中遗失电脑解绑 24 小时冷却
        http_post("/api/sim/reset", {"autoPair": True})
        http_post("/api/sim/start-in-one-minute", {"durationMinutes": 30})
        http_post("/api/sim/time", {"action": "JUMP_LOCK_START"})
        http_post("/api/mobile/permissions", {"overlay": False})
        st_perm = get_state()
        assert_eq(st_perm["mobile"]["live"]["status"], "PROTECTION_INTERRUPTED", "Mobile reports PROTECTION_INTERRUPTED")
        assert_eq(st_perm["desktop"]["snapshot"]["status"], "PROTECTION_INTERRUPTED", "Desktop synced permission warning")
        http_post("/api/mobile/permissions", {"overlay": True})

        _, lost_unbind = http_post("/api/pair/unbind", {"lostPc": True})
        assert_true(lost_unbind["ok"] and lost_unbind["deferred"], "Lost PC unbind during lock deferred with 24h cooldown")
        print("PASS [8/9] 权限撤销真实告警与锁定中遗失电脑 24 小时冷却通过")

        # 9. 白天试锁（3 分钟）闭环测试
        http_post("/api/sim/reset", {"autoPair": True})
        _, trial_start = http_post("/api/mobile/trial/start", {})
        assert_true(trial_start["ok"], "Start daytime trial")
        assert_eq(get_state("mobile")["mobile"]["live"]["status"], "TRIAL_LOCKED", "In TRIAL_LOCKED")
        http_post("/api/mobile/emergency/prepare", {"actionType": "END_TONIGHT", "targetAppId": None})
        _, trial_issue = http_post("/api/desktop/emergency/issue", {"actionType": "END_TONIGHT"})
        _, trial_end = http_post("/api/mobile/emergency/verify", {"code": trial_issue["issued"]["code"]})
        assert_true(trial_end["ok"], "End trial via desktop code")
        assert_eq(get_state("mobile")["mobile"]["onboarding"]["trialCompleted"], True, "Trial marked completed")
        print("PASS [9/9] 可跳过白天试锁闭环通过")

        # 重置回干净演示初始状态（预配对完成，方便用户打开即演或点击恢复首次安装）
        http_post("/api/sim/reset", {"autoPair": True})
        print("\n✅ 全部 9 组自动化验收测试全部通过！")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    run_all_tests()
