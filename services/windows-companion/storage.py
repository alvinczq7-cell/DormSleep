"""
Windows 本地伴随服务 SQLite WAL 持久化层
--------------------------------------
保存配对记录、手机最新状态快照、在线签发记录、已消费防重放表与事件日志。
"""

from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional


class CompanionDatabase:
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._init_schema()

    def _init_schema(self) -> None:
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL;")
            self._conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS pairing (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    status TEXT NOT NULL,
                    pair_id TEXT,
                    pending_pair_code TEXT,
                    pending_expires_at INTEGER,
                    mobile_name TEXT NOT NULL,
                    desktop_name TEXT NOT NULL,
                    paired_at INTEGER
                );

                CREATE TABLE IF NOT EXISTS phone_snapshot (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    synced_at INTEGER,
                    snapshot_json TEXT
                );

                CREATE TABLE IF NOT EXISTS issued_codes (
                    request_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    action_type TEXT NOT NULL,
                    target_app_id TEXT,
                    plaintext_code TEXT NOT NULL,
                    salt TEXT NOT NULL,
                    code_hash TEXT NOT NULL,
                    issued_at INTEGER NOT NULL,
                    status TEXT NOT NULL DEFAULT 'ACTIVE'
                );

                CREATE TABLE IF NOT EXISTS consumed_requests (
                    request_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    action_type TEXT NOT NULL,
                    target_app_id TEXT,
                    consumed_at INTEGER NOT NULL,
                    mode TEXT NOT NULL,
                    code_sha TEXT
                );

                CREATE TABLE IF NOT EXISTS events (
                    id TEXT PRIMARY KEY,
                    ts INTEGER NOT NULL,
                    kind TEXT NOT NULL,
                    message TEXT NOT NULL
                );
                """
            )
            cur = self._conn.execute("SELECT COUNT(*) FROM pairing WHERE id = 1")
            if cur.fetchone()[0] == 0:
                self._conn.execute(
                    """
                    INSERT INTO pairing (id, status, mobile_name, desktop_name)
                    VALUES (1, 'UNPAIRED', 'Android 宿舍手机', 'Windows 宿舍笔记本')
                    """
                )
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # ---------- Pairing ----------

    def get_pairing(self) -> Dict[str, Any]:
        with self._lock:
            row = self._conn.execute("SELECT * FROM pairing WHERE id = 1").fetchone()
            return {
                "status": row["status"],
                "pairId": row["pair_id"],
                "pendingPairCode": row["pending_pair_code"],
                "pendingExpiresAt": row["pending_expires_at"],
                "mobileName": row["mobile_name"],
                "desktopName": row["desktop_name"],
                "pairedAt": row["paired_at"],
            }

    def set_pending_pairing(self, pair_code: str, expires_at: int) -> None:
        with self._lock:
            self._conn.execute(
                """
                UPDATE pairing
                SET status = 'PENDING', pending_pair_code = ?, pending_expires_at = ?
                WHERE id = 1
                """,
                (pair_code, expires_at),
            )
            self._conn.commit()

    def confirm_pairing(self, pair_id: str, mobile_name: str, paired_at: int) -> None:
        with self._lock:
            self._conn.execute(
                """
                UPDATE pairing
                SET status = 'PAIRED', pair_id = ?, pending_pair_code = NULL,
                    pending_expires_at = NULL, mobile_name = ?, paired_at = ?
                WHERE id = 1
                """,
                (pair_id, mobile_name, paired_at),
            )
            self._conn.commit()

    def clear_pairing(self) -> None:
        with self._lock:
            self._conn.execute(
                """
                UPDATE pairing
                SET status = 'UNPAIRED', pair_id = NULL, pending_pair_code = NULL,
                    pending_expires_at = NULL, paired_at = NULL
                WHERE id = 1
                """
            )
            self._conn.execute("DELETE FROM phone_snapshot")
            self._conn.execute("DELETE FROM issued_codes")
            self._conn.commit()

    # ---------- Snapshot ----------

    def save_snapshot(self, synced_at: int, snapshot: Dict[str, Any]) -> None:
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO phone_snapshot (id, synced_at, snapshot_json)
                VALUES (1, ?, ?)
                ON CONFLICT(id) DO UPDATE SET synced_at = excluded.synced_at, snapshot_json = excluded.snapshot_json
                """,
                (synced_at, json.dumps(snapshot, ensure_ascii=False)),
            )
            self._conn.commit()

    def get_snapshot(self) -> Optional[Dict[str, Any]]:
        with self._lock:
            row = self._conn.execute("SELECT synced_at, snapshot_json FROM phone_snapshot WHERE id = 1").fetchone()
            if not row or not row["snapshot_json"]:
                return None
            snap = json.loads(row["snapshot_json"])
            snap["syncedAt"] = row["synced_at"]
            return snap

    # ---------- Issued & Consumed Codes ----------

    def get_issued_code(self, request_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM issued_codes WHERE request_id = ?", (request_id,)
            ).fetchone()
            if not row:
                return None
            return dict(row)

    def get_latest_active_issued(self) -> Optional[Dict[str, Any]]:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM issued_codes WHERE status = 'ACTIVE' ORDER BY issued_at DESC LIMIT 1"
            ).fetchone()
            return dict(row) if row else None

    def upsert_issued_code(
        self,
        request_id: str,
        session_id: str,
        action_type: str,
        target_app_id: Optional[str],
        plaintext_code: str,
        salt: str,
        code_hash: str,
        issued_at: int,
    ) -> None:
        with self._lock:
            # 同一时刻仅保留一个活跃在线码，旧活跃码全部标为 INVALIDATED
            self._conn.execute(
                "UPDATE issued_codes SET status = 'INVALIDATED' WHERE status = 'ACTIVE' AND request_id != ?",
                (request_id,),
            )
            self._conn.execute(
                """
                INSERT INTO issued_codes
                    (request_id, session_id, action_type, target_app_id, plaintext_code, salt, code_hash, issued_at, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
                ON CONFLICT(request_id) DO UPDATE SET
                    session_id = excluded.session_id,
                    action_type = excluded.action_type,
                    target_app_id = excluded.target_app_id,
                    plaintext_code = excluded.plaintext_code,
                    salt = excluded.salt,
                    code_hash = excluded.code_hash,
                    issued_at = excluded.issued_at,
                    status = 'ACTIVE'
                """,
                (request_id, session_id, action_type, target_app_id, plaintext_code, salt, code_hash, issued_at),
            )
            self._conn.commit()

    def mark_issued_status(self, request_id: str, status: str) -> None:
        with self._lock:
            self._conn.execute("UPDATE issued_codes SET status = ? WHERE request_id = ?", (status, request_id))
            self._conn.commit()

    def invalidate_other_active_codes(self, keep_request_id: Optional[str]) -> None:
        with self._lock:
            if keep_request_id:
                self._conn.execute(
                    "UPDATE issued_codes SET status = 'INVALIDATED' WHERE status = 'ACTIVE' AND request_id != ?",
                    (keep_request_id,),
                )
            else:
                self._conn.execute("UPDATE issued_codes SET status = 'INVALIDATED' WHERE status = 'ACTIVE'")
            self._conn.commit()

    def record_consumed(
        self,
        request_id: str,
        session_id: str,
        action_type: str,
        target_app_id: Optional[str],
        consumed_at: int,
        mode: str,
        code_sha: Optional[str] = None,
    ) -> None:
        with self._lock:
            self._conn.execute(
                """
                INSERT OR IGNORE INTO consumed_requests
                    (request_id, session_id, action_type, target_app_id, consumed_at, mode, code_sha)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (request_id, session_id, action_type, target_app_id, consumed_at, mode, code_sha),
            )
            self._conn.execute("UPDATE issued_codes SET status = 'CONSUMED' WHERE request_id = ?", (request_id,))
            self._conn.commit()

    def is_consumed(self, request_id: str) -> bool:
        with self._lock:
            row = self._conn.execute(
                "SELECT 1 FROM consumed_requests WHERE request_id = ?", (request_id,)
            ).fetchone()
            return row is not None

    def is_code_sha_consumed(self, code_sha: str) -> bool:
        with self._lock:
            row = self._conn.execute(
                "SELECT 1 FROM consumed_requests WHERE code_sha = ?", (code_sha,)
            ).fetchone()
            return row is not None

    def get_consumed_count(self) -> int:
        with self._lock:
            return int(self._conn.execute("SELECT COUNT(*) FROM consumed_requests").fetchone()[0])

    # ---------- Events ----------

    def add_event(self, event_id: str, ts: int, kind: str, message: str) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR IGNORE INTO events (id, ts, kind, message) VALUES (?, ?, ?, ?)",
                (event_id, ts, kind, message),
            )
            self._conn.commit()

    def list_events(self, limit: int = 30) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, ts, kind, message FROM events ORDER BY ts DESC LIMIT ?",
                (limit,),
            ).fetchall()
            return [dict(r) for r in rows]
