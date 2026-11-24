#!/usr/bin/env python3
"""
DormSleep 共享本地模拟服务 (Shared Local Mock Bridge)
---------------------------------------------------
职责：
1. 托管手机端 (/mobile/)、电脑端 (/desktop/) 与双端联调入口 (/) 的静态前端文件。
2. 维护两端共享的单一持久化状态 (mock-bridge/state.json)，确保手机端与电脑端操作同一次锁定会话。
3. 提供 REST API 与 Server-Sent Events (/api/events) 实时推送，模拟局域网同步与离线降级。
4. 使用标准密码学原语 (secrets CSPRNG, hashlib.sha256, hmac.HMAC + RFC 4226 截断)，与前端 shared/crypto.js 字节级一致。
"""

from __future__ import annotations

import hashlib
import hmac
import json
import mimetypes
import os
import queue
import secrets
import sys
import threading
import time
from datetime import datetime, timedelta
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

ROOT_DIR = Path(__file__).resolve().parent.parent
STATE_FILE = Path(__file__).resolve().parent / "state.json"

MANDATORY_APP_IDS = [
    "com.android.dialer",
    "com.android.mms",
    "com.android.deskclock",
]

DEFAULT_EXEMPT_APP_IDS = [
    "edu.campus.card",
    "com.auth.campus",
]

DEFAULT_RESTRICTED_APP_IDS = [
    "tv.danmaku.bili",
    "com.ss.android.ugc.aweme",
    "com.xingin.xhs",
    "com.tencent.tmgp.sgame",
]

TEMP_ALLOW_SECONDS = 20 * 60
FREEZE_SECONDS = 30 * 60
TRIAL_DURATION_SECONDS = 3 * 60
LOST_PC_COOLDOWN_SECONDS = 24 * 3600

# 无歧义字符集（去掉 0/O/1/I/L）
REQ_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


def generate_request_id() -> str:
    part1 = "".join(secrets.choice(REQ_ALPHABET) for _ in range(4))
    part2 = f"{secrets.randbelow(90) + 10}"
    return f"{part1}-{part2}"


def generate_pair_code() -> str:
    return "".join(secrets.choice("23456789ABCDEFGHJKMNPQRSTUVWXYZ") for _ in range(8))


def canonical_payload(
    pair_id: str,
    session_id: str,
    request_id: str,
    action_type: str,
    target_app_id: Optional[str],
) -> str:
    target = "ALL" if action_type == "END_TONIGHT" else (target_app_id or "ALL")
    return f"{pair_id}|{session_id}|{request_id.strip().upper()}|{action_type}|{target}"


def derive_offline_code(
    shared_secret: str,
    pair_id: str,
    session_id: str,
    request_id: str,
    action_type: str,
    target_app_id: Optional[str],
) -> str:
    msg = canonical_payload(pair_id, session_id, request_id, action_type, target_app_id)
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
    raw = f"{salt}|{code.strip()}|{payload}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def parse_hm(hm: str) -> Tuple[int, int]:
    parts = hm.strip().split(":")
    if len(parts) != 2:
        raise ValueError("时间格式必须为 HH:MM")
    h, m = int(parts[0]), int(parts[1])
    if not (0 <= h <= 23 and 0 <= m <= 59):
        raise ValueError("小时或分钟超出范围")
    return h, m


def night_key_for_ts(ts_ms: int) -> str:
    dt = datetime.fromtimestamp(ts_ms / 1000.0)
    if dt.hour < 12:
        dt = dt - timedelta(days=1)
    return dt.strftime("%Y-%m-%d")


def is_weekend_night(night_key: str) -> bool:
    # Python weekday(): Mon=0..Thu=3, Fri=4, Sat=5, Sun=6
    # 周五晚、周六晚为周末夜；周日至周四晚为上学夜（次日早八）
    dt = datetime.strptime(night_key, "%Y-%m-%d")
    return dt.weekday() in (4, 5)


def compute_window_for_night(night_key: str, start_hm: str, end_hm: str) -> Tuple[int, int]:
    """给定入睡夜日期键 (YYYY-MM-DD) 与起止时间，计算精确的开始/结束时间戳 (ms)。"""
    base_date = datetime.strptime(night_key, "%Y-%m-%d")
    sh, sm = parse_hm(start_hm)
    eh, em = parse_hm(end_hm)

    # 若开始时间在凌晨 00:00–11:59，则视为次日凌晨开始（归属该入睡夜）
    start_dt = base_date.replace(hour=sh, minute=sm, second=0, microsecond=0)
    if sh < 12:
        start_dt += timedelta(days=1)

    end_dt = base_date.replace(hour=eh, minute=em, second=0, microsecond=0)
    if end_dt <= start_dt:
        end_dt += timedelta(days=1)

    return int(start_dt.timestamp() * 1000), int(end_dt.timestamp() * 1000)


def next_night_key(night_key: str) -> str:
    dt = datetime.strptime(night_key, "%Y-%m-%d") + timedelta(days=1)
    return dt.strftime("%Y-%m-%d")


def default_state() -> Dict[str, Any]:
    now_ms = int(time.time() * 1000)
    nk = night_key_for_ts(now_ms)
    schedule = {
        "schoolNight": {"enabled": True, "start": "23:30", "end": "07:00"},
        "weekendNight": {"enabled": True, "start": "00:30", "end": "09:00"},
        "preReminderMinutes": 10,
    }
    plan = schedule["weekendNight"] if is_weekend_night(nk) else schedule["schoolNight"]
    base_start, base_end = compute_window_for_night(nk, plan["start"], plan["end"])

    return {
        "version": 1,
        "sim": {
            "timeOffsetMs": 0,
            "lanConnected": True,
            "pcPoweredOn": True,
            "mobileRebootCount": 0,
        },
        "pairing": {
            "status": "UNPAIRED",  # UNPAIRED | PENDING | PAIRED
            "pairId": None,
            "sharedSecret": None,
            "pendingPairCode": None,
            "pendingExpiresAt": None,
            "mobileName": "Android 宿舍手机（模拟）",
            "desktopName": "Windows 宿舍笔记本（模拟）",
            "pairedAt": None,
            "lostPcUnbindRequestedAt": None,
            "lostPcUnbindEffectiveAt": None,
        },
        "onboarding": {
            "completed": False,
            "trialCompleted": False,
            "trialSkipped": False,
            "morningChecklistConfirmed": False,
        },
        "permissions": {
            "usageStats": True,
            "overlay": True,
            "exactAlarm": True,
            "batteryIgnore": True,
        },
        "schedule": schedule,
        "apps": {
            "restrictedAppIds": list(DEFAULT_RESTRICTED_APP_IDS),
            "exemptAppIds": list(DEFAULT_EXEMPT_APP_IDS),
        },
        "pendingNextNight": {
            "schedule": None,
            "restrictedAppIds": None,
            "exemptAppIds": None,
        },
        "tonightOverride": None,
        # { nightKey, mode: 'CUSTOM_TIME'|'PAUSE_TONIGHT', start, end, createdAt, nextRegularResumeAt }
        "nightSession": {
            "nightKey": nk,
            "sessionId": f"night:{nk}",
            "baselineStartAt": base_start,
            "baselineEndAt": base_end,
            "freezeCutoffAt": base_start - FREEZE_SECONDS * 1000,
            "startAt": base_start,
            "endAt": base_end,
            "enabled": plan["enabled"],
            "effectiveRestrictedAppIds": list(DEFAULT_RESTRICTED_APP_IDS),
            "effectiveExemptAppIds": list(DEFAULT_EXEMPT_APP_IDS),
            "status": "IDLE",
            "endedEarlyAt": None,
            "naturalEndedAt": None,
            "tempAllow": None,
            # { appId, startedAt, expiresAt, requestId }
            "preReminderLogged": False,
            "lockStartedLogged": False,
            "tempAllowOneMinWarned": False,
        },
        "trialSession": None,
        # { seq, sessionId, startedAt, endAt, tempAllow }
        "trialCounter": 0,
        "mobileForegroundAppId": None,
        "emergency": {
            "activeRequest": None,
            # { requestId, sessionId, actionType, targetAppId, createdAt, expiresAt }
            "desktopIssued": None,
            # { requestId, sessionId, actionType, targetAppId, plaintextCode, salt, codeHash, issuedAt }
            "wrongAttempts": 0,
            "cooldownUntil": None,
            "consumedRequests": [],
            # [{ requestId, sessionId, actionType, targetAppId, consumedAt, mode, codeSha }]
            "invalidatedRequests": [],
            # [{ requestId, sessionId, actionType, targetAppId, invalidatedAt, reason, codeSha }]
        },
        "lastDesktopSyncedSnapshot": None,
        "events": [],
    }


