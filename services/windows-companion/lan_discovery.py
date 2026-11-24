"""
局域网 UDP 发现响应服务（宿舍 Wi-Fi 免输 IP 自动发现）
------------------------------------------------
Android 手机端向局域网广播 "DORMSLEEP_DISCOVER_V1"；
电脑伴随服务收到后回复本机服务端口、设备名与配对 ID（绝不回传任何密钥）。
当宿舍校园网开启 AP 隔离导致广播不可达时，手机与电脑自动无感降级为离线取码模式。
"""

from __future__ import annotations

import json
import socket
import threading
from typing import Callable, Dict, Any

DISCOVER_MAGIC = b"DORMSLEEP_DISCOVER_V1"


class LanDiscoveryResponder:
    def __init__(
        self,
        udp_port: int,
        http_port: int,
        info_provider: Callable[[], Dict[str, Any]],
        bind_host: str = "0.0.0.0",
    ):
        self.udp_port = udp_port
        self.http_port = http_port
        self.info_provider = info_provider
        self.bind_host = bind_host
        self._stop = threading.Event()
        self._sock: socket.socket | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind((self.bind_host, self.udp_port))
        self._sock.settimeout(0.5)
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def _loop(self) -> None:
        assert self._sock is not None
        while not self._stop.is_set():
            try:
                data, addr = self._sock.recvfrom(1024)
            except socket.timeout:
                continue
            except OSError:
                break
            if data.strip() != DISCOVER_MAGIC:
                continue
            info = self.info_provider()
            reply = json.dumps(
                {
                    "service": "DormSleepCompanion",
                    "protocolVersion": 1,
                    "httpPort": self.http_port,
                    "desktopName": info.get("desktopName", "Windows 宿舍笔记本"),
                    "pairingStatus": info.get("status", "UNPAIRED"),
                    "pairId": info.get("pairId"),
                },
                ensure_ascii=False,
            ).encode("utf-8")
            try:
                self._sock.sendto(reply, addr)
            except OSError:
                pass

    def stop(self) -> None:
        self._stop.set()
        if self._sock:
            try:
                self._sock.close()
            except OSError:
                pass
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.5)
