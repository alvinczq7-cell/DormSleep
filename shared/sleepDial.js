// 熄灯守夜（DormSleep）现代渐变风（Modern Gradient）流光 24 小时表盘、15 分钟放行环与桌面守夜轴
// 纯原生内联 SVG，支持霓虹光晕弥散与无闪烁局部秒级刷新

function polarToCartesian(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: cx + r * Math.cos(rad),
    y: cy + r * Math.sin(rad),
  };
}

function describeArc(cx, cy, r, startAngle, endAngle) {
  let sweep = endAngle - startAngle;
  if (sweep <= 0) sweep += 360;
  if (sweep >= 359.4) sweep = 359.4;
  const start = polarToCartesian(cx, cy, r, startAngle);
  const end = polarToCartesian(cx, cy, r, startAngle + sweep);
  const largeArcFlag = sweep > 180 ? 1 : 0;
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${largeArcFlag} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

export function msTo24hAngle(ms) {
  const d = new Date(ms);
  const mins = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  return (mins / 1440) * 360;
}

export function computeSleepDurationText(startHm, endHm) {
  if (!startHm || !endHm || !startHm.includes(':') || !endHm.includes(':')) return '';
  const [sh, sm] = startHm.split(':').map(Number);
  const [eh, em] = endHm.split(':').map(Number);
  if ([sh, sm, eh, em].some(Number.isNaN)) return '';
  let diff = eh * 60 + em - (sh * 60 + sm);
  if (diff <= 0) diff += 1440;
  const h = Math.floor(diff / 60);
  const m = diff % 60;
  return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

/**
 * 现代渐变风 24 小时流光睡眠表盘
 * 采用深蓝紫玻璃内盘 + 紫罗兰/品红/青色流光渐变弧 + 柔和光晕弥散
 */
export function renderSleepDialSvg({
  nowMs,
  startAt,
  endAt,
  freezeCutoffAt = null,
  centerMain,
  centerSub,
  centerBadge = '',
  isNight = false,
  paused = false,
  isPreLock = false,
  size = 236,
}) {
  const vb = 248;
  const cx = 124;
  const cy = 124;
  const r = 92;
  const uid = isNight ? 'mgn' : isPreLock ? 'mgp' : 'mgd';

  const startDeg = msTo24hAngle(startAt);
  const endDeg = msTo24hAngle(endAt);
  const nowDeg = msTo24hAngle(nowMs);
  const startPt = polarToCartesian(cx, cy, r, startDeg);
  const endPt = polarToCartesian(cx, cy, r, endDeg);
  const nowPt = polarToCartesian(cx, cy, r, nowDeg);

  // 48 精密星轨刻度
  const ticks = [];
  for (let i = 0; i < 48; i++) {
    const deg = (i / 48) * 360;
    const isMajor = i % 12 === 0;
    const isHour = i % 2 === 0;
    const inner = r - (isMajor ? 16 : isHour ? 12.5 : 10);
    const outer = r - 7;
    const p1 = polarToCartesian(cx, cy, inner, deg);
    const p2 = polarToCartesian(cx, cy, outer, deg);
    const stroke = isMajor
      ? 'rgba(255, 255, 255, 0.42)'
      : isHour
        ? 'rgba(255, 255, 255, 0.16)'
        : 'rgba(255, 255, 255, 0.06)';
    ticks.push(
      `<line x1="${p1.x.toFixed(1)}" y1="${p1.y.toFixed(1)}" x2="${p2.x.toFixed(1)}" y2="${p2.y.toFixed(1)}" stroke="${stroke}" stroke-width="${isMajor ? 1.6 : 1}" stroke-linecap="round"/>`
    );
  }

  let cutoffMark = '';
  if (freezeCutoffAt && !paused) {
    const cutDeg = msTo24hAngle(freezeCutoffAt);
    const cp1 = polarToCartesian(cx, cy, r + 8, cutDeg);
    const cp2 = polarToCartesian(cx, cy, r + 13.5, cutDeg);
    cutoffMark = `<line x1="${cp1.x.toFixed(1)}" y1="${cp1.y.toFixed(1)}" x2="${cp2.x.toFixed(1)}" y2="${cp2.y.toFixed(1)}" stroke="#F472B6" stroke-width="2" stroke-linecap="round" opacity="0.85"/>`;
  }

  const arcPath = paused ? '' : describeArc(cx, cy, r, startDeg, endDeg);

  // StyleKit 现代渐变风标准多段光谱
  const stop1 = isPreLock ? '#F43F5E' : isNight ? '#8B5CF6' : '#06B6D4';
  const stop2 = isPreLock ? '#F97316' : isNight ? '#D946EF' : '#8B5CF6';
  const stop3 = isPreLock ? '#FBBF24' : isNight ? '#EC4899' : '#EC4899';
  const glowColor = isPreLock ? '#F97316' : isNight ? '#A855F7' : '#8B5CF6';
  const badgeColor = isPreLock ? '#FDBA74' : isNight ? '#E879F9' : '#67E8F9';

  const mainLen = String(centerMain || '').length;
  const mainFontSize = mainLen > 8 ? 21 : mainLen > 5 ? 25 : 31;

  return `
    <svg class="sleep-dial-svg" viewBox="0 0 ${vb} ${vb}" width="${size}" height="${size}" aria-hidden="true">
      <defs>
        <linearGradient id="arc-${uid}" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${stop1}"/>
          <stop offset="52%" stop-color="${stop2}"/>
          <stop offset="100%" stop-color="${stop3}"/>
        </linearGradient>
        <linearGradient id="txt-${uid}" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#FFFFFF"/>
          <stop offset="65%" stop-color="#E0E7FF"/>
          <stop offset="100%" stop-color="${isPreLock ? '#FDE68A' : '#F5D0FE'}"/>
        </linearGradient>
        <radialGradient id="halo-${uid}" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="${glowColor}" stop-opacity="0.26"/>
          <stop offset="58%" stop-color="${stop1}" stop-opacity="0.08"/>
          <stop offset="100%" stop-color="${glowColor}" stop-opacity="0"/>
        </radialGradient>
        <filter id="glow-${uid}" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="4.5" result="blur"/>
          <feMerge>
            <feMergeNode in="blur"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
      </defs>

      <!-- 弥散霓虹光晕 -->
      <circle cx="${cx}" cy="${cy}" r="120" fill="url(#halo-${uid})"/>

      <!-- 磨砂外轨底环 -->
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="11"/>

      <!-- 玻璃内表盘 -->
      <circle cx="${cx}" cy="${cy}" r="${r - 19}" fill="rgba(255,255,255,0.045)" stroke="rgba(255,255,255,0.13)" stroke-width="1.2"/>

      ${ticks.join('')}
      ${cutoffMark}

      <!-- 流光渐变主弧线 -->
      ${
        arcPath
          ? `<path d="${arcPath}" fill="none" stroke="url(#arc-${uid})" stroke-width="11" stroke-linecap="round" filter="url(#glow-${uid})"/>`
          : ''
      }

      ${
        arcPath
          ? `
            <circle cx="${startPt.x.toFixed(1)}" cy="${startPt.y.toFixed(1)}" r="3.2" fill="#FFFFFF" opacity="0.92"/>
            <circle cx="${endPt.x.toFixed(1)}" cy="${endPt.y.toFixed(1)}" r="3.2" fill="#FFFFFF" opacity="0.92"/>
          `
          : ''
      }

      <!-- 当前时刻高亮信标 -->
      <g data-dial-now="1">
        <circle cx="${nowPt.x.toFixed(1)}" cy="${nowPt.y.toFixed(1)}" r="9.5" fill="#22D3EE" fill-opacity="0.25"/>
        <circle cx="${nowPt.x.toFixed(1)}" cy="${nowPt.y.toFixed(1)}" r="5" fill="#FFFFFF" stroke="#0B1024" stroke-width="2"/>
      </g>

      <!-- 00 / 06 / 12 / 18 时标 -->
      <text x="${cx}" y="64" text-anchor="middle" font-size="9.5" font-weight="700" fill="rgba(255,255,255,0.45)" font-family="ui-monospace,Consolas,monospace">00</text>
      <text x="186" y="${cy + 3.5}" text-anchor="middle" font-size="9.5" font-weight="700" fill="rgba(255,255,255,0.45)" font-family="ui-monospace,Consolas,monospace">06</text>
      <text x="${cx}" y="191" text-anchor="middle" font-size="9.5" font-weight="700" fill="rgba(255,255,255,0.45)" font-family="ui-monospace,Consolas,monospace">12</text>
      <text x="62" y="${cy + 3.5}" text-anchor="middle" font-size="9.5" font-weight="700" fill="rgba(255,255,255,0.45)" font-family="ui-monospace,Consolas,monospace">18</text>

      ${
        centerBadge
          ? `<text x="${cx}" y="${cy - 22}" text-anchor="middle" font-size="10.5" font-weight="700" fill="${badgeColor}" letter-spacing="0.5">${centerBadge}</text>`
          : ''
      }
      <text data-dial-main="1" x="${cx}" y="${cy + 7}" text-anchor="middle" font-size="${mainFontSize}" font-weight="800" fill="url(#txt-${uid})" style="font-variant-numeric:tabular-nums;letter-spacing:-0.6px;">${centerMain}</text>
      <text data-dial-sub="1" x="${cx}" y="${cy + 27}" text-anchor="middle" font-size="11.5" font-weight="500" fill="rgba(226,232,255,0.68)">${centerSub}</text>
    </svg>
  `;
}

/**
 * 现代渐变风 15 分钟临时放行流光秒表环（青绿流光，末分钟转粉橙预警）
 */
export function renderAllowRingSvg({ remMs, totalMs, appName, expiresText = '', size = 236 }) {
  const vb = 248;
  const cx = 124;
  const cy = 124;
  const r = 92;
  const circumference = 2 * Math.PI * r;
  const ratio = Math.max(0, Math.min(1, remMs / Math.max(1, totalMs)));
  const dashOffset = circumference * (1 - ratio);
  const nearEnd = remMs <= 60 * 1000;

  const mins = Math.floor(Math.max(0, remMs) / 60000);
  const secs = Math.floor((Math.max(0, remMs) % 60000) / 1000);
  const timeText = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  const gradId = nearEnd ? 'allow-warn' : 'allow-cyan';
  const labelColor = nearEnd ? '#FDBA74' : '#5EEAD4';

  const ticks = [];
  for (let i = 0; i < 60; i++) {
    const deg = (i / 60) * 360;
    const major = i % 5 === 0;
    const p1 = polarToCartesian(cx, cy, r - (major ? 15 : 11.5), deg);
    const p2 = polarToCartesian(cx, cy, r - 7.5, deg);
    ticks.push(
      `<line x1="${p1.x.toFixed(1)}" y1="${p1.y.toFixed(1)}" x2="${p2.x.toFixed(1)}" y2="${p2.y.toFixed(1)}" stroke="${
        major ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.09)'
      }" stroke-width="${major ? 1.4 : 1}" stroke-linecap="round"/>`
    );
  }

  return `
    <svg class="sleep-dial-svg" viewBox="0 0 ${vb} ${vb}" width="${size}" height="${size}" aria-hidden="true">
      <defs>
        <linearGradient id="allow-cyan" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#34D399"/>
          <stop offset="55%" stop-color="#06B6D4"/>
          <stop offset="100%" stop-color="#3B82F6"/>
        </linearGradient>
        <linearGradient id="allow-warn" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#FBBF24"/>
          <stop offset="55%" stop-color="#F97316"/>
          <stop offset="100%" stop-color="#EC4899"/>
        </linearGradient>
        <radialGradient id="allow-halo" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="${nearEnd ? '#F97316' : '#06B6D4'}" stop-opacity="0.24"/>
          <stop offset="72%" stop-color="${nearEnd ? '#EC4899' : '#10B981'}" stop-opacity="0"/>
        </radialGradient>
        <filter id="allow-glow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="4" result="blur"/>
          <feMerge>
            <feMergeNode in="blur"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
      </defs>

      <circle cx="${cx}" cy="${cy}" r="118" fill="url(#allow-halo)"/>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(255,255,255,0.09)" stroke-width="10"/>
      <circle cx="${cx}" cy="${cy}" r="${r - 19}" fill="rgba(255,255,255,0.045)" stroke="rgba(255,255,255,0.14)" stroke-width="1.2"/>
      ${ticks.join('')}
      <circle data-allow-ring="1" data-allow-r="${r}" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="url(#${gradId})" stroke-width="10" stroke-linecap="round"
        filter="url(#allow-glow)"
        stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${dashOffset.toFixed(2)}"
        transform="rotate(-90 ${cx} ${cy})" style="transition:stroke-dashoffset 0.55s linear;"/>

      <text x="${cx}" y="${cy - 24}" text-anchor="middle" font-size="10.5" font-weight="700" fill="${labelColor}" letter-spacing="0.4">${nearEnd ? '即将自动恢复拦截' : '单应用临时放行'}</text>
      <text data-dial-main="1" x="${cx}" y="${cy + 10}" text-anchor="middle" font-size="34" font-weight="800" fill="#FFFFFF" style="font-family:ui-monospace,Consolas,monospace;font-variant-numeric:tabular-nums;letter-spacing:-1px;">${timeText}</text>
      <text x="${cx}" y="${cy + 30}" text-anchor="middle" font-size="11.5" font-weight="600" fill="rgba(255,255,255,0.82)">仅放行 ${appName}</text>
      ${
        expiresText
          ? `<text x="${cx}" y="${cy + 46}" text-anchor="middle" font-size="10" font-weight="500" fill="rgba(226,232,255,0.52)">${expiresText} 自动恢复</text>`
          : ''
      }
    </svg>
  `;
}

/**
 * 桌面端专属：以午夜 00:00 为中心的 24 小时流光守夜轴
 */
export function renderRhythmBarSvg({
  nowMs,
  startAt,
  endAt,
  freezeCutoffAt = null,
  paused = false,
  tone = 'violet', // 'violet' | 'sunset' | 'cyan'
}) {
  function msToNoonOffsetPct(ms) {
    const d = new Date(ms);
    let mins = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
    mins = (mins - 720 + 1440) % 1440;
    return (mins / 1440) * 100;
  }

  const w = 540;
  const h = 48;
  const padX = 16;
  const trackW = w - padX * 2;
  const trackY = 18;
  const toX = (pct) => padX + (pct / 100) * trackW;

  const sPct = msToNoonOffsetPct(startAt);
  const ePct = msToNoonOffsetPct(endAt);
  const nPct = msToNoonOffsetPct(nowMs);
  const cPct = freezeCutoffAt ? msToNoonOffsetPct(freezeCutoffAt) : null;

  const c1 = tone === 'sunset' ? '#F43F5E' : tone === 'cyan' ? '#34D399' : '#22D3EE';
  const c2 = tone === 'sunset' ? '#F97316' : tone === 'cyan' ? '#06B6D4' : '#8B5CF6';
  const c3 = tone === 'sunset' ? '#FBBF24' : tone === 'cyan' ? '#3B82F6' : '#EC4899';
  const gid = `rhythm-${tone}`;

  let rangeBars = '';
  if (!paused) {
    if (ePct > sPct) {
      const x = toX(sPct);
      const rw = Math.max(6, toX(ePct) - x);
      rangeBars = `<rect x="${x.toFixed(1)}" y="${trackY - 4.5}" width="${rw.toFixed(1)}" height="9" rx="4.5" fill="url(#${gid})" filter="url(#rglow-${tone})"/>`;
    } else {
      const x1 = toX(sPct);
      const w1 = Math.max(4, padX + trackW - x1);
      const w2 = Math.max(4, toX(ePct) - padX);
      rangeBars = `
        <rect x="${x1.toFixed(1)}" y="${trackY - 4.5}" width="${w1.toFixed(1)}" height="9" rx="4.5" fill="url(#${gid})" filter="url(#rglow-${tone})"/>
        <rect x="${padX}" y="${trackY - 4.5}" width="${w2.toFixed(1)}" height="9" rx="4.5" fill="url(#${gid})" filter="url(#rglow-${tone})"/>
      `;
    }
  }

  const cutoffLine =
    !paused && cPct !== null
      ? `<line x1="${toX(cPct).toFixed(1)}" y1="${trackY - 8.5}" x2="${toX(cPct).toFixed(1)}" y2="${trackY + 8.5}" stroke="#F472B6" stroke-width="1.6" stroke-dasharray="2 2" opacity="0.8"/>`
      : '';

  const marks = [
    { pct: 0, text: '12:00' },
    { pct: 25, text: '18:00' },
    { pct: 50, text: '00:00' },
    { pct: 75, text: '06:00' },
    { pct: 100, text: '12:00' },
  ];

  return `
    <svg class="rhythm-bar-svg" viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <defs>
        <linearGradient id="${gid}" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="${c1}"/>
          <stop offset="52%" stop-color="${c2}"/>
          <stop offset="100%" stop-color="${c3}"/>
        </linearGradient>
        <filter id="rglow-${tone}" x="-10%" y="-60%" width="120%" height="220%">
          <feGaussianBlur stdDeviation="2.5" result="blur"/>
          <feMerge>
            <feMergeNode in="blur"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
      </defs>
      <rect x="${padX}" y="${trackY - 3}" width="${trackW}" height="6" rx="3" fill="rgba(255,255,255,0.1)"/>
      ${cutoffLine}
      ${rangeBars}
      <circle cx="${toX(nPct).toFixed(1)}" cy="${trackY}" r="8" fill="#22D3EE" fill-opacity="0.28"/>
      <circle cx="${toX(nPct).toFixed(1)}" cy="${trackY}" r="4.3" fill="#FFFFFF" stroke="#0B1024" stroke-width="1.8"/>
      ${marks
        .map(
          (m) =>
            `<text x="${toX(m.pct).toFixed(1)}" y="${h - 4}" text-anchor="${m.pct === 0 ? 'start' : m.pct === 100 ? 'end' : 'middle'}" font-size="10" font-weight="600" fill="rgba(226,232,255,0.5)" font-family="ui-monospace,Consolas,monospace">${m.text}</text>`
        )
        .join('')}
    </svg>
  `;
}
