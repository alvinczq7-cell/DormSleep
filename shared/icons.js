// 熄灯守夜（DormSleep）现代渐变风（Modern Gradient）矢量图标库与发光玻璃应用徽章
// 100% 纯离线内联 SVG，零外部资源依赖

function svg(body, size = 18, cls = '', strokeWidth = 1.85) {
  return `<svg class="ico ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export const ICONS = {
  // 现代渐变风专属品牌徽章：紫罗兰 → 品红 → 青色流光玻璃底 + 莹白新月与星芒
  brandMark: (s = 30) => `
    <svg class="ico brand-ico" width="${s}" height="${s}" viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="ds-brand-bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#8B5CF6"/>
          <stop offset="52%" stop-color="#C026D3"/>
          <stop offset="100%" stop-color="#06B6D4"/>
        </linearGradient>
        <linearGradient id="ds-brand-moon" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#FFFFFF"/>
          <stop offset="100%" stop-color="#E0E7FF"/>
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="12" fill="url(#ds-brand-bg)"/>
      <rect x="0.75" y="0.75" width="38.5" height="38.5" rx="11.25" stroke="rgba(255,255,255,0.34)" stroke-width="1.5"/>
      <path d="M26.2 22.8A9.4 9.4 0 1 1 17 11.4a7.4 7.4 0 0 0 9.2 11.4Z" fill="url(#ds-brand-moon)"/>
      <path d="M27.6 10.6 28.4 13l2.4.8-2.4.8-.8 2.4-.8-2.4-2.4-.8 2.4-.8.8-2.4Z" fill="#FFFBEB"/>
    </svg>
  `,

  moon: (s = 18) => svg('<path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a6.8 6.8 0 0 0 11 11Z"/>', s),
  sun: (s = 18) => svg('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M5.28 5.28l1.56 1.56M17.16 17.16l1.56 1.56M2.5 12h2.2M19.3 12h2.2M5.28 18.72l1.56-1.56M17.16 6.84l1.56-1.56"/>', s),
  sunset: (s = 18) => svg('<path d="M12 10V4m-4.2 6.8L6.3 9.3m9.9 1.5 1.5-1.5M4 17h16M7 17a5 5 0 0 1 10 0M6 21h12"/>', s),
  calendar: (s = 18) => svg('<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M8 3v3.5M16 3v3.5M3.5 10.5h17"/>', s),
  grid: (s = 18) => svg('<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>', s),
  laptop: (s = 18) => svg('<rect x="3.5" y="4.5" width="17" height="11.5" rx="2.2"/><path d="M2 19.5h20"/>', s),
  smartphone: (s = 18) => svg('<rect x="6.5" y="2.5" width="11" height="19" rx="2.6"/><path d="M11 18h2"/>', s),
  lock: (s = 18) => svg('<rect x="4.5" y="11" width="15" height="10" rx="2.6"/><path d="M8 11V7.8a4 4 0 0 1 8 0V11"/>', s),
  unlock: (s = 18) => svg('<rect x="4.5" y="11" width="15" height="10" rx="2.6"/><path d="M8 11V7.8a4 4 0 0 1 7.3-2.2"/>', s),
  key: (s = 18) => svg('<circle cx="8" cy="15" r="4.2"/><path d="m20.5 3.5-9.2 9.2M15.8 8.2l2.9 2.9M18.3 5.7l2.4 2.4"/>', s),
  shield: (s = 18) => svg('<path d="M12 21.5s7.5-3.8 7.5-9.8V5.5L12 2.8 4.5 5.5v6.2c0 6 7.5 9.8 7.5 9.8Z"/>', s),
  shieldCheck: (s = 18) => svg('<path d="M12 21.5s7.5-3.8 7.5-9.8V5.5L12 2.8 4.5 5.5v6.2c0 6 7.5 9.8 7.5 9.8Z"/><path d="m9 12.2 2 2.1 4.2-4.4"/>', s),
  shieldAlert: (s = 18) => svg('<path d="M12 21.5s7.5-3.8 7.5-9.8V5.5L12 2.8 4.5 5.5v6.2c0 6 7.5 9.8 7.5 9.8Z"/><path d="M12 8.5v4.2M12 15.8h.01"/>', s),
  phone: (s = 18) => svg('<path d="M21.2 16.8v2.8a1.9 1.9 0 0 1-2.1 1.9 18.8 18.8 0 0 1-8.2-2.9 18.5 18.5 0 0 1-5.7-5.7 18.8 18.8 0 0 1-2.9-8.3A1.9 1.9 0 0 1 4.2 2.5H7a1.9 1.9 0 0 1 1.9 1.6c.1.9.3 1.8.6 2.7a1.9 1.9 0 0 1-.4 2L7.9 10a15.2 15.2 0 0 0 5.7 5.7l1.2-1.2a1.9 1.9 0 0 1 2-.4c.9.3 1.8.5 2.7.6a1.9 1.9 0 0 1 1.7 2.1Z"/>', s),
  message: (s = 18) => svg('<path d="M4.5 6.5A2.5 2.5 0 0 1 7 4h10a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 17 16H9.8L5.5 19.5V16A2.5 2.5 0 0 1 4.5 14v-7.5Z"/>', s),
  clock: (s = 18) => svg('<circle cx="12" cy="12" r="8.8"/><path d="M12 7.2V12l3.2 2"/>', s),
  alarm: (s = 18) => svg('<circle cx="12" cy="13" r="7.8"/><path d="M12 9v4l2.6 1.6M5.2 3.5 2.5 6.2M18.8 3.5l2.7 2.7"/>', s),
  idCard: (s = 18) => svg('<rect x="2.5" y="5" width="19" height="14" rx="2.6"/><circle cx="8.5" cy="11.2" r="2"/><path d="M13.8 10h4.2M13.8 14h3.2M5.8 16.2c.6-1.3 1.6-2 2.7-2s2.1.7 2.7 2"/>', s),
  wifi: (s = 18) => svg('<path d="M4.5 11.8a11.5 11.5 0 0 1 15 0M7.8 15.3a6.8 6.8 0 0 1 8.4 0M12 19h.01"/>', s),
  wifiOff: (s = 18) => svg('<path d="M2.5 2.5 21.5 21.5M8.2 15.6a6.2 6.2 0 0 1 7.2-.4M3.5 10.6a12.5 12.5 0 0 1 4.2-2.4M11 7.2a11.8 11.8 0 0 1 9.5 3.6M12 19h.01"/>', s),
  copy: (s = 16) => svg('<rect x="9" y="9" width="11.5" height="11.5" rx="2.2"/><path d="M5.5 15H4.8a2 2 0 0 1-2-2V4.8a2 2 0 0 1 2-2H13a2 2 0 0 1 2 2v.7"/>', s),
  check: (s = 16) => svg('<path d="m19.5 6.5-9.8 10L4.5 11.3"/>', s, '', 2.15),
  power: (s = 18) => svg('<path d="M17.8 6.8a8.2 8.2 0 1 1-11.6 0M12 2.8v8.8"/>', s),
  sliders: (s = 16) => svg('<path d="M4 20v-6.5M4 9.5V4M12 20v-8.5M12 7.5V4M20 20v-4.5M20 11.5V4M1.8 13.5h4.4M9.8 7.5h4.4M17.8 15.5h4.4"/>', s),
  flask: (s = 18) => svg('<path d="M9.5 3h5M10 3v5.4L5.4 17.6A2.2 2.2 0 0 0 7.4 20.8h9.2a2.2 2.2 0 0 0 2-3.2L14 8.4V3"/>', s),
  arrowLeft: (s = 18) => svg('<path d="m15 18-6-6 6-6"/>', s),
  chevronRight: (s = 16) => svg('<path d="m9 6 6 6-6 6"/>', s),
  chevronDown: (s = 16) => svg('<path d="m6 9 6 6 6-6"/>', s),
  alert: (s = 16) => svg('<path d="M10.3 3.9 2.1 18a1.9 1.9 0 0 0 1.7 2.9h16.4a1.9 1.9 0 0 0 1.7-2.9L13.7 3.9a1.9 1.9 0 0 0-3.4 0ZM12 9.2v4.2M12 16.8h.01"/>', s),
  refresh: (s = 16) => svg('<path d="M20.5 12a8.5 8.5 0 1 1-2.5-6l2.5 2.5M20.5 3.8v4.7h-4.7"/>', s),
  history: (s = 18) => svg('<path d="M3.5 12a8.5 8.5 0 1 0 2.3-5.8L3.5 8.5M3.5 4v4.5H8M12 7.8V12l3 1.8"/>', s),
  link: (s = 18) => svg('<path d="M10 13.5a4.5 4.5 0 0 0 6.4.4l2.4-2.4a4.5 4.5 0 0 0-6.4-6.4L11 6.5M14 10.5a4.5 4.5 0 0 0-6.4-.4l-2.4 2.4a4.5 4.5 0 1 0 6.4 6.4L13 17.5"/>', s),
  unlink: (s = 18) => svg('<path d="m18.8 12.2 1.2-1.2a4.2 4.2 0 0 0-6-6l-1.2 1.2M5.2 11.8 4 13a4.2 4.2 0 1 0 6 6l1.2-1.2M8 3v2.5M3 8h2.5M16 21v-2.5M21 16h-2.5"/>', s),
  keyboard: (s = 16) => svg('<rect x="2.5" y="5.5" width="19" height="13" rx="2.5"/><path d="M6.5 9.5h.01M10 9.5h.01M13.5 9.5h.01M17 9.5h.01M7.5 14.5h9"/>', s),
  sparkles: (s = 16) => svg('<path d="m12 3 1.7 4.8L18.5 9.5l-4.8 1.7L12 16l-1.7-4.8L5.5 9.5l4.8-1.7L12 3ZM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z"/>', s),
  externalLink: (s = 14) => svg('<path d="M14.5 4.5H19.5V9.5M19.5 4.5 10.5 13.5M18 13.5v4a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>', s),
};

// 现代渐变风发光玻璃应用徽章（深色宇宙玻璃背景上通透明亮）
export const APP_BADGE_META = {
  'com.android.dialer': {
    grad: 'linear-gradient(135deg, rgba(16, 185, 129, 0.28), rgba(6, 182, 212, 0.18))',
    ring: 'rgba(52, 211, 153, 0.36)',
    fg: '#6EE7B7',
    glyph: '<path d="M19 15.8v2.1a1.5 1.5 0 0 1-1.6 1.5 14.5 14.5 0 0 1-6.3-2.3 14.2 14.2 0 0 1-4.4-4.4 14.5 14.5 0 0 1-2.3-6.4A1.5 1.5 0 0 1 5.9 4.7H8a1.5 1.5 0 0 1 1.5 1.3c.1.7.2 1.4.5 2a1.5 1.5 0 0 1-.3 1.5l-.9.9a11.7 11.7 0 0 0 4.4 4.4l.9-.9a1.5 1.5 0 0 1 1.5-.3c.7.2 1.4.4 2.1.5a1.5 1.5 0 0 1 1.3 1.7Z"/>',
  },
  'com.android.mms': {
    grad: 'linear-gradient(135deg, rgba(59, 130, 246, 0.30), rgba(6, 182, 212, 0.20))',
    ring: 'rgba(96, 165, 250, 0.38)',
    fg: '#93C5FD',
    glyph: '<path d="M5.5 7.5A2 2 0 0 1 7.5 5.5h9a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-6.2L6.5 18.5v-3h-1a2 2 0 0 1-2-2v-6Z"/><path d="M9 10.2h6M9 13h3.8"/>',
  },
  'com.android.deskclock': {
    grad: 'linear-gradient(135deg, rgba(245, 158, 11, 0.30), rgba(249, 115, 22, 0.20))',
    ring: 'rgba(251, 191, 36, 0.38)',
    fg: '#FDE68A',
    glyph: '<circle cx="12" cy="13" r="6.2"/><path d="M12 9.8V13l2.2 1.3M6.5 5.2 4.5 7.2M17.5 5.2l2 2"/>',
  },
  'edu.campus.card': {
    grad: 'linear-gradient(135deg, rgba(6, 182, 212, 0.30), rgba(16, 185, 129, 0.20))',
    ring: 'rgba(34, 211, 238, 0.38)',
    fg: '#67E8F9',
    glyph: '<rect x="4" y="6.2" width="16" height="11.6" rx="2.2"/><circle cx="9.2" cy="11.4" r="1.7"/><path d="M13.5 10.4h3.5M13.5 13.6h2.6M7 15.2c.5-1 1.3-1.5 2.2-1.5s1.7.5 2.2 1.5"/>',
  },
  'com.auth.campus': {
    grad: 'linear-gradient(135deg, rgba(99, 102, 241, 0.32), rgba(139, 92, 246, 0.22))',
    ring: 'rgba(129, 140, 248, 0.40)',
    fg: '#C7D2FE',
    glyph: '<path d="M12 19.8s6-3 6-7.8V6.8L12 4.5 6 6.8V12c0 4.8 6 7.8 6 7.8Z"/><path d="m9.6 12 1.7 1.7 3.3-3.5"/>',
  },
  'com.tencent.mm': {
    grad: 'linear-gradient(135deg, rgba(34, 197, 94, 0.28), rgba(16, 185, 129, 0.18))',
    ring: 'rgba(74, 222, 128, 0.36)',
    fg: '#86EFAC',
    glyph: '<path d="M9.8 14.8c-3 0-5.3-2-5.3-4.5s2.3-4.5 5.3-4.5 5.3 2 5.3 4.5c0 .7-.2 1.4-.5 2"/><path d="M14.8 18.2c2.6 0 4.7-1.7 4.7-3.8s-2.1-3.8-4.7-3.8-4.7 1.7-4.7 3.8 2.1 3.8 4.7 3.8Z"/><circle cx="8.2" cy="9.8" r="0.7" fill="currentColor"/><circle cx="11.4" cy="9.8" r="0.7" fill="currentColor"/>',
  },
  'com.eg.android.AlipayGphone': {
    grad: 'linear-gradient(135deg, rgba(14, 165, 233, 0.30), rgba(59, 130, 246, 0.22))',
    ring: 'rgba(56, 189, 248, 0.40)',
    fg: '#7DD3FC',
    glyph: '<path d="M7 7.5h10M12 5v5M7.5 10.5h9c-.6 3.5-2.8 6-6.5 7.5M8.5 13.5c2.2 1.2 5.2 2.8 8.5 4"/>',
  },
  'tv.danmaku.bili': {
    grad: 'linear-gradient(135deg, rgba(236, 72, 153, 0.32), rgba(217, 70, 239, 0.20))',
    ring: 'rgba(244, 114, 182, 0.42)',
    fg: '#F9A8D4',
    glyph: '<rect x="4.5" y="7.5" width="15" height="11" rx="2.8"/><path d="M8.5 4.8 10.6 7.5M15.5 4.8 13.4 7.5M9.5 12.2v1.6M14.5 12.2v1.6"/>',
  },
  'com.ss.android.ugc.aweme': {
    grad: 'linear-gradient(135deg, rgba(6, 182, 212, 0.24), rgba(236, 72, 153, 0.24))',
    ring: 'rgba(255, 255, 255, 0.26)',
    fg: '#F1F5F9',
    glyph: '<path d="M13.8 5.2v9.4a3.1 3.1 0 1 1-2.3-3"/><path d="M13.8 6.4c1.1 1.7 2.8 2.6 4.7 2.7"/>',
  },
  'com.xingin.xhs': {
    grad: 'linear-gradient(135deg, rgba(244, 63, 94, 0.32), rgba(249, 115, 22, 0.20))',
    ring: 'rgba(251, 113, 133, 0.40)',
    fg: '#FDA4AF',
    glyph: '<path d="M6 5.5h9.5a2.5 2.5 0 0 1 2.5 2.5v10.5H8.5A2.5 2.5 0 0 0 6 20V5.5Z"/><path d="M6 17.5h12M9.8 9.8h4.5M9.8 13h3.2"/>',
  },
  'com.sina.weibo': {
    grad: 'linear-gradient(135deg, rgba(249, 115, 22, 0.32), rgba(236, 72, 153, 0.20))',
    ring: 'rgba(251, 146, 60, 0.40)',
    fg: '#FDBA74',
    glyph: '<ellipse cx="10.8" cy="14" rx="5.8" ry="4.2"/><circle cx="10.4" cy="14" r="1.4" fill="currentColor"/><path d="M14.5 7.2a4.6 4.6 0 0 1 4.3 4.3M15.8 4.8a7.2 7.2 0 0 1 5.4 5.4"/>',
  },
  'com.tencent.tmgp.sgame': {
    grad: 'linear-gradient(135deg, rgba(245, 158, 11, 0.30), rgba(168, 85, 247, 0.24))',
    ring: 'rgba(251, 191, 36, 0.38)',
    fg: '#FDE047',
    glyph: '<rect x="4" y="8" width="16" height="8.5" rx="4.2"/><path d="M8.5 10.6v3.3M6.9 12.2h3.2M15.5 11.4h.01M17.2 13h.01"/>',
  },
  'com.miHoYo.Yuanshen': {
    grad: 'linear-gradient(135deg, rgba(139, 92, 246, 0.34), rgba(59, 130, 246, 0.24))',
    ring: 'rgba(167, 139, 250, 0.44)',
    fg: '#DDD6FE',
    glyph: '<path d="m12 4.2 1.9 5.9 5.9 1.9-5.9 1.9L12 19.8l-1.9-5.9-5.9-1.9 5.9-1.9L12 4.2Z"/>',
  },
};

export function renderAppGlyph(appId, size = 36) {
  const m = APP_BADGE_META[appId] || {
    grad: 'linear-gradient(135deg, rgba(139, 92, 246, 0.24), rgba(6, 182, 212, 0.16))',
    ring: 'rgba(255, 255, 255, 0.18)',
    fg: '#E2E8F0',
    glyph: '<rect x="6" y="6" width="12" height="12" rx="3"/>',
  };
  const icoSize = Math.round(size * 0.56);
  const radius = Math.round(size * 0.3);
  return `
    <span class="app-glyph" style="width:${size}px;height:${size}px;border-radius:${radius}px;background:${m.grad};border:1px solid ${m.ring};color:${m.fg};">
      <svg width="${icoSize}" height="${icoSize}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.95" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${m.glyph}</svg>
    </span>
  `;
}
