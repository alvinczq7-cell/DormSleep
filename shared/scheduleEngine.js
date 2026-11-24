// 时间与跨午夜会话归属辅助工具（前端显示与离线夜晚推算共用）

export function pad2(num) {
  return String(num).padStart(2, '0');
}

export function formatTimeHM(isoOrMs) {
  if (!isoOrMs) return '--:--';
  const d = new Date(isoOrMs);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function formatTimeHMS(isoOrMs) {
  if (!isoOrMs) return '--:--:--';
  const d = new Date(isoOrMs);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function formatDateTimeShort(isoOrMs) {
  if (!isoOrMs) return '--';
  const d = new Date(isoOrMs);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function formatCountdown(msRemaining) {
  const safe = Math.max(0, Math.floor(msRemaining / 1000));
  const hours = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hours > 0) {
    return `${hours} 小时 ${pad2(mins)} 分 ${pad2(secs)} 秒`;
  }
  return `${pad2(mins)} 分 ${pad2(secs)} 秒`;
}

/**
 * 离线模式推算当前所属的“入睡夜”日期键（YYYY-MM-DD）。
 * 规则：每日 12:00 前仍归属昨晚（跨午夜 00:00–11:59 均属于前一日入睡夜），
 * 12:00 及以后归属今晚。与服务端跨午夜归属规则完全一致。
 */
export function inferCurrentNightKey(nowMs) {
  const d = new Date(nowMs);
  if (d.getHours() < 12) {
    d.setDate(d.getDate() - 1);
  }
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function inferCurrentSessionId(nowMs, isTrial = false, trialSeq = 1) {
  if (isTrial) {
    return `trial:${trialSeq}`;
  }
  return `night:${inferCurrentNightKey(nowMs)}`;
}

export function describeNightType(nightKey) {
  if (!nightKey) return '上学夜';
  const [y, m, d] = nightKey.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const day = dt.getDay(); // 0=周日 ... 5=周五, 6=周六
  return day === 5 || day === 6 ? '周末夜（周五/周六晚）' : '上学夜（周日–周四晚）';
}