class DormSleepStore:
    def __init__(self, state_path: Path):
        self.state_path = state_path
        self.lock = threading.RLock()
        self.subscribers: List[queue.Queue] = []
        self.state = self._load_state()
        self.tick_and_sync(broadcast=False)

    def _load_state(self) -> Dict[str, Any]:
        if self.state_path.exists():
            try:
                with self.state_path.open("r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict) and data.get("version") == 1:
                    return data
            except Exception:
                pass
        st = default_state()
        self._save_state_unlocked(st)
        return st

    def _save_state_unlocked(self, st: Optional[Dict[str, Any]] = None) -> None:
        target = st if st is not None else self.state
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.state_path.with_suffix(".tmp")
        with tmp.open("w", encoding="utf-8") as f:
            json.dump(target, f, ensure_ascii=False, indent=2)
        os.replace(tmp, self.state_path)

    def now_ms(self) -> int:
        return int(time.time() * 1000) + int(self.state["sim"]["timeOffsetMs"])

    def _log_event(self, kind: str, message: str, now_ms: Optional[int] = None, meta: Optional[Dict[str, Any]] = None) -> None:
        ts = now_ms if now_ms is not None else self.now_ms()
        entry = {
            "id": f"evt_{ts}_{secrets.token_hex(3)}",
            "ts": ts,
            "kind": kind,
            "message": message,
            "meta": meta or {},
        }
        self.state["events"].insert(0, entry)
        self.state["events"] = self.state["events"][:80]

    def _compute_next_regular_resume_at(self, current_nk: str) -> int:
        nxt = next_night_key(current_nk)
        sched = self.state["pendingNextNight"]["schedule"] or self.state["schedule"]
        plan = sched["weekendNight"] if is_weekend_night(nxt) else sched["schoolNight"]
        start_at, _ = compute_window_for_night(nxt, plan["start"], plan["end"])
        return start_at

    def _rollover_night_if_needed(self, now_ms: int) -> bool:
        current_nk = night_key_for_ts(now_ms)
        ns = self.state["nightSession"]
        if ns["nightKey"] == current_nk:
            return False

        # 应用待下一晚生效的常规计划与应用名单
        pending = self.state["pendingNextNight"]
        if pending["schedule"]:
            self.state["schedule"] = pending["schedule"]
            pending["schedule"] = None
        if pending["restrictedAppIds"] is not None:
            self.state["apps"]["restrictedAppIds"] = list(pending["restrictedAppIds"])
            pending["restrictedAppIds"] = None
        if pending["exemptAppIds"] is not None:
            self.state["apps"]["exemptAppIds"] = list(pending["exemptAppIds"])
            pending["exemptAppIds"] = None

        # 清理上一晚的「仅改今晚」覆盖
        self.state["tonightOverride"] = None

        plan = self.state["schedule"]["weekendNight"] if is_weekend_night(current_nk) else self.state["schedule"]["schoolNight"]
        base_start, base_end = compute_window_for_night(current_nk, plan["start"], plan["end"])
        self.state["nightSession"] = {
            "nightKey": current_nk,
            "sessionId": f"night:{current_nk}",
            "baselineStartAt": base_start,
            "baselineEndAt": base_end,
            "freezeCutoffAt": base_start - FREEZE_SECONDS * 1000,
            "startAt": base_start,
            "endAt": base_end,
            "enabled": plan["enabled"],
            "effectiveRestrictedAppIds": list(self.state["apps"]["restrictedAppIds"]),
            "effectiveExemptAppIds": list(self.state["apps"]["exemptAppIds"]),
            "status": "IDLE",
            "endedEarlyAt": None,
            "naturalEndedAt": None,
            "tempAllow": None,
            "preReminderLogged": False,
            "lockStartedLogged": False,
            "tempAllowOneMinWarned": False,
        }
        # 新一晚清理旧会话活动请求与临时发码（保留历史消费记录防重放）
        self.state["emergency"]["activeRequest"] = None
        self.state["emergency"]["desktopIssued"] = None
        self.state["emergency"]["wrongAttempts"] = 0
        self.state["emergency"]["cooldownUntil"] = None
        self._log_event("NIGHT_ROLLOVER", f"进入新夜晚周期（{current_nk}），常规计划与待生效改动已自动应用。", now_ms)
        return True

    def _is_permissions_ok(self) -> bool:
        p = self.state["permissions"]
        return bool(p.get("usageStats") and p.get("overlay") and p.get("exactAlarm"))

    def _ensure_active_request(self, session_id: str, expires_at: int, preferred_action: str = "TEMP_ALLOW_15M", preferred_app: Optional[str] = None, now_ms: Optional[int] = None) -> Dict[str, Any]:
        ts = now_ms if now_ms is not None else self.now_ms()
        em = self.state["emergency"]
        cur = em["activeRequest"]

        restricted = self._effective_restricted_apps()
        default_app = preferred_app
        if preferred_action == "TEMP_ALLOW_15M":
            if not default_app or default_app not in restricted:
                fg = self.state["mobileForegroundAppId"]
                default_app = fg if fg in restricted else (restricted[0] if restricted else "tv.danmaku.bili")
        else:
            default_app = None

        if cur and cur["sessionId"] == session_id:
            return cur

        req = {
            "requestId": generate_request_id(),
            "sessionId": session_id,
            "actionType": preferred_action,
            "targetAppId": default_app,
            "createdAt": ts,
            "expiresAt": expires_at,
        }
        em["activeRequest"] = req
        em["desktopIssued"] = None
        return req

    def _invalidate_current_request(self, reason: str, now_ms: int) -> None:
        em = self.state["emergency"]
        cur = em["activeRequest"]
        if not cur:
            return
        issued = em["desktopIssued"]
        code_sha = None
        if issued and issued["requestId"] == cur["requestId"]:
            code_sha = hashlib.sha256(issued["plaintextCode"].encode("utf-8")).hexdigest()
        em["invalidatedRequests"].insert(0, {
            "requestId": cur["requestId"],
            "sessionId": cur["sessionId"],
            "actionType": cur["actionType"],
            "targetAppId": cur["targetAppId"],
            "invalidatedAt": now_ms,
            "reason": reason,
            "codeSha": code_sha,
        })
        em["invalidatedRequests"] = em["invalidatedRequests"][:100]
        em["activeRequest"] = None
        em["desktopIssued"] = None

    def _effective_restricted_apps(self) -> List[str]:
        return list(self.state["nightSession"]["effectiveRestrictedAppIds"])

    def _is_frozen(self, now_ms: int) -> bool:
        ns = self.state["nightSession"]
        if ns["status"] in ("LOCKED", "TEMP_ALLOW"):
            return True
        if not ns["enabled"]:
            return False
        if ns["status"] in ("ENDED_EARLY", "NATURAL_ENDED", "PAUSED_TONIGHT"):
            return False
        return now_ms >= ns["freezeCutoffAt"] and now_ms < ns["endAt"]

    def _evaluate_state_unlocked(self) -> bool:
        now_ms = self.now_ms()
        changed = False

        if self._rollover_night_if_needed(now_ms):
            changed = True

        # 检查遗失电脑解绑冷却是否到期
        pairing = self.state["pairing"]
        if pairing.get("lostPcUnbindEffectiveAt") and now_ms >= pairing["lostPcUnbindEffectiveAt"]:
            pairing["status"] = "UNPAIRED"
            pairing["pairId"] = None
            pairing["sharedSecret"] = None
            pairing["pairedAt"] = None
            pairing["lostPcUnbindRequestedAt"] = None
            pairing["lostPcUnbindEffectiveAt"] = None
            self._log_event("PAIR_UNBOUND", "遗失电脑解绑冷却期已满，已完成解绑。", now_ms)
            changed = True

        # 检查临时配对码是否过期
        if pairing["status"] == "PENDING" and pairing["pendingExpiresAt"] and now_ms >= pairing["pendingExpiresAt"]:
            pairing["status"] = "UNPAIRED"
            pairing["pendingPairCode"] = None
            pairing["pendingExpiresAt"] = None
            changed = True

        # 检查白天试锁是否到期
        trial = self.state["trialSession"]
        if trial:
            if trial.get("tempAllow") and now_ms >= trial["tempAllow"]["expiresAt"]:
                expired_app = trial["tempAllow"]["appId"]
                trial["tempAllow"] = None
                self._log_event("TRIAL_ALLOW_EXPIRED", f"白天试锁临时放行（{expired_app}）到期，已恢复试锁拦截。", now_ms)
                changed = True
            if now_ms >= trial["endAt"]:
                self._invalidate_current_request("试锁自然结束", now_ms)
                self.state["trialSession"] = None
                self.state["onboarding"]["trialCompleted"] = True
                self._log_event("TRIAL_ENDED", "白天试锁（3 分钟）已自动结束并恢复正常。", now_ms)
                changed = True

        # 正式夜晚状态机推进
        ns = self.state["nightSession"]
        override = self.state["tonightOverride"]
        if override and override["mode"] == "PAUSE_TONIGHT" and override["nightKey"] == ns["nightKey"]:
            if ns["status"] != "PAUSED_TONIGHT":
                ns["status"] = "PAUSED_TONIGHT"
                changed = True
        elif not ns["enabled"]:
            if ns["status"] != "IDLE":
                ns["status"] = "IDLE"
                changed = True
        else:
            pre_ms = int(self.state["schedule"]["preReminderMinutes"]) * 60 * 1000
            if ns["status"] in ("ENDED_EARLY", "NATURAL_ENDED"):
                # 若时间退回到开始之前（仅开发调试重置场景），允许回到 IDLE
                if now_ms < ns["startAt"] - pre_ms:
                    ns["status"] = "IDLE"
                    ns["endedEarlyAt"] = None
                    ns["naturalEndedAt"] = None
                    changed = True
            else:
                if now_ms >= ns["endAt"]:
                    # 自然结束（优先级高于任何临时放行）
                    if ns["status"] != "NATURAL_ENDED":
                        ns["status"] = "NATURAL_ENDED"
                        ns["naturalEndedAt"] = ns["endAt"]
                        ns["tempAllow"] = None
                        self._invalidate_current_request("锁定自然结束", now_ms)
                        self._log_event("NATURAL_ENDED", "已到预设结束时间，手机限制自动解除，所有应用恢复可用。", now_ms)
                        changed = True
                elif now_ms >= ns["startAt"]:
                    # 在夜间限制窗口内
                    if not ns["lockStartedLogged"]:
                        ns["lockStartedLogged"] = True
                        fg = self.state["mobileForegroundAppId"]
                        extra = "（检测到正停留在受限应用内，已立即弹出拦截页）" if fg in ns["effectiveRestrictedAppIds"] else ""
                        self._log_event("LOCK_STARTED", f"夜间限制自动生效（无需二次确认）{extra}。", now_ms)
                        changed = True

                    # 检查 20 分钟临时放行
                    ta = ns.get("tempAllow")
                    if ta:
                        if now_ms >= ta["expiresAt"]:
                            app_id = ta["appId"]
                            ns["tempAllow"] = None
                            ns["tempAllowOneMinWarned"] = False
                            ns["status"] = "LOCKED"
                            fg = self.state["mobileForegroundAppId"]
                            extra = "（当前正停留在该应用内，已立即拉起拦截页）" if fg == app_id else ""
                            self._log_event("TEMP_ALLOW_EXPIRED", f"20 分钟临时放行到期，已自动恢复拦截{extra}。", now_ms)
                            changed = True
                        else:
                            if not ns["tempAllowOneMinWarned"] and (ta["expiresAt"] - now_ms) <= 60 * 1000:
                                ns["tempAllowOneMinWarned"] = True
                                self._log_event("TEMP_ALLOW_WARNING", "临时放行还剩不足 1 分钟，即将自动恢复拦截。", now_ms)
                                changed = True
                            if ns["status"] != "TEMP_ALLOW":
                                ns["status"] = "TEMP_ALLOW"
                                changed = True
                    else:
                        if ns["status"] != "LOCKED":
                            ns["status"] = "LOCKED"
                            changed = True

                    # 确保存在当前会话的唯一应急请求
                    if not self.state["trialSession"] and ns["status"] in ("LOCKED", "TEMP_ALLOW"):
                        cur = self.state["emergency"]["activeRequest"]
                        if not cur or cur["sessionId"] != ns["sessionId"]:
                            self._ensure_active_request(ns["sessionId"], ns["endAt"], "TEMP_ALLOW_15M", None, now_ms)
                            changed = True
                elif now_ms >= ns["startAt"] - pre_ms:
                    if ns["status"] != "PRE_LOCK_REMINDER":
                        ns["status"] = "PRE_LOCK_REMINDER"
                        if not ns["preReminderLogged"]:
                            ns["preReminderLogged"] = True
                            self._log_event(
                                "PRE_LOCK_REMINDER",
                                f"距离夜间限制还有 {self.state['schedule']['preReminderMinutes']} 分钟，请准备收尾。",
                                now_ms,
                            )
                        changed = True
                else:
                    if ns["status"] != "IDLE":
                        ns["status"] = "IDLE"
                        changed = True

        # 如果试锁正在运行，确保试锁有活动请求
        if self.state["trialSession"]:
            tsess = self.state["trialSession"]
            cur = self.state["emergency"]["activeRequest"]
            if not cur or cur["sessionId"] != tsess["sessionId"]:
                self._ensure_active_request(tsess["sessionId"], tsess["endAt"], "TEMP_ALLOW_15M", None, now_ms)
                changed = True

        # 若当前局域网在线且电脑开机，刷新电脑端的同步快照
        if self.state["sim"]["lanConnected"] and self.state["sim"]["pcPoweredOn"]:
            self.state["lastDesktopSyncedSnapshot"] = self._build_live_shared_snapshot(now_ms)

        if changed:
            self._save_state_unlocked()
        return changed

    def _build_live_shared_snapshot(self, now_ms: int) -> Dict[str, Any]:
        ns = self.state["nightSession"]
        trial = self.state["trialSession"]
        perms_ok = self._is_permissions_ok()
        active_mode = "TRIAL" if trial else "NIGHT"

        if not perms_ok and (trial or ns["status"] in ("LOCKED", "TEMP_ALLOW")):
            effective_status = "PROTECTION_INTERRUPTED"
        elif trial:
            effective_status = "TEMP_ALLOW" if trial.get("tempAllow") else "TRIAL_LOCKED"
        else:
            effective_status = ns["status"]

        active_temp_allow = trial.get("tempAllow") if trial else ns.get("tempAllow")
        session_id = trial["sessionId"] if trial else ns["sessionId"]
        session_start = trial["startedAt"] if trial else ns["startAt"]
        session_end = trial["endAt"] if trial else ns["endAt"]

        em = self.state["emergency"]
        active_req = em["activeRequest"]
        issued = em["desktopIssued"]

        return {
            "syncedAt": now_ms,
            "activeMode": active_mode,
            "sessionId": session_id,
            "nightKey": ns["nightKey"],
            "status": effective_status,
            "rawNightStatus": ns["status"],
            "permissionsOk": perms_ok,
            "permissions": dict(self.state["permissions"]),
            "startAt": session_start,
            "endAt": session_end,
            "baselineStartAt": ns["baselineStartAt"],
            "freezeCutoffAt": ns["freezeCutoffAt"],
            "isFrozen": self._is_frozen(now_ms),
            "tempAllow": active_temp_allow,
            "tonightOverride": self.state["tonightOverride"],
            "nextRegularResumeAt": self._compute_next_regular_resume_at(ns["nightKey"]),
            "effectiveRestrictedAppIds": list(ns["effectiveRestrictedAppIds"]),
            "effectiveExemptAppIds": list(ns["effectiveExemptAppIds"]),
            "activeRequest": dict(active_req) if active_req else None,
            "hasOnlineIssuedCode": bool(issued and active_req and issued["requestId"] == active_req["requestId"]),
            "wrongAttempts": em["wrongAttempts"],
            "cooldownUntil": em["cooldownUntil"],
            "consumedCount": len(em["consumedRequests"]),
            "recentConsumed": em["consumedRequests"][:10],
            "events": self.state["events"][:25],
        }

    def get_public_state(self, client: str = "all") -> Dict[str, Any]:
        with self.lock:
            self._evaluate_state_unlocked()
            now_ms = self.now_ms()
            live = self._build_live_shared_snapshot(now_ms)
            ns = self.state["nightSession"]
            trial = self.state["trialSession"]
            fg = self.state["mobileForegroundAppId"]
            ta = live["tempAllow"]

            # 判定手机端当前是否应弹出全屏拦截页（包含“到点时已停留在受限应用内”）
            in_restricted_window = live["status"] in ("LOCKED", "TEMP_ALLOW", "TRIAL_LOCKED") and live["permissionsOk"]
            fg_is_restricted = bool(fg and fg in ns["effectiveRestrictedAppIds"])
            fg_is_temp_allowed = bool(ta and ta["appId"] == fg and now_ms < ta["expiresAt"])
            should_show_overlay = bool(in_restricted_window and fg_is_restricted and not fg_is_temp_allowed)

            # 电脑端视图：在线看实时，离线/关机时只看上次同步快照（真实模拟断连状态！）
            lan_on = bool(self.state["sim"]["lanConnected"])
            pc_on = bool(self.state["sim"]["pcPoweredOn"])
            desktop_connected = lan_on and pc_on

            em = self.state["emergency"]
            desktop_issued_public = None
            if desktop_connected and em["desktopIssued"] and em["activeRequest"]:
                if em["desktopIssued"]["requestId"] == em["activeRequest"]["requestId"]:
                    desktop_issued_public = {
                        "requestId": em["desktopIssued"]["requestId"],
                        "sessionId": em["desktopIssued"]["sessionId"],
                        "actionType": em["desktopIssued"]["actionType"],
                        "targetAppId": em["desktopIssued"]["targetAppId"],
                        "code": em["desktopIssued"]["plaintextCode"],
                        "issuedAt": em["desktopIssued"]["issuedAt"],
                    }

            # 安全隔离：mobileView 绝对不包含 plaintextCode，也不向 UI 暴露 sharedSecret！
            pairing = self.state["pairing"]
            mobile_view = {
                "nowMs": now_ms,
                "live": live,
                "schedule": self.state["schedule"],
                "apps": self.state["apps"],
                "pendingNextNight": self.state["pendingNextNight"],
                "onboarding": self.state["onboarding"],
                "permissions": self.state["permissions"],
                "foregroundAppId": fg,
                "shouldShowOverlay": should_show_overlay,
                "lanConnected": desktop_connected,
                "pairing": {
                    "status": pairing["status"],
                    "pairId": pairing["pairId"],
                    "desktopName": pairing["desktopName"],
                    "pairedAt": pairing["pairedAt"],
                    "lostPcUnbindRequestedAt": pairing["lostPcUnbindRequestedAt"],
                    "lostPcUnbindEffectiveAt": pairing["lostPcUnbindEffectiveAt"],
                },
                "consumedRequests": em["consumedRequests"][:15],
                "invalidatedCount": len(em["invalidatedRequests"]),
            }

            # 电脑端保留本地 DPAPI 模拟的 sharedSecret 用于完全离线 HMAC 计算（仅电脑端可见）
            desktop_view = {
                "nowMs": now_ms,
                "pcPoweredOn": pc_on,
                "lanConnected": lan_on,
                "connected": desktop_connected,
                "snapshot": live if desktop_connected else self.state["lastDesktopSyncedSnapshot"],
                "issuedCode": desktop_issued_public,
                "pairing": {
                    "status": pairing["status"],
                    "pairId": pairing["pairId"],
                    "pendingPairCode": pairing["pendingPairCode"],
                    "pendingExpiresAt": pairing["pendingExpiresAt"],
                    "mobileName": pairing["mobileName"],
                    "desktopName": pairing["desktopName"],
                    "pairedAt": pairing["pairedAt"],
                    # 仅用于电脑端浏览器本地 Web Crypto 离线 HMAC 派生（模拟 Windows DPAPI 本地密钥存储）
                    "offlineSharedSecret": pairing["sharedSecret"] if pairing["status"] == "PAIRED" else None,
                },
                "knownRestrictedAppIds": list(ns["effectiveRestrictedAppIds"]),
            }

            resp: Dict[str, Any] = {
                "nowMs": now_ms,
                "sim": dict(self.state["sim"]),
            }
            if client == "mobile":
                resp["mobile"] = mobile_view
            elif client == "desktop":
                resp["desktop"] = desktop_view
            else:
                resp["mobile"] = mobile_view
                resp["desktop"] = desktop_view
            return resp

    def broadcast(self, event_name: str = "state") -> None:
        payload = json.dumps({"type": event_name, "ts": self.now_ms()}, ensure_ascii=False)
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

    def tick_and_sync(self, broadcast: bool = True) -> bool:
        with self.lock:
            changed = self._evaluate_state_unlocked()
        if changed and broadcast:
            self.broadcast("tick")
        return changed

    # ---------------- 业务操作 ----------------

    def start_pairing(self) -> Dict[str, Any]:
        with self.lock:
            now_ms = self.now_ms()
            code = generate_pair_code()
            self.state["pairing"]["status"] = "PENDING"
            self.state["pairing"]["pendingPairCode"] = code
            self.state["pairing"]["pendingExpiresAt"] = now_ms + 3 * 60 * 1000
            self._log_event("PAIR_STARTED", f"电脑端生成一次性配对码（3 分钟有效）。", now_ms)
            self._save_state_unlocked()
        self.broadcast("pair_start")
        return {"ok": True, "pairCode": code, "expiresAt": now_ms + 3 * 60 * 1000}

    def confirm_pairing(self, pair_code: str, mobile_name: Optional[str] = None) -> Dict[str, Any]:
        with self.lock:
            now_ms = self.now_ms()
            p = self.state["pairing"]
            if p["status"] != "PENDING" or not p["pendingPairCode"]:
                return {"ok": False, "errorCode": "PAIR_CODE_INVALID"}
            if p["pendingExpiresAt"] and now_ms > p["pendingExpiresAt"]:
                return {"ok": False, "errorCode": "PAIR_CODE_INVALID"}
            if pair_code.strip().upper() != p["pendingPairCode"]:
                return {"ok": False, "errorCode": "PAIR_CODE_INVALID"}

            p["status"] = "PAIRED"
            p["pairId"] = f"pair_{secrets.token_hex(6)}"
            p["sharedSecret"] = secrets.token_hex(32)  # 256-bit 标准随机密钥
            p["pendingPairCode"] = None
            p["pendingExpiresAt"] = None
            p["pairedAt"] = now_ms
            if mobile_name:
                p["mobileName"] = mobile_name
            p["lostPcUnbindRequestedAt"] = None
            p["lostPcUnbindEffectiveAt"] = None
            self._log_event("PAIR_CONFIRMED", "手机与电脑配对成功，已建立本地安全密钥。", now_ms)
            self._evaluate_state_unlocked()
            self._save_state_unlocked()
        self.broadcast("pair_confirmed")
        return {"ok": True, "pairId": self.state["pairing"]["pairId"]}

    def unbind_pairing(self, lost_pc: bool = False) -> Dict[str, Any]:
        with self.lock:
            self._evaluate_state_unlocked()
            now_ms = self.now_ms()
            ns = self.state["nightSession"]
            in_lock = bool(self.state["trialSession"] or ns["status"] in ("LOCKED", "TEMP_ALLOW"))
            p = self.state["pairing"]

            if in_lock:
                # 锁定期间不可直接解绑，进入 24 小时冷却或待本次锁定结束
                cooldown_end = min(now_ms + LOST_PC_COOLDOWN_SECONDS * 1000, ns["endAt"]) if not lost_pc else now_ms + LOST_PC_COOLDOWN_SECONDS * 1000
                p["lostPcUnbindRequestedAt"] = now_ms
                p["lostPcUnbindEffectiveAt"] = cooldown_end
                self._log_event("PAIR_UNBIND_COOLDOWN", "锁定期间发起遗失电脑解绑，已进入 24 小时冷却期（防一键跳过）。", now_ms)
                self._save_state_unlocked()
                result = {"ok": True, "deferred": True, "effectiveAt": cooldown_end}
            else:
                p["status"] = "UNPAIRED"
                p["pairId"] = None
                p["sharedSecret"] = None
                p["pairedAt"] = None
                p["lostPcUnbindRequestedAt"] = None
                p["lostPcUnbindEffectiveAt"] = None
                self._log_event("PAIR_UNBOUND", "已解除与电脑的配对绑定。", now_ms)
                self._save_state_unlocked()
                result = {"ok": True, "deferred": False}
        self.broadcast("pair_unbind")
        return result

    def complete_onboarding(self, morning_checklist_confirmed: bool = True) -> Dict[str, Any]:
        with self.lock:
            now_ms = self.now_ms()
            self.state["onboarding"]["completed"] = True
            self.state["onboarding"]["morningChecklistConfirmed"] = bool(morning_checklist_confirmed)
            self._log_event("ONBOARDING_DONE", "已完成首次配置与明早必用清单核对。", now_ms)
            self._save_state_unlocked()
        self.broadcast("onboarding")
        return {"ok": True}

    def update_schedule(self, school_night: Dict[str, Any], weekend_night: Dict[str, Any], pre_reminder_minutes: int) -> Dict[str, Any]:
        with self.lock:
            self._evaluate_state_unlocked()
            now_ms = self.now_ms()
            # 校验时间格式
            parse_hm(school_night["start"])
            parse_hm(school_night["end"])
            parse_hm(weekend_night["start"])
            parse_hm(weekend_night["end"])

            new_sched = {
                "schoolNight": {
                    "enabled": bool(school_night["enabled"]),
                    "start": school_night["start"],
                    "end": school_night["end"],
                },
                "weekendNight": {
                    "enabled": bool(weekend_night["enabled"]),
                    "start": weekend_night["start"],
                    "end": weekend_night["end"],
                },
                "preReminderMinutes": max(1, min(30, int(pre_reminder_minutes))),
            }

            frozen = self._is_frozen(now_ms)
            if frozen:
                self.state["pendingNextNight"]["schedule"] = new_sched
                self._log_event("SCHEDULE_DEFERRED", "已过今晚修改截止时间，常规计划修改已保存，将于下一晚生效。", now_ms)
                deferred = True
            else:
                self.state["schedule"] = new_sched
                self.state["pendingNextNight"]["schedule"] = None
                # 未过截止时间时，若无「仅改今晚」覆盖，同步更新今晚的起止时间，但固定截止时间绝不往后延！
                ns = self.state["nightSession"]
                if not self.state["tonightOverride"]:
                    plan = new_sched["weekendNight"] if is_weekend_night(ns["nightKey"]) else new_sched["schoolNight"]
                    new_start, new_end = compute_window_for_night(ns["nightKey"], plan["start"], plan["end"])
                    ns["startAt"] = new_start
                    ns["endAt"] = new_end
                    ns["enabled"] = plan["enabled"]
                    # 关键规则：固定当晚修改截止时间，不能通过推迟计划延长截止窗口！
                    ns["freezeCutoffAt"] = min(ns["freezeCutoffAt"], new_start - FREEZE_SECONDS * 1000)
                self._log_event("SCHEDULE_UPDATED", "常规就寝计划已更新并生效。", now_ms)
                deferred = False

            self._evaluate_state_unlocked()
            self._save_state_unlocked()
        self.broadcast("schedule")
        return {"ok": True, "deferredToNextNight": deferred}

    def apply_tonight_override(self, mode: str, start: Optional[str] = None, end: Optional[str] = None) -> Dict[str, Any]:
        with self.lock:
            self._evaluate_state_unlocked()
            now_ms = self.now_ms()
            ns = self.state["nightSession"]
            if self._is_frozen(now_ms):
                return {"ok": False, "errorCode": "FROZEN_MODIFICATION"}

            next_resume = self._compute_next_regular_resume_at(ns["nightKey"])

            if mode == "CLEAR":
                self.state["tonightOverride"] = None
                plan = self.state["schedule"]["weekendNight"] if is_weekend_night(ns["nightKey"]) else self.state["schedule"]["schoolNight"]
                s_at, e_at = compute_window_for_night(ns["nightKey"], plan["start"], plan["end"])
                ns["startAt"] = s_at
                ns["endAt"] = e_at
                ns["enabled"] = plan["enabled"]
                if ns["status"] == "PAUSED_TONIGHT":
                    ns["status"] = "IDLE"
                self._log_event("TONIGHT_OVERRIDE_CLEARED", "已撤销「仅改今晚」，恢复今晚常规计划。", now_ms)
            elif mode == "PAUSE_TONIGHT":
                self.state["tonightOverride"] = {
                    "nightKey": ns["nightKey"],
                    "mode": "PAUSE_TONIGHT",
                    "start": None,
                    "end": None,
                    "createdAt": now_ms,
                    "nextRegularResumeAt": next_resume,
                }
                ns["status"] = "PAUSED_TONIGHT"
                self._log_event("TONIGHT_PAUSED", "已设置「仅改今晚：暂停今晚一次」，明晚自动恢复常规计划。", now_ms)
            elif mode == "CUSTOM_TIME":
                if not start or not end:
                    return {"ok": False, "errorCode": "INVALID_TIME"}
                s_at, e_at = compute_window_for_night(ns["nightKey"], start, end)
                self.state["tonightOverride"] = {
                    "nightKey": ns["nightKey"],
                    "mode": "CUSTOM_TIME",
                    "start": start,
                    "end": end,
                    "createdAt": now_ms,
                    "nextRegularResumeAt": next_resume,
                }
                ns["startAt"] = s_at
                ns["endAt"] = e_at
                ns["enabled"] = True
                # 关键规则 1：固定当晚修改截止时间，推迟开始时间绝不延长 freezeCutoffAt！
                ns["freezeCutoffAt"] = min(ns["freezeCutoffAt"], s_at - FREEZE_SECONDS * 1000)
                if ns["status"] == "PAUSED_TONIGHT":
                    ns["status"] = "IDLE"
                self._log_event("TONIGHT_CUSTOMIZED", f"已设置「仅改今晚」：{start}–{end}（截止修改时间仍固定不变，明晚恢复常规计划）。", now_ms)
            else:
                return {"ok": False, "errorCode": "INVALID_MODE"}

            self._evaluate_state_unlocked()
            self._save_state_unlocked()
        self.broadcast("tonight_override")
        return {"ok": True, "nextRegularResumeAt": next_resume}

    def update_apps(self, restricted_ids: List[str], exempt_ids: List[str]) -> Dict[str, Any]:
        with self.lock:
            self._evaluate_state_unlocked()
            now_ms = self.now_ms()
            # 强制豁免的系统应用绝不允许进入受限名单
            clean_restricted = [aid for aid in dict.fromkeys(restricted_ids) if aid not in MANDATORY_APP_IDS]
            clean_exempt = [aid for aid in dict.fromkeys(exempt_ids) if aid not in clean_restricted]

            ns = self.state["nightSession"]
            frozen = self._is_frozen(now_ms)

            if frozen:
                # 冻结期/锁定中：放宽限制（移除受限应用或加入豁免）推迟到下一晚生效；
                # 新增受限应用（收紧）可立即加入今晚生效列表！
                cur_eff_restricted = set(ns["effectiveRestrictedAppIds"])
                new_restricted_set = set(clean_restricted)
                removed_apps = cur_eff_restricted - new_restricted_set
                added_apps = new_restricted_set - cur_eff_restricted

                # 收紧限制立即生效
                if added_apps:
                    ns["effectiveRestrictedAppIds"] = list(cur_eff_restricted | added_apps)

                # 若有放宽（移除受限应用或改动豁免），保存到 pendingNextNight，今晚保持不放宽
                if removed_apps or set(clean_exempt) != set(ns["effectiveExemptAppIds"]):
                    self.state["pendingNextNight"]["restrictedAppIds"] = clean_restricted
                    self.state["pendingNextNight"]["exemptAppIds"] = clean_exempt
                    self._log_event(
                        "APPS_RELAX_DEFERRED",
                        f"已进入今晚冻结期，移除受限/改为豁免等放宽调整将于下一晚生效（今晚仍保持拦截）。",
                        now_ms,
                    )
                    deferred = True
                else:
                    self.state["apps"]["restrictedAppIds"] = clean_restricted
                    self.state["apps"]["exemptAppIds"] = clean_exempt
                    self._log_event("APPS_TIGHTENED", "新增受限应用已立即生效。", now_ms)
                    deferred = False
            else:
                self.state["apps"]["restrictedAppIds"] = clean_restricted
                self.state["apps"]["exemptAppIds"] = clean_exempt
                ns["effectiveRestrictedAppIds"] = list(clean_restricted)
                ns["effectiveExemptAppIds"] = list(clean_exempt)
                self.state["pendingNextNight"]["restrictedAppIds"] = None
                self.state["pendingNextNight"]["exemptAppIds"] = None
                self._log_event("APPS_UPDATED", "受限娱乐应用与必要豁免应用列表已更新。", now_ms)
                deferred = False

            self._evaluate_state_unlocked()
            self._save_state_unlocked()
        self.broadcast("apps")
        return {"ok": True, "deferredToNextNight": deferred}

    def update_permissions(self, patch: Dict[str, bool]) -> Dict[str, Any]:
        with self.lock:
            now_ms = self.now_ms()
            was_ok = self._is_permissions_ok()
            for k in ("usageStats", "overlay", "exactAlarm", "batteryIgnore"):
                if k in patch:
                    self.state["permissions"][k] = bool(patch[k])
            now_ok = self._is_permissions_ok()
            if was_ok and not now_ok:
                self._log_event("PERMISSION_REVOKED", "检测到关键系统权限被撤销，当前保护已中断！", now_ms)
            elif not was_ok and now_ok:
                self._log_event("PERMISSION_RESTORED", "关键系统权限已恢复，夜间保护重新生效。", now_ms)
            self._evaluate_state_unlocked()
            self._save_state_unlocked()
        self.broadcast("permissions")
        return {"ok": True, "permissionsOk": now_ok}

    def start_trial(self) -> Dict[str, Any]:
        with self.lock:
            now_ms = self.now_ms()
            self.state["trialCounter"] += 1
            seq = self.state["trialCounter"]
            sess_id = f"trial:{seq}"
            end_at = now_ms + TRIAL_DURATION_SECONDS * 1000
            self.state["trialSession"] = {
                "seq": seq,
                "sessionId": sess_id,
                "startedAt": now_ms,
                "endAt": end_at,
                "tempAllow": None,
            }
            self._invalidate_current_request("进入白天试锁", now_ms)
            self._ensure_active_request(sess_id, end_at, "TEMP_ALLOW_15M", None, now_ms)
            self._log_event("TRIAL_STARTED", "已开始白天试锁（限时 3 分钟，可测试拦截、必要应用与电脑取码）。", now_ms)
            self._evaluate_state_unlocked()
            self._save_state_unlocked()
        self.broadcast("trial_start")
        return {"ok": True, "sessionId": sess_id, "endAt": end_at}

    def skip_trial(self) -> Dict[str, Any]:
        with self.lock:
            now_ms = self.now_ms()
            self.state["onboarding"]["trialSkipped"] = True
            self.state["onboarding"]["completed"] = True
            if self.state["trialSession"]:
                self._invalidate_current_request("跳过白天试锁", now_ms)
                self.state["trialSession"] = None
            self._log_event("TRIAL_SKIPPED", "用户跳过白天试锁，将在今晚按计划自动开启。", now_ms)
            self._save_state_unlocked()
        self.broadcast("trial_skip")
        return {"ok": True}

    def set_foreground_app(self, app_id: Optional[str]) -> Dict[str, Any]:
        with self.lock:
            self.state["mobileForegroundAppId"] = app_id or None
            self._evaluate_state_unlocked()
            self._save_state_unlocked()
        self.broadcast("foreground")
        return {"ok": True, "foregroundAppId": self.state["mobileForegroundAppId"]}

    def prepare_emergency_request(self, action_type: str, target_app_id: Optional[str]) -> Dict[str, Any]:
        """手机端选择/切换应急操作类型或目标应用：若发生变更，旧请求立即作废并刷新随机识别号。"""
        with self.lock:
            self._evaluate_state_unlocked()
            now_ms = self.now_ms()
            trial = self.state["trialSession"]
            ns = self.state["nightSession"]
            if trial:
                session_id = trial["sessionId"]
                expires_at = trial["endAt"]
            elif ns["status"] in ("LOCKED", "TEMP_ALLOW"):
                session_id = ns["sessionId"]
                expires_at = ns["endAt"]
            else:
                return {"ok": False, "errorCode": "SESSION_NOT_LOCKED"}

            if action_type not in ("TEMP_ALLOW_15M", "END_TONIGHT"):
                return {"ok": False, "errorCode": "INVALID_ACTION"}

            norm_target = None if action_type == "END_TONIGHT" else target_app_id
            if action_type == "TEMP_ALLOW_15M" and not norm_target:
                eff = self._effective_restricted_apps()
                norm_target = eff[0] if eff else "tv.danmaku.bili"

            em = self.state["emergency"]
            cur = em["activeRequest"]
            rotated = False
            if cur and cur["sessionId"] == session_id and cur["actionType"] == action_type and cur["targetAppId"] == norm_target:
                req = cur
            else:
                if cur:
                    self._invalidate_current_request("切换操作类型或目标应用", now_ms)
                req = {
                    "requestId": generate_request_id(),
                    "sessionId": session_id,
                    "actionType": action_type,
                    "targetAppId": norm_target,
                    "createdAt": now_ms,
                    "expiresAt": expires_at,
                }
                em["activeRequest"] = req
                em["desktopIssued"] = None
                rotated = True
                self._log_event(
                    "EMERGENCY_REQ_ROTATED",
                    f"应急请求已更新（新识别号 {req['requestId']}），旧请求与旧应急码已作废。",
                    now_ms,
                )

            self._evaluate_state_unlocked()
            self._save_state_unlocked()
        self.broadcast("emergency_prepare")
        return {"ok": True, "request": req, "rotated": rotated}

    def desktop_issue_online_code(self, action_type: Optional[str] = None, target_app_id: Optional[str] = None) -> Dict[str, Any]:
        """电脑端在线模式：主动点击后立即生成并显示 6 位随机应急码（无 3 秒等待）。"""
        with self.lock:
            self._evaluate_state_unlocked()
            now_ms = self.now_ms()
            if self.state["pairing"]["status"] != "PAIRED":
                return {"ok": False, "errorCode": "NOT_PAIRED"}
            if not (self.state["sim"]["lanConnected"] and self.state["sim"]["pcPoweredOn"]):
                return {"ok": False, "errorCode": "PC_OFFLINE"}

            trial = self.state["trialSession"]
            ns = self.state["nightSession"]
            if trial:
                session_id = trial["sessionId"]
                expires_at = trial["endAt"]
            elif ns["status"] in ("LOCKED", "TEMP_ALLOW"):
                session_id = ns["sessionId"]
                expires_at = ns["endAt"]
            else:
                return {"ok": False, "errorCode": "SESSION_NOT_LOCKED"}

            em = self.state["emergency"]
            cur = em["activeRequest"]
            desired_action = action_type or (cur["actionType"] if cur else "TEMP_ALLOW_15M")
            desired_target = None if desired_action == "END_TONIGHT" else (
                target_app_id or (cur["targetAppId"] if cur and cur["targetAppId"] else (self._effective_restricted_apps()[0] if self._effective_restricted_apps() else "tv.danmaku.bili"))
            )

            # 若电脑切换了操作类型或目标应用，同步旋转唯一活动请求并使旧请求作废
            if not cur or cur["sessionId"] != session_id or cur["actionType"] != desired_action or cur["targetAppId"] != desired_target:
                if cur:
                    self._invalidate_current_request("电脑端切换签发操作或目标应用", now_ms)
                cur = {
                    "requestId": generate_request_id(),
                    "sessionId": session_id,
                    "actionType": desired_action,
                    "targetAppId": desired_target,
                    "createdAt": now_ms,
                    "expiresAt": expires_at,
                }
                em["activeRequest"] = cur
                em["desktopIssued"] = None

            # 若当前活动请求已签发过在线码，复用该请求对应的唯一码（防止重复点造成手机不认），否则生成 CSPRNG 新码
            existing = em["desktopIssued"]
            if existing and existing["requestId"] == cur["requestId"]:
                code = existing["plaintextCode"]
            else:
                code = f"{secrets.randbelow(1_000_000):06d}"
                salt = secrets.token_hex(8)
                payload = canonical_payload(
                    self.state["pairing"]["pairId"],
                    cur["sessionId"],
                    cur["requestId"],
                    cur["actionType"],
                    cur["targetAppId"],
                )
                em["desktopIssued"] = {
                    "requestId": cur["requestId"],
                    "sessionId": cur["sessionId"],
                    "actionType": cur["actionType"],
                    "targetAppId": cur["targetAppId"],
                    "plaintextCode": code,
                    "salt": salt,
                    "codeHash": hash_online_code(salt, code, payload),
                    "issuedAt": now_ms,
                }
                self._log_event(
                    "DESKTOP_CODE_ISSUED",
                    f"电脑端已为请求 {cur['requestId']} 生成一次性应急码（{cur['actionType']}）。",
                    now_ms,
                )

            self._evaluate_state_unlocked()
            self._save_state_unlocked()
            issued_view = {
                "requestId": cur["requestId"],
                "sessionId": cur["sessionId"],
                "actionType": cur["actionType"],
                "targetAppId": cur["targetAppId"],
                "code": code,
                "issuedAt": em["desktopIssued"]["issuedAt"],
            }
        self.broadcast("desktop_issue")
        return {"ok": True, "issued": issued_view}

    def verify_emergency_code(self, submitted_code: str) -> Dict[str, Any]:
        """手机端校验应急码：严格只校验唯一当前活动请求；支持在线校验与完全离线本地 HMAC 校验；单次消费并持久化。"""
        with self.lock:
            self._evaluate_state_unlocked()
            now_ms = self.now_ms()
            code = "".join(ch for ch in str(submitted_code or "") if ch.isdigit())

            # 并发竞态保护：若校验瞬间已自然结束
            trial = self.state["trialSession"]
            ns = self.state["nightSession"]
            if not trial and ns["status"] == "NATURAL_ENDED":
                return {"ok": False, "errorCode": "SESSION_ALREADY_ENDED"}
            if not trial and ns["status"] not in ("LOCKED", "TEMP_ALLOW"):
                return {"ok": False, "errorCode": "SESSION_NOT_LOCKED"}

            em = self.state["emergency"]
            if em["cooldownUntil"] and now_ms < em["cooldownUntil"]:
                return {
                    "ok": False,
                    "errorCode": "COOLDOWN_ACTIVE",
                    "cooldownUntil": em["cooldownUntil"],
                }

            cur = em["activeRequest"]
            if not cur:
                return {"ok": False, "errorCode": "SESSION_NOT_LOCKED"}

            pair_id = self.state["pairing"].get("pairId")
            shared_secret = self.state["pairing"].get("sharedSecret")
            if not pair_id or not shared_secret:
                return {"ok": False, "errorCode": "NOT_PAIRED"}

            code_sha = hashlib.sha256(code.encode("utf-8")).hexdigest() if len(code) == 6 else None

            # 1) 验证当前活动请求：在线 CSPRNG 哈希校验 OR 离线标准 HMAC-SHA256 校验
            matched_mode: Optional[str] = None
            payload = canonical_payload(pair_id, cur["sessionId"], cur["requestId"], cur["actionType"], cur["targetAppId"])

            issued = em["desktopIssued"]
            if issued and issued["requestId"] == cur["requestId"] and self.state["sim"]["lanConnected"] and self.state["sim"]["pcPoweredOn"]:
                expected_hash = hash_online_code(issued["salt"], code, payload)
                if hmac.compare_digest(expected_hash, issued["codeHash"]):
                    matched_mode = "ONLINE"

            if not matched_mode and len(code) == 6:
                expected_offline = derive_offline_code(
                    shared_secret,
                    pair_id,
                    cur["sessionId"],
                    cur["requestId"],
                    cur["actionType"],
                    cur["targetAppId"],
                )
                if hmac.compare_digest(code, expected_offline):
                    matched_mode = "OFFLINE"

            if not matched_mode:
                # 精确区分失败原因：是否重放了已消费旧码 / 是否使用了已因切换而作废的旧码
                error_code = "CODE_INVALID"
                if len(code) == 6:
                    for item in em["consumedRequests"]:
                        if item.get("codeSha") == code_sha:
                            error_code = "CODE_ALREADY_USED"
                            break
                        # 也检查该消费记录对应的离线派生码
                        old_offline = derive_offline_code(
                            shared_secret, pair_id, item["sessionId"], item["requestId"], item["actionType"], item["targetAppId"]
                        )
                        if hmac.compare_digest(code, old_offline):
                            error_code = "CODE_ALREADY_USED"
                            break

                    if error_code == "CODE_INVALID":
                        for item in em["invalidatedRequests"]:
                            if item.get("codeSha") == code_sha:
                                error_code = "REQUEST_INVALIDATED"
                                break
                            old_offline = derive_offline_code(
                                shared_secret, pair_id, item["sessionId"], item["requestId"], item["actionType"], item["targetAppId"]
                            )
                            if hmac.compare_digest(code, old_offline):
                                error_code = "REQUEST_INVALIDATED"
                                break

                    # 检查是不是电脑端选错了操作类型或选错了目标应用（基于当前 requestId）
                    if error_code == "CODE_INVALID":
                        other_action = "END_TONIGHT" if cur["actionType"] == "TEMP_ALLOW_15M" else "TEMP_ALLOW_15M"
                        candidate_targets = [None] if other_action == "END_TONIGHT" else self._effective_restricted_apps()
                        for cand in candidate_targets:
                            c_code = derive_offline_code(shared_secret, pair_id, cur["sessionId"], cur["requestId"], other_action, cand)
                            if hmac.compare_digest(code, c_code):
                                error_code = "REQUEST_MISMATCH"
                                break
                        if error_code == "CODE_INVALID" and cur["actionType"] == "TEMP_ALLOW_15M":
                            for cand in self._effective_restricted_apps():
                                if cand == cur["targetAppId"]:
                                    continue
                                c_code = derive_offline_code(shared_secret, pair_id, cur["sessionId"], cur["requestId"], "TEMP_ALLOW_15M", cand)
                                if hmac.compare_digest(code, c_code):
                                    error_code = "REQUEST_MISMATCH"
                                    break

                em["wrongAttempts"] += 1
                cooldown_until = None
                if em["wrongAttempts"] >= 5:
                    cooldown_until = now_ms + 3 * 60 * 1000
                    em["cooldownUntil"] = cooldown_until
                elif em["wrongAttempts"] == 3:
                    cooldown_until = now_ms + 30 * 1000
                    em["cooldownUntil"] = cooldown_until

                self._log_event("EMERGENCY_VERIFY_FAILED", f"应急码校验失败（{error_code}，累计输错 {em['wrongAttempts']} 次）。", now_ms)
                self._save_state_unlocked()
                self.broadcast("emergency_failed")
                return {
                    "ok": False,
                    "errorCode": error_code,
                    "wrongAttempts": em["wrongAttempts"],
                    "cooldownUntil": cooldown_until,
                }

            # 2) 校验成功：一次性消费并立即持久化！
            consumed_record = {
                "requestId": cur["requestId"],
                "sessionId": cur["sessionId"],
                "actionType": cur["actionType"],
                "targetAppId": cur["targetAppId"],
                "consumedAt": now_ms,
                "mode": matched_mode,
                "codeSha": code_sha,
            }
            em["consumedRequests"].insert(0, consumed_record)
            em["consumedRequests"] = em["consumedRequests"][:200]
            em["wrongAttempts"] = 0
            em["cooldownUntil"] = None
            em["desktopIssued"] = None
            em["activeRequest"] = None

            action_taken = cur["actionType"]
            target_app = cur["targetAppId"]

            if action_taken == "TEMP_ALLOW_15M":
                if trial:
                    allow_end = min(now_ms + TEMP_ALLOW_SECONDS * 1000, trial["endAt"])
                    trial["tempAllow"] = {
                        "appId": target_app,
                        "startedAt": now_ms,
                        "expiresAt": allow_end,
                        "requestId": cur["requestId"],
                    }
                    # 立刻刷新下一个不可预测的随机请求号，防重放与防提前抄码
                    self._ensure_active_request(trial["sessionId"], trial["endAt"], "TEMP_ALLOW_15M", target_app, now_ms)
                    self._log_event(
                        "TEMP_ALLOW_GRANTED",
                        f"试锁临时放行生效（{matched_mode}）：仅放行 {target_app}，消费请求 {cur['requestId']}。",
                        now_ms,
                    )
                else:
                    allow_end = min(now_ms + TEMP_ALLOW_SECONDS * 1000, ns["endAt"])
                    ns["tempAllow"] = {
                        "appId": target_app,
                        "startedAt": now_ms,
                        "expiresAt": allow_end,
                        "requestId": cur["requestId"],
                    }
                    ns["tempAllowOneMinWarned"] = False
                    ns["status"] = "TEMP_ALLOW"
                    # 立刻刷新下一个不可预测的随机请求号
                    self._ensure_active_request(ns["sessionId"], ns["endAt"], "TEMP_ALLOW_15M", target_app, now_ms)
                    self._log_event(
                        "TEMP_ALLOW_GRANTED",
                        f"应急临时放行生效（{matched_mode}）：仅放行 {target_app} 20 分钟，旧码 {cur['requestId']} 已作废。",
                        now_ms,
                    )
                result = {
                    "ok": True,
                    "mode": matched_mode,
                    "actionType": "TEMP_ALLOW_15M",
                    "targetAppId": target_app,
                    "expiresAt": allow_end,
                    "consumedRequestId": cur["requestId"],
                    "nextRequestId": em["activeRequest"]["requestId"] if em["activeRequest"] else None,
                }
            else:
                # END_TONIGHT
                if trial:
                    self.state["trialSession"] = None
                    self.state["onboarding"]["trialCompleted"] = True
                    self._log_event("TRIAL_ENDED_EARLY", f"通过电脑应急码提前结束白天试锁（消费请求 {cur['requestId']}）。", now_ms)
                else:
                    ns["status"] = "ENDED_EARLY"
                    ns["endedEarlyAt"] = now_ms
                    ns["tempAllow"] = None
                    self._log_event("ENDED_EARLY", f"今晚限制已提前结束（{matched_mode}，消费请求 {cur['requestId']}），明晚照常开启。", now_ms)
                result = {
                    "ok": True,
                    "mode": matched_mode,
                    "actionType": "END_TONIGHT",
                    "targetAppId": None,
                    "consumedRequestId": cur["requestId"],
                    "nextRegularResumeAt": self._compute_next_regular_resume_at(ns["nightKey"]),
                }

            self._evaluate_state_unlocked()
            self._save_state_unlocked()
        self.broadcast("emergency_verified")
        return result

    def relock_early(self) -> Dict[str, Any]:
        """用户办完急事，主动提前结束 20 分钟放行或重新开启今晚限制。"""
        with self.lock:
            self._evaluate_state_unlocked()
            now_ms = self.now_ms()
            trial = self.state["trialSession"]
            ns = self.state["nightSession"]
            if trial and trial.get("tempAllow"):
                trial["tempAllow"] = None
                self._log_event("RELOCK_MANUAL", "已提前结束试锁临时放行，恢复拦截。", now_ms)
            elif ns["status"] == "TEMP_ALLOW":
                ns["tempAllow"] = None
                ns["status"] = "LOCKED"
                self._log_event("RELOCK_MANUAL", "已主动提前结束 20 分钟放行，立即恢复夜间拦截。", now_ms)
            elif ns["status"] == "ENDED_EARLY" and now_ms < ns["endAt"]:
                ns["status"] = "LOCKED"
                ns["endedEarlyAt"] = None
                self._ensure_active_request(ns["sessionId"], ns["endAt"], "TEMP_ALLOW_15M", None, now_ms)
                self._log_event("RELOCK_MANUAL", "已手动重新开启今晚限制，并刷新全新应急请求号。", now_ms)
            self._evaluate_state_unlocked()
            self._save_state_unlocked()
        self.broadcast("relock")
        return {"ok": True}

    # ---------------- 开发调试模拟操作 ----------------

    def sim_adjust_time(self, action: str, delta_seconds: int = 0) -> Dict[str, Any]:
        with self.lock:
            now_ms = self.now_ms()
            ns = self.state["nightSession"]
            trial = self.state["trialSession"]

            if action == "DELTA":
                self.state["sim"]["timeOffsetMs"] += int(delta_seconds) * 1000
            elif action == "RESET_REAL":
                self.state["sim"]["timeOffsetMs"] = 0
            elif action == "JUMP_PRE_REMINDER":
                pre_ms = int(self.state["schedule"]["preReminderMinutes"]) * 60 * 1000
                target = ns["startAt"] - pre_ms + 5000
                self.state["sim"]["timeOffsetMs"] += target - now_ms
            elif action == "JUMP_LOCK_START":
                target = ns["startAt"] + 1000
                self.state["sim"]["timeOffsetMs"] += target - now_ms
            elif action == "JUMP_BEFORE_LOCK_5S":
                target = ns["startAt"] - 5000
                self.state["sim"]["timeOffsetMs"] += target - now_ms
            elif action == "JUMP_ALLOW_END_MINUS_5S":
                ta = trial.get("tempAllow") if trial else ns.get("tempAllow")
                if ta:
                    target = ta["expiresAt"] - 5000
                    self.state["sim"]["timeOffsetMs"] += target - now_ms
            elif action == "JUMP_ALLOW_END":
                ta = trial.get("tempAllow") if trial else ns.get("tempAllow")
                if ta:
                    target = ta["expiresAt"] + 1000
                    self.state["sim"]["timeOffsetMs"] += target - now_ms
            elif action == "JUMP_NATURAL_END":
                target = ns["endAt"] + 1000
                self.state["sim"]["timeOffsetMs"] += target - now_ms
            elif action == "JUMP_NIGHT_0100":
                # 跳到本夜晚对应的次日凌晨 01:00（用于演示跨午夜与 23:30 关机→01:00 开机）
                base = datetime.strptime(ns["nightKey"], "%Y-%m-%d") + timedelta(days=1)
                target = int(base.replace(hour=1, minute=0, second=0).timestamp() * 1000)
                self.state["sim"]["timeOffsetMs"] += target - now_ms

            self._evaluate_state_unlocked()
            self._save_state_unlocked()
        self.broadcast("sim_time")
        return {"ok": True, "nowMs": self.now_ms()}

    def sim_start_in_one_minute(self, duration_minutes: int = 30) -> Dict[str, Any]:
        """一键演示快捷设置：把今晚锁定设为 1 分钟后开始（保留当前真实时钟走动），便于现场走完整演示闭环。"""
        with self.lock:
            now_ms = self.now_ms()
            nk = night_key_for_ts(now_ms)
            start_at = now_ms + 60 * 1000
            end_at = start_at + max(2, int(duration_minutes)) * 60 * 1000

            self.state["trialSession"] = None
            self.state["tonightOverride"] = None
            self.state["nightSession"] = {
                "nightKey": nk,
                "sessionId": f"night:{nk}",
                "baselineStartAt": start_at,
                "baselineEndAt": end_at,
                "freezeCutoffAt": start_at - FREEZE_SECONDS * 1000,
                "startAt": start_at,
                "endAt": end_at,
                "enabled": True,
                "effectiveRestrictedAppIds": list(self.state["apps"]["restrictedAppIds"]),
                "effectiveExemptAppIds": list(self.state["apps"]["exemptAppIds"]),
                "status": "PRE_LOCK_REMINDER",
                "endedEarlyAt": None,
                "naturalEndedAt": None,
                "tempAllow": None,
                "preReminderLogged": True,
                "lockStartedLogged": False,
                "tempAllowOneMinWarned": False,
            }
            self.state["emergency"]["activeRequest"] = None
            self.state["emergency"]["desktopIssued"] = None
            self.state["emergency"]["wrongAttempts"] = 0
            self.state["emergency"]["cooldownUntil"] = None
            self._log_event("DEMO_PRESET", "【演示快捷】已将今晚锁定设为 1 分钟后自动开始。", now_ms)
            self._evaluate_state_unlocked()
            self._save_state_unlocked()
        self.broadcast("sim_preset")
        return {"ok": True, "startAt": start_at, "endAt": end_at}

    def sim_set_network(self, lan_connected: Optional[bool] = None, pc_powered_on: Optional[bool] = None) -> Dict[str, Any]:
        with self.lock:
            now_ms = self.now_ms()
            if lan_connected is not None:
                self.state["sim"]["lanConnected"] = bool(lan_connected)
            if pc_powered_on is not None:
                self.state["sim"]["pcPoweredOn"] = bool(pc_powered_on)
            self._log_event(
                "SIM_NETWORK",
                f"【模拟环境】电脑电源：{'开机' if self.state['sim']['pcPoweredOn'] else '关机'} · 局域网互通：{'正常' if self.state['sim']['lanConnected'] else '断开/AP隔离'}。",
                now_ms,
            )
            self._evaluate_state_unlocked()
            self._save_state_unlocked()
        self.broadcast("sim_network")
        return {"ok": True, "sim": dict(self.state["sim"])}

    def sim_reboot_mobile(self) -> Dict[str, Any]:
        """模拟手机重启：从磁盘重新加载持久化状态，验证锁定状态与已消费应急请求记录在重启后仍然有效。"""
        with self.lock:
            self._save_state_unlocked()
            reloaded = self._load_state()
            self.state = reloaded
            self.state["sim"]["mobileRebootCount"] = int(self.state["sim"].get("mobileRebootCount", 0)) + 1
            now_ms = self.now_ms()
            self._evaluate_state_unlocked()
            ns = self.state["nightSession"]
            self._log_event(
                "MOBILE_REBOOTED",
                f"模拟手机重启完成（第 {self.state['sim']['mobileRebootCount']} 次）：已从本地持久化恢复状态（{ns['status']}），保留 {len(self.state['emergency']['consumedRequests'])} 条已消费请求记录。",
                now_ms,
            )
            self._save_state_unlocked()
        self.broadcast("sim_reboot")
        return {
            "ok": True,
            "rebootCount": self.state["sim"]["mobileRebootCount"],
            "status": self.state["nightSession"]["status"],
            "consumedCount": len(self.state["emergency"]["consumedRequests"]),
        }

    def sim_reset_all(self, auto_pair: bool = False) -> Dict[str, Any]:
        with self.lock:
            self.state = default_state()
            if auto_pair:
                now_ms = self.now_ms()
                self.state["pairing"].update({
                    "status": "PAIRED",
                    "pairId": f"pair_{secrets.token_hex(6)}",
                    "sharedSecret": secrets.token_hex(32),
                    "pairedAt": now_ms,
                })
                self.state["onboarding"]["completed"] = True
                self.state["onboarding"]["morningChecklistConfirmed"] = True
                self._log_event("SIM_RESET", "演示状态已重置并预配对完成。", now_ms)
            else:
                self._log_event("SIM_RESET", "全部演示数据已恢复为首次安装初始状态。", self.now_ms())
            self._evaluate_state_unlocked()
            self._save_state_unlocked()
        self.broadcast("sim_reset")
        return {"ok": True}


STORE = DormSleepStore(STATE_FILE)


def background_ticker() -> None:
    while True:
        time.sleep(1.0)
        try:
            STORE.tick_and_sync(broadcast=True)
        except Exception:
            pass


class DormSleepHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        # 保持控制台简洁
        pass

    def _send_json(self, status: int, data: Dict[str, Any]) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/state":
            client = "all"
            if "client=mobile" in parsed.query:
                client = "mobile"
            elif "client=desktop" in parsed.query:
                client = "desktop"
            self._send_json(200, STORE.get_public_state(client))
            return

        if path == "/api/events":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()

            q: queue.Queue = queue.Queue(maxsize=64)
            with STORE.lock:
                STORE.subscribers.append(q)
            try:
                init_msg = json.dumps({"type": "connected", "ts": STORE.now_ms()})
                self.wfile.write(f"data: {init_msg}\n\n".encode("utf-8"))
                self.wfile.flush()
                while True:
                    try:
                        msg = q.get(timeout=15.0)
                        self.wfile.write(f"data: {msg}\n\n".encode("utf-8"))
                        self.wfile.flush()
                    except queue.Empty:
                        self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
            except Exception:
                pass
            finally:
                with STORE.lock:
                    if q in STORE.subscribers:
                        STORE.subscribers.remove(q)
            return

        # 静态文件路由
        self._serve_static(path)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            body = self._read_json_body()
        except Exception as exc:
            self._send_json(400, {"ok": False, "errorCode": "BAD_JSON", "detail": str(exc)})
            return

        try:
            if path == "/api/pair/start":
                res = STORE.start_pairing()
            elif path == "/api/pair/confirm":
                res = STORE.confirm_pairing(body.get("pairCode", ""), body.get("mobileName"))
            elif path == "/api/pair/unbind":
                res = STORE.unbind_pairing(bool(body.get("lostPc", False)))
            elif path == "/api/mobile/onboarding-complete":
                res = STORE.complete_onboarding(bool(body.get("morningChecklistConfirmed", True)))
            elif path == "/api/mobile/schedule":
                res = STORE.update_schedule(
                    body["schoolNight"],
                    body["weekendNight"],
                    body.get("preReminderMinutes", 10),
                )
            elif path == "/api/mobile/tonight-override":
                res = STORE.apply_tonight_override(
                    body.get("mode", ""),
                    body.get("start"),
                    body.get("end"),
                )
            elif path == "/api/mobile/apps":
                res = STORE.update_apps(
                    body.get("restrictedAppIds", []),
                    body.get("exemptAppIds", []),
                )
            elif path == "/api/mobile/permissions":
                res = STORE.update_permissions(body)
            elif path == "/api/mobile/trial/start":
                res = STORE.start_trial()
            elif path == "/api/mobile/trial/skip":
                res = STORE.skip_trial()
            elif path == "/api/mobile/foreground":
                res = STORE.set_foreground_app(body.get("appId"))
            elif path == "/api/mobile/emergency/prepare":
                res = STORE.prepare_emergency_request(
                    body.get("actionType", "TEMP_ALLOW_15M"),
                    body.get("targetAppId"),
                )
            elif path == "/api/mobile/emergency/verify":
                res = STORE.verify_emergency_code(body.get("code", ""))
            elif path == "/api/mobile/emergency/relock-early":
                res = STORE.relock_early()
            elif path == "/api/desktop/emergency/issue":
                res = STORE.desktop_issue_online_code(
                    body.get("actionType"),
                    body.get("targetAppId"),
                )
            elif path == "/api/sim/time":
                res = STORE.sim_adjust_time(body.get("action", "DELTA"), int(body.get("deltaSeconds", 0)))
            elif path == "/api/sim/start-in-one-minute":
                res = STORE.sim_start_in_one_minute(int(body.get("durationMinutes", 30)))
            elif path == "/api/sim/network":
                res = STORE.sim_set_network(body.get("lanConnected"), body.get("pcPoweredOn"))
            elif path == "/api/sim/reboot-mobile":
                res = STORE.sim_reboot_mobile()
            elif path == "/api/sim/reset":
                res = STORE.sim_reset_all(bool(body.get("autoPair", False)))
            else:
                self._send_json(404, {"ok": False, "errorCode": "NOT_FOUND"})
                return
            self._send_json(200, res)
        except Exception as exc:
            self._send_json(400, {"ok": False, "errorCode": "BAD_REQUEST", "detail": str(exc)})

    def _serve_static(self, raw_path: str) -> None:
        if raw_path in ("/", ""):
            rel = "apps/launcher/index.html"
        elif raw_path in ("/mobile", "/mobile/"):
            rel = "apps/mobile/index.html"
        elif raw_path.startswith("/mobile/"):
            rel = "apps/mobile/" + raw_path[len("/mobile/"):]
        elif raw_path in ("/desktop", "/desktop/"):
            rel = "apps/desktop/index.html"
        elif raw_path.startswith("/desktop/"):
            rel = "apps/desktop/" + raw_path[len("/desktop/"):]
        elif raw_path.startswith("/shared/") or raw_path.startswith("/adapters/"):
            rel = raw_path.lstrip("/")
        else:
            rel = raw_path.lstrip("/")

        target = (ROOT_DIR / rel).resolve()
        if not str(target).startswith(str(ROOT_DIR)) or not target.is_file():
            self.send_response(404)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
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


def run_server(host: str = "127.0.0.1", port: int = 4173) -> None:
    t = threading.Thread(target=background_ticker, daemon=True)
    t.start()
    server = ThreadingHTTPServer((host, port), DormSleepHandler)
    print(f"[DormSleep Mock Bridge] 服务已启动：http://{host}:{port}/")
    print(f"  - 双端联调入口：http://{host}:{port}/")
    print(f"  - Android 手机端：http://{host}:{port}/mobile/")
    print(f"  - Windows 电脑端：http://{host}:{port}/desktop/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[DormSleep Mock Bridge] 服务已停止。")
    finally:
        server.server_close()


if __name__ == "__main__":
    port = int(os.environ.get("DORMSLEEP_PORT", sys.argv[1] if len(sys.argv) > 1 else "4173"))
    run_server(port=port)
