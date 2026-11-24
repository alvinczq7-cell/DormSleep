#!/usr/bin/env python3
r"""
将熄灯守夜 Windows 伴随服务 + 系统托盘程序打包为单文件独立可执行程序 DormSleep.exe。
构建缓存与工作目录默认放到 G:\Android\.pyinstaller-work（避免占用紧缺的 C 盘空间），
最终输出直接拷贝到：
  - C:\Users\Administrator\work\dormsleep\DormSleep.exe
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parent
ROOT_DIR = SERVICE_DIR.parent.parent


def stage_webroot(stage_dir: Path, ico_path: Path) -> Path:
    webroot = stage_dir / "webroot"
    if webroot.exists():
        shutil.rmtree(webroot)

    # 仅打包桌面端真正需要的纯前端文件，不含测试或安卓工程
    shutil.copytree(ROOT_DIR / "apps" / "desktop", webroot / "apps" / "desktop")
    shutil.copytree(ROOT_DIR / "shared", webroot / "shared")
    shutil.copytree(ROOT_DIR / "adapters", webroot / "adapters")
    shutil.copy2(ico_path, webroot / "favicon.ico")
    return webroot


def main() -> int:
    work_root = Path(os.environ.get("DORMSLEEP_BUILD_WORK", r"G:\Android\.pyinstaller-work"))
    work_root.mkdir(parents=True, exist_ok=True)

    ico_path = SERVICE_DIR / "assets" / "dormsleep.ico"
    if not ico_path.is_file():
        print("缺少图标文件，请先运行 build_icon.py 生成 assets/dormsleep.ico", file=sys.stderr)
        return 1

    stage_dir = work_root / "stage"
    dist_dir = work_root / "dist"
    build_dir = work_root / "build"
    spec_dir = work_root / "spec"
    webroot = stage_webroot(stage_dir, ico_path)

    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onefile",
        "--windowed",
        "--name",
        "DormSleep",
        "--icon",
        str(ico_path),
        "--distpath",
        str(dist_dir),
        "--workpath",
        str(build_dir),
        "--specpath",
        str(spec_dir),
        "--paths",
        str(SERVICE_DIR),
        "--add-data",
        f"{webroot};webroot",
        "--hidden-import",
        "companion_server",
        "--hidden-import",
        "crypto_core",
        "--hidden-import",
        "lan_discovery",
        "--hidden-import",
        "secure_store",
        "--hidden-import",
        "storage",
        str(SERVICE_DIR / "tray_app.py"),
    ]

    print("Running:", " ".join(cmd))
    res = subprocess.run(cmd)
    if res.returncode != 0:
        return res.returncode

    built_exe = dist_dir / "DormSleep.exe"
    target_exe = ROOT_DIR / "DormSleep.exe"
    shutil.copy2(built_exe, target_exe)
    size_mb = target_exe.stat().st_size / (1024 * 1024)
    print(f"\n[OK] Packaged standalone executable: {target_exe} ({size_mb:.2f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
