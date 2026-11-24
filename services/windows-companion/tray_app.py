#!/usr/bin/env python3
"""
熄灯守夜（DormSleep）Windows 原生系统托盘常驻程序
=================================================
零第三方运行时依赖（纯 Python 标准库 + Win32 ctypes）：
1. 单实例互斥锁（Local\\DormSleepCompanionSingleton_v1）：重复双击直接唤起界面，不冲突不双开。
2. 后台静默托管真实 Windows 伴随服务（HTTP 4180 + UDP 41740 局域网发现 + Windows DPAPI + SQLite WAL）。
3. 优先以 Microsoft Edge / Chrome 独立应用窗口模式（--app）打开桌面端，关闭窗口后仍驻留系统托盘。
4. 系统托盘右键菜单：打开主界面 / 查看实时状态 / 开机自启开关（HKCU\\...\\Run）/ 复制局域网地址 / 打开数据目录 / 退出。
5. 支持 --minimized 参数，供开机自启时静默驻留托盘不弹窗。
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes
import logging
import os
from pathlib import Path
import subprocess
import sys
import time
import webbrowser
from typing import Optional

SERVICE_DIR = Path(__file__).resolve().parent
if not getattr(sys, "frozen", False):
    sys.path.insert(0, str(SERVICE_DIR))

from companion_server import (  # noqa: E402
    CompanionRuntime,
    get_asset_root,
    get_default_data_dir,
    get_lan_ipv4_addresses,
    is_frozen,
)

APP_NAME = "熄灯守夜"
MUTEX_NAME = "Local\\DormSleepCompanionSingleton_v1"
RUN_REG_PATH = r"Software\Microsoft\Windows\CurrentVersion\Run"
RUN_REG_VALUE = "DormSleepCompanion"

# Win32 常量
WM_DESTROY = 0x0002
WM_CLOSE = 0x0010
WM_QUERYENDSESSION = 0x0011
WM_ENDSESSION = 0x0016
WM_COMMAND = 0x0111
WM_TIMER = 0x0113
WM_USER = 0x0400
WM_TRAYICON = WM_USER + 101

WM_LBUTTONUP = 0x0202
WM_LBUTTONDBLCLK = 0x0203
WM_RBUTTONUP = 0x0205
WM_CONTEXTMENU = 0x007B

NIF_MESSAGE = 0x00000001
NIF_ICON = 0x00000002
NIF_TIP = 0x00000004
NIF_INFO = 0x00000010

NIM_ADD = 0x00000000
NIM_MODIFY = 0x00000001
NIM_DELETE = 0x00000002

NIIF_INFO = 0x00000001

IMAGE_ICON = 1
LR_LOADFROMFILE = 0x0010
LR_DEFAULTSIZE = 0x0040
IDI_APPLICATION = 32512

MF_STRING = 0x0000
MF_GRAYED = 0x0001
MF_DISABLED = 0x0002
MF_CHECKED = 0x0008
MF_SEPARATOR = 0x0800

TPM_LEFTALIGN = 0x0000
TPM_RIGHTBUTTON = 0x0002
TPM_BOTTOMALIGN = 0x0020

CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x0002
MB_OK = 0x00000000
MB_ICONERROR = 0x00000010
ERROR_ALREADY_EXISTS = 183

# 菜单命令 ID
IDM_OPEN_APP = 1001
IDM_OPEN_BROWSER = 1002
IDM_STATUS = 1003
IDM_AUTOSTART = 1004
IDM_COPY_LAN = 1005
IDM_OPEN_DATA = 1006
IDM_EXIT = 1007

TIMER_REFRESH_TIP = 1

# 64-bit 安全类型
LRESULT = ctypes.c_ssize_t
WPARAM = ctypes.c_size_t
LPARAM = ctypes.c_ssize_t
WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wintypes.HWND, wintypes.UINT, WPARAM, LPARAM)


class WNDCLASSEXW(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.UINT),
        ("style", wintypes.UINT),
        ("lpfnWndProc", WNDPROC),
        ("cbClsExtra", ctypes.c_int),
        ("cbWndExtra", ctypes.c_int),
        ("hInstance", wintypes.HINSTANCE),
        ("hIcon", wintypes.HICON),
        ("hCursor", wintypes.HANDLE),
        ("hbrBackground", wintypes.HANDLE),
        ("lpszMenuName", wintypes.LPCWSTR),
        ("lpszClassName", wintypes.LPCWSTR),
        ("hIconSm", wintypes.HICON),
    ]


class GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", wintypes.ULONG),
        ("Data2", wintypes.USHORT),
        ("Data3", wintypes.USHORT),
        ("Data4", ctypes.c_ubyte * 8),
    ]


class NOTIFYICONDATAW(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("hWnd", wintypes.HWND),
        ("uID", wintypes.UINT),
        ("uFlags", wintypes.UINT),
        ("uCallbackMessage", wintypes.UINT),
        ("hIcon", wintypes.HICON),
        ("szTip", wintypes.WCHAR * 128),
        ("dwState", wintypes.DWORD),
        ("dwStateMask", wintypes.DWORD),
        ("szInfo", wintypes.WCHAR * 256),
        ("uTimeoutOrVersion", wintypes.UINT),
        ("szInfoTitle", wintypes.WCHAR * 64),
        ("dwInfoFlags", wintypes.DWORD),
        ("guidItem", GUID),
        ("hBalloonIcon", wintypes.HICON),
    ]


def setup_logging(data_dir: Path) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    log_file = data_dir / "companion.log"
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        handlers=[logging.FileHandler(log_file, encoding="utf-8")],
    )


def init_win32_apis():
    kernel32 = ctypes.windll.kernel32
    user32 = ctypes.windll.user32
    shell32 = ctypes.windll.shell32

    kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
    kernel32.GetModuleHandleW.restype = wintypes.HMODULE
    kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    kernel32.CreateMutexW.restype = wintypes.HANDLE
    kernel32.GetLastError.argtypes = []
    kernel32.GetLastError.restype = wintypes.DWORD
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
    kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalUnlock.restype = wintypes.BOOL

    user32.RegisterClassExW.argtypes = [ctypes.POINTER(WNDCLASSEXW)]
    user32.RegisterClassExW.restype = wintypes.ATOM
    user32.RegisterWindowMessageW.argtypes = [wintypes.LPCWSTR]
    user32.RegisterWindowMessageW.restype = wintypes.UINT
    user32.CreateWindowExW.argtypes = [
        wintypes.DWORD,
        wintypes.LPCWSTR,
        wintypes.LPCWSTR,
        wintypes.DWORD,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        wintypes.HWND,
        wintypes.HMENU,
        wintypes.HINSTANCE,
        wintypes.LPVOID,
    ]
    user32.CreateWindowExW.restype = wintypes.HWND
    user32.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, WPARAM, LPARAM]
    user32.DefWindowProcW.restype = LRESULT
    user32.LoadImageW.argtypes = [
        wintypes.HINSTANCE,
        wintypes.LPCWSTR,
        wintypes.UINT,
        ctypes.c_int,
        ctypes.c_int,
        wintypes.UINT,
    ]
    user32.LoadImageW.restype = wintypes.HANDLE
    user32.LoadIconW.argtypes = [wintypes.HINSTANCE, ctypes.c_void_p]
    user32.LoadIconW.restype = wintypes.HICON
    user32.DestroyIcon.argtypes = [wintypes.HICON]
    user32.DestroyIcon.restype = wintypes.BOOL
    user32.CreatePopupMenu.argtypes = []
    user32.CreatePopupMenu.restype = wintypes.HMENU
    user32.AppendMenuW.argtypes = [wintypes.HMENU, wintypes.UINT, ctypes.c_size_t, wintypes.LPCWSTR]
    user32.AppendMenuW.restype = wintypes.BOOL
    user32.SetMenuDefaultItem.argtypes = [wintypes.HMENU, wintypes.UINT, wintypes.UINT]
    user32.SetMenuDefaultItem.restype = wintypes.BOOL
    user32.GetCursorPos.argtypes = [ctypes.POINTER(wintypes.POINT)]
    user32.GetCursorPos.restype = wintypes.BOOL
    user32.SetForegroundWindow.argtypes = [wintypes.HWND]
    user32.SetForegroundWindow.restype = wintypes.BOOL
    user32.TrackPopupMenu.argtypes = [
        wintypes.HMENU,
        wintypes.UINT,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        wintypes.HWND,
        ctypes.c_void_p,
    ]
    user32.TrackPopupMenu.restype = wintypes.BOOL
    user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, WPARAM, LPARAM]
    user32.PostMessageW.restype = wintypes.BOOL
    user32.DestroyMenu.argtypes = [wintypes.HMENU]
    user32.DestroyMenu.restype = wintypes.BOOL
    user32.DestroyWindow.argtypes = [wintypes.HWND]
    user32.DestroyWindow.restype = wintypes.BOOL
    user32.PostQuitMessage.argtypes = [ctypes.c_int]
    user32.PostQuitMessage.restype = None
    user32.GetMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT]
    user32.GetMessageW.restype = ctypes.c_int
    user32.TranslateMessage.argtypes = [ctypes.POINTER(wintypes.MSG)]
    user32.TranslateMessage.restype = wintypes.BOOL
    user32.DispatchMessageW.argtypes = [ctypes.POINTER(wintypes.MSG)]
    user32.DispatchMessageW.restype = LRESULT
    user32.SetTimer.argtypes = [wintypes.HWND, ctypes.c_size_t, wintypes.UINT, ctypes.c_void_p]
    user32.SetTimer.restype = ctypes.c_size_t
    user32.KillTimer.argtypes = [wintypes.HWND, ctypes.c_size_t]
    user32.KillTimer.restype = wintypes.BOOL
    user32.MessageBoxW.argtypes = [wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.UINT]
    user32.MessageBoxW.restype = ctypes.c_int
    user32.OpenClipboard.argtypes = [wintypes.HWND]
    user32.OpenClipboard.restype = wintypes.BOOL
    user32.EmptyClipboard.argtypes = []
    user32.EmptyClipboard.restype = wintypes.BOOL
    user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    user32.SetClipboardData.restype = wintypes.HANDLE
    user32.CloseClipboard.argtypes = []
    user32.CloseClipboard.restype = wintypes.BOOL

    shell32.Shell_NotifyIconW.argtypes = [wintypes.DWORD, ctypes.POINTER(NOTIFYICONDATAW)]
    shell32.Shell_NotifyIconW.restype = wintypes.BOOL

    return kernel32, user32, shell32


def copy_to_clipboard(kernel32, user32, text: str) -> bool:
    if not user32.OpenClipboard(None):
        return False
    try:
        user32.EmptyClipboard()
        encoded = (text + "\0").encode("utf-16-le")
        hglobal = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(encoded))
        if not hglobal:
            return False
        ptr = kernel32.GlobalLock(hglobal)
        if not ptr:
            return False
        try:
            ctypes.memmove(ptr, encoded, len(encoded))
        finally:
            kernel32.GlobalUnlock(hglobal)
        return bool(user32.SetClipboardData(CF_UNICODETEXT, hglobal))
    finally:
        user32.CloseClipboard()


def find_icon_path() -> Optional[Path]:
    candidates = [
        get_asset_root() / "favicon.ico",
        SERVICE_DIR / "assets" / "dormsleep.ico",
    ]
    for p in candidates:
        if p.is_file():
            return p
    return None


def find_chromium_app_browser() -> Optional[Path]:
    local_app = os.environ.get("LOCALAPPDATA", "")
    candidates = [
        Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
        Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
        Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
        Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
    ]
    if local_app:
        candidates.append(Path(local_app) / r"Google\Chrome\Application\chrome.exe")
        candidates.append(Path(local_app) / r"Microsoft\Edge\Application\msedge.exe")
    for p in candidates:
        if p.is_file():
            return p
    return None


def open_desktop_ui(port: int, data_dir: Path, force_browser: bool = False) -> None:
    url = f"http://127.0.0.1:{port}/"
    if not force_browser:
        browser = find_chromium_app_browser()
        if browser:
            profile_dir = data_dir / "ui-window-profile"
            profile_dir.mkdir(parents=True, exist_ok=True)
            flags = 0
            if hasattr(subprocess, "DETACHED_PROCESS"):
                flags |= subprocess.DETACHED_PROCESS
            if hasattr(subprocess, "CREATE_NEW_PROCESS_GROUP"):
                flags |= subprocess.CREATE_NEW_PROCESS_GROUP
            try:
                subprocess.Popen(
                    [
                        str(browser),
                        f"--app={url}",
                        "--window-size=960,680",
                        "--no-first-run",
                        "--no-default-browser-check",
                        f"--user-data-dir={profile_dir}",
                    ],
                    creationflags=flags,
                    close_fds=True,
                )
                return
            except Exception as exc:
                logging.warning("启动独立应用窗口失败，回退默认浏览器: %s", exc)
    webbrowser.open(url)


def get_autostart_command() -> str:
    if is_frozen():
        return f'"{Path(sys.executable).resolve()}" --minimized'
    py_exe = Path(sys.executable).resolve()
    pyw = py_exe.with_name("pythonw.exe")
    launcher = pyw if pyw.is_file() else py_exe
    return f'"{launcher}" "{Path(__file__).resolve()}" --minimized'


def is_autostart_enabled() -> bool:
    import winreg

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_REG_PATH, 0, winreg.KEY_READ) as key:
            val, _ = winreg.QueryValueEx(key, RUN_REG_VALUE)
            return bool(val)
    except OSError:
        return False


def set_autostart(enabled: bool) -> bool:
    import winreg

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_REG_PATH, 0, winreg.KEY_SET_VALUE) as key:
            if enabled:
                winreg.SetValueEx(key, RUN_REG_VALUE, 0, winreg.REG_SZ, get_autostart_command())
            else:
                try:
                    winreg.DeleteValue(key, RUN_REG_VALUE)
                except FileNotFoundError:
                    pass
        return True
    except OSError as exc:
        logging.error("设置开机自启失败: %s", exc)
        return False


class DormSleepTrayApp:
    def __init__(self, runtime: CompanionRuntime, open_on_start: bool = True):
        self.runtime = runtime
        self.open_on_start = open_on_start
        self.kernel32, self.user32, self.shell32 = init_win32_apis()
        self.hinstance = self.kernel32.GetModuleHandleW(None)
        self.hwnd: Optional[int] = None
        self.hicon: Optional[int] = None
        self.icon_owned = False
        self.taskbar_created_msg = self.user32.RegisterWindowMessageW("TaskbarCreated")
        self._last_open_ts = 0.0
        self._tray_added = False
        self._wndproc_ref = WNDPROC(self._wnd_proc)

    def _load_icon(self) -> int:
        ico_path = find_icon_path()
        if ico_path:
            h = self.user32.LoadImageW(
                None,
                str(ico_path),
                IMAGE_ICON,
                0,
                0,
                LR_LOADFROMFILE | LR_DEFAULTSIZE,
            )
            if h:
                self.icon_owned = True
                return h
        self.icon_owned = False
        return self.user32.LoadIconW(None, ctypes.c_void_p(IDI_APPLICATION))

    def _make_nid(self, flags: int, tip: Optional[str] = None, balloon_title: str = "", balloon_msg: str = "") -> NOTIFYICONDATAW:
        nid = NOTIFYICONDATAW()
        nid.cbSize = ctypes.sizeof(NOTIFYICONDATAW)
        nid.hWnd = self.hwnd
        nid.uID = 1
        nid.uFlags = flags
        nid.uCallbackMessage = WM_TRAYICON
        nid.hIcon = self.hicon
        if tip is not None:
            nid.szTip = tip[:127]
        if balloon_msg:
            nid.uFlags |= NIF_INFO
            nid.szInfoTitle = balloon_title[:63]
            nid.szInfo = balloon_msg[:255]
            nid.dwInfoFlags = NIIF_INFO
        return nid

    def _build_tooltip(self) -> str:
        summary = self.runtime.get_status_summary()
        return f"{APP_NAME} · {summary}"

    def _add_tray_icon(self, show_balloon: bool = False) -> None:
        if show_balloon:
            lan_ips = get_lan_ipv4_addresses()
            lan_hint = f"局域网 {lan_ips[0]}:{self.runtime.port}" if lan_ips else f"本机端口 {self.runtime.port}"
            nid = self._make_nid(
                NIF_MESSAGE | NIF_ICON | NIF_TIP,
                tip=self._build_tooltip(),
                balloon_title="熄灯守夜已在后台运行",
                balloon_msg=f"{lan_hint} · 单击托盘图标随时打开取码窗口。",
            )
        else:
            nid = self._make_nid(NIF_MESSAGE | NIF_ICON | NIF_TIP, tip=self._build_tooltip())
        ok = self.shell32.Shell_NotifyIconW(NIM_ADD, ctypes.byref(nid))
        self._tray_added = bool(ok)

    def _update_tray_tooltip(self) -> None:
        if not self._tray_added:
            return
        nid = self._make_nid(NIF_TIP, tip=self._build_tooltip())
        self.shell32.Shell_NotifyIconW(NIM_MODIFY, ctypes.byref(nid))

    def _remove_tray_icon(self) -> None:
        if not self._tray_added:
            return
        nid = self._make_nid(0)
        self.shell32.Shell_NotifyIconW(NIM_DELETE, ctypes.byref(nid))
        self._tray_added = False

    def _open_ui_debounced(self, force_browser: bool = False) -> None:
        now = time.monotonic()
        if not force_browser and (now - self._last_open_ts) < 0.7:
            return
        self._last_open_ts = now
        open_desktop_ui(self.runtime.port, self.runtime.data_dir, force_browser=force_browser)

    def _show_context_menu(self) -> None:
        hmenu = self.user32.CreatePopupMenu()
        if not hmenu:
            return
        try:
            status_text = f"状态：{self.runtime.get_status_summary()}"
            lan_ips = get_lan_ipv4_addresses()
            lan_addr = f"{lan_ips[0]}:{self.runtime.port}" if lan_ips else f"127.0.0.1:{self.runtime.port}"
            autostart_flags = MF_STRING | (MF_CHECKED if is_autostart_enabled() else 0)

            self.user32.AppendMenuW(hmenu, MF_STRING, IDM_OPEN_APP, "打开熄灯守夜")
            self.user32.SetMenuDefaultItem(hmenu, IDM_OPEN_APP, 0)
            self.user32.AppendMenuW(hmenu, MF_STRING, IDM_OPEN_BROWSER, "在默认浏览器中打开")
            self.user32.AppendMenuW(hmenu, MF_SEPARATOR, 0, None)
            self.user32.AppendMenuW(hmenu, MF_STRING | MF_GRAYED | MF_DISABLED, IDM_STATUS, status_text)
            self.user32.AppendMenuW(hmenu, MF_STRING, IDM_COPY_LAN, f"复制局域网地址（{lan_addr}）")
            self.user32.AppendMenuW(hmenu, MF_SEPARATOR, 0, None)
            self.user32.AppendMenuW(hmenu, autostart_flags, IDM_AUTOSTART, "开机自启（后台静默驻留）")
            self.user32.AppendMenuW(hmenu, MF_STRING, IDM_OPEN_DATA, "打开数据与日志目录")
            self.user32.AppendMenuW(hmenu, MF_SEPARATOR, 0, None)
            self.user32.AppendMenuW(hmenu, MF_STRING, IDM_EXIT, "退出熄灯守夜")

            pt = wintypes.POINT()
            self.user32.GetCursorPos(ctypes.byref(pt))
            self.user32.SetForegroundWindow(self.hwnd)
            self.user32.TrackPopupMenu(
                hmenu,
                TPM_LEFTALIGN | TPM_BOTTOMALIGN | TPM_RIGHTBUTTON,
                pt.x,
                pt.y,
                0,
                self.hwnd,
                None,
            )
            # 防止菜单在点击空白处后不消失（Win32 官方要求）
            self.user32.PostMessageW(self.hwnd, 0, 0, 0)
        finally:
            self.user32.DestroyMenu(hmenu)

    def _handle_command(self, cmd_id: int) -> None:
        if cmd_id == IDM_OPEN_APP:
            self._open_ui_debounced(force_browser=False)
        elif cmd_id == IDM_OPEN_BROWSER:
            self._open_ui_debounced(force_browser=True)
        elif cmd_id == IDM_AUTOSTART:
            next_state = not is_autostart_enabled()
            set_autostart(next_state)
            nid = self._make_nid(
                NIF_INFO,
                balloon_title="开机自启已更新",
                balloon_msg="已开启开机自启，下次开机将自动静默驻留托盘。" if next_state else "已关闭开机自启。",
            )
            self.shell32.Shell_NotifyIconW(NIM_MODIFY, ctypes.byref(nid))
        elif cmd_id == IDM_COPY_LAN:
            lan_ips = get_lan_ipv4_addresses()
            addr = f"http://{lan_ips[0]}:{self.runtime.port}/" if lan_ips else f"http://127.0.0.1:{self.runtime.port}/"
            copy_to_clipboard(self.kernel32, self.user32, addr)
            nid = self._make_nid(
                NIF_INFO,
                balloon_title="已复制地址",
                balloon_msg=f"{addr}（UDP 自动发现端口 {self.runtime.udp_port}）",
            )
            self.shell32.Shell_NotifyIconW(NIM_MODIFY, ctypes.byref(nid))
        elif cmd_id == IDM_OPEN_DATA:
            try:
                os.startfile(str(self.runtime.data_dir))
            except Exception as exc:
                logging.error("打开数据目录失败: %s", exc)
        elif cmd_id == IDM_EXIT:
            self.user32.DestroyWindow(self.hwnd)

    def _wnd_proc(self, hwnd: int, msg: int, wparam: int, lparam: int) -> int:
        if msg == self.taskbar_created_msg and self.taskbar_created_msg != 0:
            self._add_tray_icon(show_balloon=False)
            return 0
        if msg == WM_TRAYICON:
            evt = lparam & 0xFFFF
            if evt in (WM_LBUTTONUP, WM_LBUTTONDBLCLK):
                self._open_ui_debounced(force_browser=False)
            elif evt in (WM_RBUTTONUP, WM_CONTEXTMENU):
                self._show_context_menu()
            return 0
        if msg == WM_COMMAND:
            self._handle_command(wparam & 0xFFFF)
            return 0
        if msg == WM_TIMER and wparam == TIMER_REFRESH_TIP:
            self._update_tray_tooltip()
            return 0
        if msg == WM_QUERYENDSESSION:
            return 1
        if msg == WM_ENDSESSION:
            if wparam:
                self._cleanup()
            return 0
        if msg == WM_CLOSE:
            self.user32.DestroyWindow(hwnd)
            return 0
        if msg == WM_DESTROY:
            self._cleanup()
            self.user32.PostQuitMessage(0)
            return 0
        return self.user32.DefWindowProcW(hwnd, msg, wparam, lparam)

    def _cleanup(self) -> None:
        if self.hwnd:
            self.user32.KillTimer(self.hwnd, TIMER_REFRESH_TIP)
        self._remove_tray_icon()
        self.runtime.stop()
        if self.hicon and self.icon_owned:
            self.user32.DestroyIcon(self.hicon)
            self.hicon = None

    def run(self) -> int:
        class_name = "DormSleepTrayMessageWindowClass"
        self.hicon = self._load_icon()

        wc = WNDCLASSEXW()
        wc.cbSize = ctypes.sizeof(WNDCLASSEXW)
        wc.lpfnWndProc = self._wndproc_ref
        wc.hInstance = self.hinstance
        wc.hIcon = self.hicon
        wc.hIconSm = self.hicon
        wc.lpszClassName = class_name
        self.user32.RegisterClassExW(ctypes.byref(wc))

        self.hwnd = self.user32.CreateWindowExW(
            0,
            class_name,
            APP_NAME,
            0,
            0,
            0,
            0,
            0,
            None,
            None,
            self.hinstance,
            None,
        )
        if not self.hwnd:
            raise RuntimeError("CreateWindowExW failed")

        self.runtime.start()
        self._add_tray_icon(show_balloon=not self.open_on_start)
        self.user32.SetTimer(self.hwnd, TIMER_REFRESH_TIP, 5000, None)

        if self.open_on_start:
            self._open_ui_debounced(force_browser=False)

        msg = wintypes.MSG()
        while self.user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            self.user32.TranslateMessage(ctypes.byref(msg))
            self.user32.DispatchMessageW(ctypes.byref(msg))
        return 0


def main() -> int:
    if sys.platform != "win32":
        print("tray_app.py 仅支持在 Windows 上运行，请使用 companion_server.py。")
        return 1

    args = set(sys.argv[1:])
    minimized = "--minimized" in args or "--autostart" in args
    port = int(os.environ.get("DORMSLEEP_COMPANION_PORT", "4180"))
    data_dir = get_default_data_dir()
    setup_logging(data_dir)

    kernel32, user32, _ = init_win32_apis()
    mutex = kernel32.CreateMutexW(None, False, MUTEX_NAME)
    if kernel32.GetLastError() == ERROR_ALREADY_EXISTS:
        logging.info("检测到熄灯守夜已在运行，直接唤起界面。")
        if not minimized:
            open_desktop_ui(port, data_dir, force_browser=False)
        if mutex:
            kernel32.CloseHandle(mutex)
        return 0

    try:
        runtime = CompanionRuntime(port=port, data_dir=data_dir)
        app = DormSleepTrayApp(runtime=runtime, open_on_start=not minimized)
        logging.info("启动熄灯守夜托盘服务，数据目录=%s，端口=%s", data_dir, port)
        return app.run()
    except Exception as exc:
        logging.exception("熄灯守夜启动失败")
        user32.MessageBoxW(
            None,
            f"熄灯守夜启动失败：{exc}\n\n请检查端口 {port} 是否被占用，或查看日志：\n{data_dir / 'companion.log'}",
            "熄灯守夜",
            MB_OK | MB_ICONERROR,
        )
        return 1
    finally:
        if mutex:
            kernel32.CloseHandle(mutex)


if __name__ == "__main__":
    sys.exit(main())
