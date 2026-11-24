#!/usr/bin/env python3
"""
生成熄灯守夜（DormSleep）瑞士极简表盘风格多分辨率 Windows .ico 图标。
视觉语言与手机端 24 小时睡眠表盘一致：暖炭黑圆角底 + 细表盘环 + 朱砂暖橙夜间弧 + 暖白刻度点。
"""

from __future__ import annotations

import math
from pathlib import Path
from PIL import Image, ImageDraw

OUT_PATH = Path(__file__).resolve().parent / "assets" / "dormsleep.ico"


def render_icon(size: int = 512) -> Image.Image:
    # 4x 超采样抗锯齿绘制
    scale = 2
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    pad = int(s * 0.06)
    radius = int(s * 0.22)
    # 深暖炭黑圆角方底
    draw.rounded_rectangle(
        [pad, pad, s - pad, s - pad],
        radius=radius,
        fill=(22, 22, 20, 255),
        outline=(52, 50, 46, 255),
        width=max(2, int(s * 0.015)),
    )

    cx = s / 2.0
    cy = s / 2.0
    ring_r = s * 0.305
    ring_w = int(s * 0.078)
    bbox = [cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r]

    # 浅墨灰整圆表盘轨道
    draw.ellipse(bbox, outline=(62, 60, 55, 255), width=ring_w)

    # 朱砂暖橙夜间弧段（模拟 23:30 到 07:00：顶部偏左顺时针延伸至右侧）
    # PIL 角度以 3 点钟方向为 0 度，顺时针增加；12 点钟为 -90 度 (270 度)
    start_deg = 255.0
    end_deg = 20.0  # 跨越 360 度 -> 弧长 125 度
    draw.arc(bbox, start=start_deg, end=end_deg, fill=(212, 87, 42, 255), width=ring_w)

    # 在弧段两端补圆帽，使表盘弧更温润精致
    cap_r = ring_w / 2.0
    mid_r = ring_r - ring_w / 2.0
    for deg in (start_deg, end_deg):
        rad = math.radians(deg)
        px = cx + mid_r * math.cos(rad)
        py = cy + mid_r * math.sin(rad)
        draw.ellipse([px - cap_r, py - cap_r, px + cap_r, py + cap_r], fill=(212, 87, 42, 255))

    # 中心温润米白月点（象征夜间静谧核心）
    dot_r = s * 0.068
    draw.ellipse([cx - dot_r, cy - dot_r, cx + dot_r, cy + dot_r], fill=(246, 245, 241, 255))

    # 12/3/6/9 点极简微刻度点
    tick_r = s * 0.018
    tick_orbit = s * 0.382
    for deg in (0, 90, 180, 270):
        rad = math.radians(deg)
        tx = cx + tick_orbit * math.cos(rad)
        ty = cy + tick_orbit * math.sin(rad)
        draw.ellipse([tx - tick_r, ty - tick_r, tx + tick_r, ty + tick_r], fill=(141, 139, 132, 210))

    return img.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    base = render_icon(512)
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    base.save(OUT_PATH, format="ICO", sizes=sizes)
    # 同步导出 PNG 预览备用
    base.resize((256, 256), Image.Resampling.LANCZOS).save(OUT_PATH.with_suffix(".png"), format="PNG")
    print(f"Generated icon: {OUT_PATH} ({OUT_PATH.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
