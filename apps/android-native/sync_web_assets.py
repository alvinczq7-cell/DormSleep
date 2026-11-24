#!/usr/bin/env python3
"""
将仓库前端资源 (apps/mobile, shared, adapters) 同步复制到 Android 工程的
app/src/main/assets/www/，供 Jetpack WebViewAssetLoader 直接加载。
"""

import shutil
from pathlib import Path

ANDROID_ROOT = Path(__file__).resolve().parent
REPO_ROOT = ANDROID_ROOT.parent.parent
WWW_DIR = ANDROID_ROOT / "app" / "src" / "main" / "assets" / "www"


def sync_assets() -> None:
    if WWW_DIR.exists():
        shutil.rmtree(WWW_DIR)
    WWW_DIR.mkdir(parents=True, exist_ok=True)

    shutil.copytree(REPO_ROOT / "apps" / "mobile", WWW_DIR / "mobile")
    shutil.copytree(REPO_ROOT / "shared", WWW_DIR / "shared")
    shutil.copytree(REPO_ROOT / "adapters", WWW_DIR / "adapters")
    print(f"Synced web assets into {WWW_DIR}")


if __name__ == "__main__":
    sync_assets()
