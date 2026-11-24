// 熄灯守夜（DormSleep）Windows 电脑端交互与视图层
// 严格兼容 DesktopStore 与 desktopSystemAdapter，保留全部真实伴随服务与模拟演示契约

import { APP_MAP, EMERGENCY_ACTIONS, SESSION_STATES } from '../../shared/constants.js';
import { formatSixDigitCode } from '../../shared/crypto.js';
import { ICONS, renderAppGlyph } from '../../shared/icons.js';
import { renderRhythmBarSvg } from '../../shared/sleepDial.js';
import {
  formatCountdown,
  formatDateTimeShort,
  formatTimeHM,
  formatTimeHMS,
  inferCurrentSessionId,
} from '../../shared/scheduleEngine.js';
import { desktopSystemAdapter } from '../../adapters/desktopSystemAdapter.js';
import { DesktopStore } from './store.js';

const store = new DesktopStore();

let activeView = 'main'; // 'main' | 'offline' | 'logs'
let devOpen = false;
let copiedKey = '';
let copiedTimer = null;

const elBrandMark = document.getElementById('sb-brand-mark');
const elClock = document.getElementById('dt-clock');
const elDate = document.getElementById('dt-date');
const elNav = document.getElementById('dt-nav');
const elDeviceCard = document.getElementById('dt-device-card');
const elPowerOff = document.getElementById('poweroff-screen');
const elShell = document.getElementById('desktop-shell');
const elMain = document.getElementById('desktop-main');
const elConfirm = document.getElementById('confirm-modal');
const elToast = document.getElementById('dt-toast');
const elDevFloat = document.getElementById('dt-dev-float');
const elDevToggle = document.getElementById('dt-dev-toggle');
const elDevPanel = document.getElementById('dt-dev-panel');
const elDevArrow = document.getElementById('dt-dev-arrow');
const elDevActions = document.getElementById('dt-dev-actions');

if (elBrandMark) elBrandMark.innerHTML = ICONS.brandMark(32);

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDateBadge(ms) {
  const d = new Date(ms);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · ${WEEKDAYS[d.getDay()]}`;
}

function formatPairCodeDisplay(code) {
  if (!code) return '---- ----';
  const clean = String(code).trim();
  return clean.length === 8 ? `${clean.slice(0, 4)} ${clean.slice(4)}` : clean;
}

function triggerCopiedState(key) {
  copiedKey = key;
  if (copiedTimer) clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copiedKey = '';
    renderAll();
  }, 1800);
  renderAll();
}

function copyText(text, label, key = '') {
  const done = () => {
    store.showToast(`已复制${label}`);
    if (key) triggerCopiedState(key);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => store.showToast(`请手动复制：${text}`));
  } else {
    store.showToast(`请手动复制：${text}`);
  }
}

function cleanDeviceName(name, fallback = 'Android 手机') {
  return String(name || fallback).replace('（模拟）', '');
}

function resolveDesktopAppName(snap, appId) {
  if (!appId) return '指定应用';
  if (snap?.appLabels && snap.appLabels[appId]) return snap.appLabels[appId];
  return APP_MAP[appId]?.name || appId;
}

function buildDesktopAppList(snap, d, extraAppId = null) {
  const rawIds = snap?.effectiveRestrictedAppIds || d?.knownRestrictedAppIds || [];
  const seen = new Set();
  const list = [];
  const addId = (id) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    list.push({ id, name: resolveDesktopAppName(snap, id) });
  };
  if (extraAppId) addId(extraAppId);
  for (const id of rawIds) addId(id);
  return list;
}

function classifyEventTone(kind) {
  if (!kind) return '';
  if (kind.includes('FAILED') || kind.includes('INTERRUPT') || kind.includes('ALERT')) return 'danger';
  if (kind.includes('LOCK') || kind.includes('ISSUED') || kind.includes('OFFLINE') || kind.includes('PRE_') || kind.includes('WARNING') || kind.includes('OVERRIDE')) return 'warn';
  if (kind.includes('ALLOW') || kind.includes('CONFIRMED') || kind.includes('ENDED') || kind.includes('CONSUMED')) return 'ok';
  return '';
}

// 快捷键：Esc 关闭确认窗；Ctrl/Cmd+K 快速切至离线算码并聚焦识别号输入框
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && store.endTonightConfirmTarget) {
    store.endTonightConfirmTarget = null;
    store.emit();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    activeView = 'offline';
    renderAll();
    const input = document.getElementById('off-req-id');
    input?.focus();
    input?.select();
  }
});

elDevToggle?.addEventListener('click', () => {
  devOpen = !devOpen;
  elDevPanel?.classList.toggle('hidden', !devOpen);
  if (elDevArrow) elDevArrow.innerHTML = devOpen ? '×' : '';
});

elNav?.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (!btn) return;
  activeView = btn.dataset.view;
  renderAll();
});

// ---------------- 左侧司辰导航栏 ----------------
function renderSidebar() {
  const d = store.data;
  if (!d) return;

  const nowMs = store.getDisplayNowMs();
  elClock.textContent = formatTimeHMS(nowMs);
  elDate.textContent = formatDateBadge(nowMs);

  const p = d.pairing;
  const snap = d.snapshot;
  const st = snap?.status;
  const isLockedLike = [SESSION_STATES.LOCKED, SESSION_STATES.TRIAL_LOCKED].includes(st);
  const isTempAllow = st === SESSION_STATES.TEMP_ALLOW;
  const isPermAlert = st === SESSION_STATES.PROTECTION_INTERRUPTED;

  let mainPill = '';
  if (p.status !== 'PAIRED') {
    mainPill = `<span class="sb-nav-pill warn">未配对</span>`;
  } else if (!d.connected) {
    mainPill = `<span class="sb-nav-pill warn">离线</span>`;
  } else if (isPermAlert) {
    mainPill = `<span class="sb-nav-pill danger">异常</span>`;
  } else if (isTempAllow) {
    mainPill = `<span class="sb-nav-pill safe">放行</span>`;
  } else if (isLockedLike) {
    mainPill = `<span class="sb-nav-pill warn">锁定中</span>`;
  }

  const navItems = [
    { id: 'main', label: '守夜状态', icon: ICONS.moon(16), pill: mainPill },
    {
      id: 'offline',
      label: '离线算码',
      icon: ICONS.key(16),
      pill: !d.connected && p.status === 'PAIRED' ? '<span class="sb-nav-pill warn">当前</span>' : '<span class="sb-nav-pill">^K</span>',
    },
    { id: 'logs', label: '设备与日志', icon: ICONS.history(16), pill: '' },
  ];

  elNav.innerHTML = navItems
    .map(
      (item) => `
      <button type="button" class="sb-nav-btn ${activeView === item.id ? 'active' : ''}" data-view="${item.id}">
        <span class="sb-nav-left">${item.icon}<span>${item.label}</span></span>
        ${item.pill}
      </button>
    `
    )
    .join('');

  // 底部设备状态卡片
  let devTitle = '尚未配对手机';
  let devSub = '点击主画面生成 8 位码';
  let linkDot = '';
  let linkText = '等待配对';

  if (p.status === 'PENDING') {
    devTitle = '等待手机输入配对码';
    devSub = '一次性码 3 分钟有效';
    linkDot = 'warn pulse';
    linkText = '配对进行中';
  } else if (p.status === 'PAIRED') {
    devTitle = cleanDeviceName(p.mobileName);
    devSub = `编号 ${p.pairId || '--'}`;
    if (!d.pcPoweredOn) {
      linkDot = 'danger';
      linkText = '电脑已关机';
    } else if (d.connected) {
      linkDot = 'ok pulse';
      linkText = snap ? '局域网实时在线' : '已连接 · 等待首次同步';
    } else {
      linkDot = 'warn';
      linkText = '局域网离线 · 本机可算码';
    }
  }

  elDeviceCard.innerHTML = `
    <div class="sb-dev-head">
      <div class="sb-dev-icon">${ICONS.smartphone(16)}</div>
      <div style="min-width:0;">
        <div class="sb-dev-name">${esc(devTitle)}</div>
        <div class="sb-dev-sub">${esc(devSub)}</div>
      </div>
    </div>
    <div class="sb-link-row">
      <span class="dot ${linkDot}"></span>
      <span>${esc(linkText)}</span>
    </div>
  `;
}

// ---------------- 模拟电脑关机态 ----------------
function renderPowerOffScreen() {
  const d = store.data;
  if (!d || d.pcPoweredOn) {
    elPowerOff.classList.add('hidden');
    elShell.classList.remove('hidden');
    return;
  }
  elPowerOff.classList.remove('hidden');
  elShell.classList.add('hidden');
  elPowerOff.innerHTML = `
    <div class="poweroff-box">
      <div class="poweroff-orb">${ICONS.power(28)}</div>
      <h2 style="margin:0 0 8px;font-size:21px;font-weight:700;letter-spacing:-0.3px;">宿舍电脑已关机</h2>
      <p style="font-size:13.5px;color:#9BA0AE;margin:0 0 24px;line-height:1.65;">
        手机端守夜计划完全独立运行，仍会准点锁定与到点恢复。半夜如有急事，随时开机取码（即使宿舍断网也可离线算码）。
      </p>
      <button id="btn-power-on" class="btn accent" type="button">${ICONS.power(16)}<span>模拟开机唤醒</span></button>
    </div>
  `;
  elPowerOff.querySelector('#btn-power-on')?.addEventListener('click', async () => {
    await desktopSystemAdapter.devSim.setNetwork({ pcPoweredOn: true });
    await store.refresh();
  });
}

// ---------------- 视图 1：首次配对 / 配对进行中 ----------------
function renderUnpairedCanvas() {
  const p = store.data.pairing;
  const nowMs = store.getDisplayNowMs();
  const isReal = store.serviceMode === 'WINDOWS_COMPANION_REAL';
  const isPending = p.status === 'PENDING' && Boolean(p.pendingPairCode);
  const remPairMs = isPending ? Math.max(0, (p.pendingExpiresAt || 0) - nowMs) : 0;
  const pairPct = isPending ? Math.max(0, Math.min(100, (remPairMs / (3 * 60 * 1000)) * 100)) : 0;
  const lanAddr = isReal && store.lanIps.length > 0 ? `${store.lanIps[0]}:${store.httpPort}` : '';

  elMain.innerHTML = `
    <div class="canvas-wrap">
      <div class="page-header">
        <div>
          <div class="kicker"><span class="dot warn"></span>首次设备配对</div>
          <h1 class="h1">将宿舍电脑与手机建立本地连接</h1>
          <p class="lead">无需注册账号、不经云端服务器。配对密钥仅保存在两台设备本地加密存储中。</p>
        </div>
      </div>

      <div class="bento-equal">
        <div>
          <div class="pillar-list" style="margin-top:0;">
            <div class="pillar-item">
              <div class="pillar-ico">${ICONS.shieldCheck(17)}</div>
              <div>
                <div class="pillar-title">纯本地运行 · 零账号免登录</div>
                <div class="pillar-desc">所有就寝计划、拦截状态与应急校验只在你的手机与电脑之间进行。</div>
              </div>
            </div>
            <div class="pillar-item">
              <div class="pillar-ico">${ICONS.key(17)}</div>
              <div>
                <div class="pillar-title">有急事立即出码 · 无罚站等待</div>
                <div class="pillar-desc">手机夜间锁定时，走到电脑前点击即显 6 位一次性应急码，默认放行单应用 20 分钟。</div>
              </div>
            </div>
            <div class="pillar-item">
              <div class="pillar-ico">${ICONS.wifiOff(17)}</div>
              <div>
                <div class="pillar-title">校园网断网 / AP 隔离照常可用</div>
                <div class="pillar-desc">即便深夜断网，输入手机拦截页上的 6 位识别号，即可用本机配对密钥离线算码。</div>
              </div>
            </div>
          </div>
          ${
            lanAddr
              ? `
                <div class="notice" style="margin-top:14px;align-items:center;">
                  <div>
                    <div style="font-weight:700;color:var(--ink);">本机局域网地址：<span class="mono">${esc(lanAddr)}</span></div>
                    <div style="font-size:11.5px;color:var(--ink-3);margin-top:2px;">UDP ${store.udpPort} 自动发现已开启 · 请确保手机与电脑连入同一 Wi-Fi</div>
                  </div>
                  <button id="btn-copy-lan" class="btn xs" type="button">
                    ${copiedKey === 'lan' ? ICONS.check(14) : ICONS.copy(14)}
                    <span>${copiedKey === 'lan' ? '已复制' : '复制'}</span>
                  </button>
                </div>
              `
              : ''
          }
        </div>

        <div class="panel-card">
          <div class="panel-head">
            <h2 class="panel-title">${ICONS.link(16)}<span>8 位一次性配对码</span></h2>
            <span class="panel-sub">${isPending ? '请在手机引导页输入' : '3 分钟有效'}</span>
          </div>

          ${
            isPending
              ? `
                <div class="vault-ticket" style="margin-top:0;">
                  <div class="vault-head">
                    <span class="vault-target-chip">${ICONS.smartphone(15)}<span>等待 Android 手机确认</span></span>
                    <span class="vault-req-tag" data-dt-cd="pair">剩余 ${formatCountdown(remPairMs)}</span>
                  </div>
                  <div class="vault-digits pair-code">${esc(formatPairCodeDisplay(p.pendingPairCode))}</div>
                  <div class="allow-progress-track" style="margin-bottom:12px;">
                    <div class="allow-progress-fill" data-pair-bar="1" style="width:${pairPct.toFixed(1)}%;"></div>
                  </div>
                  <div class="vault-foot">
                    <span>打开手机「熄灯守夜」输入此 8 位码</span>
                    <div style="display:flex;gap:7px;">
                      <button id="btn-copy-pair" class="btn sm dark-ghost" type="button">
                        ${copiedKey === 'pair' ? ICONS.check(14) : ICONS.copy(14)}
                        <span>${copiedKey === 'pair' ? '已复制' : '复制'}</span>
                      </button>
                      <button id="btn-regen-pair" class="btn sm dark-ghost" type="button">
                        ${ICONS.refresh(14)}
                        <span>刷新</span>
                      </button>
                    </div>
                  </div>
                </div>
              `
              : `
                <div class="vault-ticket veiled" style="margin-top:0;">
                  <div class="vault-veiled-dots">•••• ••••</div>
                  <div style="font-size:12.5px;color:var(--ink-2);">点击下方按钮生成一次性配对码，在手机端输入即可完成绑定。</div>
                </div>
                <div class="btn-row">
                  <button id="btn-start-pair" class="btn solid block" type="button">
                    ${ICONS.key(16)}
                    <span>生成 8 位配对码</span>
                  </button>
                </div>
              `
          }
        </div>
      </div>
    </div>
  `;

  elMain.querySelector('#btn-start-pair')?.addEventListener('click', () => store.startPairing());
  elMain.querySelector('#btn-regen-pair')?.addEventListener('click', () => store.startPairing());
  elMain.querySelector('#btn-copy-pair')?.addEventListener('click', () => copyText(p.pendingPairCode, '配对码', 'pair'));
  elMain.querySelector('#btn-copy-lan')?.addEventListener('click', () => copyText(`http://${lanAddr}/`, '局域网地址', 'lan'));
}

// ---------------- 视图 2：已配对 · 等待手机首次心跳同步 ----------------
function renderWaitingFirstSyncCanvas(d) {
  elMain.innerHTML = `
    <div class="canvas-wrap">
      <div class="sync-wait-card">
        <div class="radar-wrap">${ICONS.wifi(28)}</div>
        <div class="kicker" style="justify-content:center;"><span class="dot ok pulse"></span>已配对 · 等待首次同步</div>
        <h1 class="h1" style="margin-top:8px;">正在接收「${esc(cleanDeviceName(d.pairing.mobileName))}」的状态</h1>
        <p class="lead" style="max-width:420px;margin:6px auto 0;">
          配对已建立，手机端通常会在 10 秒内通过局域网推送最新的就寝计划与锁定状态。若手机暂未联网，也可直接使用离线算码。
        </p>
        <div class="btn-row" style="justify-content:center;margin-top:24px;">
          <button id="btn-refresh-wait" class="btn solid" type="button">${ICONS.refresh(15)}<span>立即刷新</span></button>
          <button id="btn-goto-offline" class="btn subtle" type="button">${ICONS.key(15)}<span>前往离线算码</span></button>
        </div>
      </div>
    </div>
  `;

  elMain.querySelector('#btn-refresh-wait')?.addEventListener('click', () => store.refresh());
  elMain.querySelector('#btn-goto-offline')?.addEventListener('click', () => {
    activeView = 'offline';
    renderAll();
  });
}

// ---------------- 视图 3：在线主状态与应急取码 ----------------
function renderMainCanvas(d, snap, nowMs) {
  // 局域网断开时自动引导至离线取码
  if (!d.connected) {
    renderOfflineCanvas(d, snap, nowMs, true);
    return;
  }

  // 已配对但尚未收到首次快照时的安全占位态
  if (!snap) {
    renderWaitingFirstSyncCanvas(d);
    return;
  }

  const st = snap.status || SESSION_STATES.IDLE;
  const inLock = [SESSION_STATES.LOCKED, SESSION_STATES.TEMP_ALLOW, SESSION_STATES.TRIAL_LOCKED].includes(st);
  const req = inLock ? snap.activeRequest : null;
  const issued = d.issuedCode;
  const restrictedList = buildDesktopAppList(snap, d, req?.targetAppId);
  const isWhitelistMode = snap.restrictionMode === 'WHITELIST_ALL';

  const selectedAppId =
    restrictedList.some((a) => a.id === store.selectedOnlineAppId)
      ? store.selectedOnlineAppId
      : req?.targetAppId || restrictedList[0]?.id || 'tv.danmaku.bili';
  store.selectedOnlineAppId = selectedAppId;

  // 决定顶部 Hero 视觉基调与信息
  let heroTone = '';
  let dotCls = 'ok';
  let badgeText = '待机守候';
  let heroTitle = `今晚 ${formatTimeHM(snap.startAt)} — 次日 ${formatTimeHM(snap.endAt)}`;
  let heroSub = `修改截止 ${formatTimeHM(snap.freezeCutoffAt)} · 到点自动进入夜间限制`;
  let sideLabel = '距开始还有';
  let sideVal = formatCountdown(Math.max(0, snap.startAt - nowMs));
  let sideCdType = 'idle';
  let showRhythm = true;
  let rhythmPaused = false;
  let rhythmTone = 'violet';

  if (st === SESSION_STATES.PROTECTION_INTERRUPTED) {
    heroTone = 'tone-danger';
    dotCls = 'danger pulse';
    badgeText = '手机权限异常 · 保护已中断';
    heroTitle = '夜间限制未能正常生效';
    heroSub = '检测到手机端关键系统权限被关闭，请提醒自己在手机上恢复授权。';
    sideLabel = '当前状态';
    sideVal = '待修复';
    sideCdType = '';
    showRhythm = false;
  } else if (snap.tempAllow) {
    heroTone = 'tone-allow';
    dotCls = 'ok pulse';
    const allowApp = resolveDesktopAppName(snap, snap.tempAllow.appId);
    const remAllowMs = Math.max(0, snap.tempAllow.expiresAt - nowMs);
    badgeText = snap.activeMode === 'TRIAL' ? '试锁临时放行中' : '单应用临时放行 20 分钟';
    heroTitle = `仅放行 ${esc(allowApp)}`;
    heroSub = `将于 ${formatTimeHM(snap.tempAllow.expiresAt)} 自动恢复拦截，其余受限娱乐应用保持拦截。`;
    sideLabel = '放行剩余';
    sideVal = formatCountdown(remAllowMs);
    sideCdType = 'allow';
    showRhythm = false;
  } else if (st === SESSION_STATES.TRIAL_LOCKED) {
    heroTone = 'tone-night';
    dotCls = 'warn pulse';
    badgeText = '白天试锁演练中';
    heroTitle = `剩余 ${formatCountdown(Math.max(0, snap.endAt - nowMs))}`;
    heroSub = `3 分钟体验会话（${esc(snap.sessionId)}）· 到点自动结束，也可在下方立即取码结束。`;
    sideLabel = '恢复时刻';
    sideVal = formatTimeHM(snap.endAt);
    sideCdType = 'trial';
    showRhythm = false;
  } else if (st === SESSION_STATES.LOCKED) {
    heroTone = 'tone-night';
    dotCls = 'warn pulse';
    badgeText = '手机夜间限制生效中';
    heroTitle = `距自动恢复 ${formatCountdown(Math.max(0, snap.endAt - nowMs))}`;
    heroSub = `明早 ${formatTimeHM(snap.endAt)} 自动解除，无需取码；急事可在下方立即获取单应用放行码。`;
    sideLabel = '自动结束';
    sideVal = formatTimeHM(snap.endAt);
    sideCdType = 'locked';
    showRhythm = true;
    rhythmTone = 'violet';
  } else if (st === SESSION_STATES.PRE_LOCK_REMINDER) {
    heroTone = 'tone-prelock';
    dotCls = 'warn pulse';
    badgeText = '睡前收尾提醒';
    heroTitle = `${formatCountdown(Math.max(0, snap.startAt - nowMs))} 后自动锁定`;
    heroSub = `将于 ${formatTimeHM(snap.startAt)} 准点生效，无需二次确认。`;
    sideLabel = '就寝区间';
    sideVal = `${formatTimeHM(snap.startAt)}–${formatTimeHM(snap.endAt)}`;
    sideCdType = 'prelock';
    showRhythm = true;
    rhythmTone = 'sunset';
  } else if (st === SESSION_STATES.ENDED_EARLY) {
    dotCls = 'ok';
    badgeText = '今晚已提前解除';
    heroTitle = '今晚限制已提前结束';
    heroSub = `手机全部应用已恢复正常；明晚 ${formatDateTimeShort(snap.nextRegularResumeAt)} 将照常开启。`;
    sideLabel = '下次开启';
    sideVal = formatDateTimeShort(snap.nextRegularResumeAt);
    sideCdType = '';
    showRhythm = false;
  } else if (st === SESSION_STATES.NATURAL_ENDED) {
    dotCls = 'ok';
    badgeText = '已按时自然恢复';
    heroTitle = '本次守夜已自然结束';
    heroSub = `已于 ${formatTimeHM(snap.endAt)} 准时解除（无需取码）· 明晚 ${formatDateTimeShort(snap.nextRegularResumeAt)} 继续。`;
    sideLabel = '结束时刻';
    sideVal = formatTimeHM(snap.endAt);
    sideCdType = '';
    showRhythm = false;
  } else if (st === SESSION_STATES.PAUSED_TONIGHT) {
    dotCls = 'ok';
    badgeText = '今晚已暂停一次';
    heroTitle = '今晚不开启夜间限制';
    heroSub = `通过「仅改今晚」暂停一次，明晚 ${formatDateTimeShort(snap.nextRegularResumeAt)} 自动恢复常规计划。`;
    sideLabel = '常规恢复';
    sideVal = formatDateTimeShort(snap.nextRegularResumeAt);
    sideCdType = '';
    showRhythm = true;
    rhythmPaused = true;
  }

  // 临时放行进度条
  let allowBarHtml = '';
  if (snap.tempAllow) {
    const totalMs = Math.max(1, snap.tempAllow.expiresAt - snap.tempAllow.startedAt);
    const remMs = Math.max(0, snap.tempAllow.expiresAt - nowMs);
    const pct = Math.max(0, Math.min(100, (remMs / totalMs) * 100));
    const nearEnd = remMs <= 60 * 1000;
    allowBarHtml = `
      <div class="allow-progress-wrap">
        <div class="allow-progress-track">
          <div class="allow-progress-fill ${nearEnd ? 'near-end' : ''}" data-allow-bar="1" style="width:${pct.toFixed(1)}%;"></div>
        </div>
        <div class="allow-progress-meta">
          <span>放行开始 ${formatTimeHM(snap.tempAllow.startedAt)}</span>
          <span data-dt-cd="allow-meta">${nearEnd ? '不足 1 分钟即将恢复拦截' : `将于 ${formatTimeHM(snap.tempAllow.expiresAt)} 自动恢复`}</span>
        </div>
      </div>
    `;
  }

  // 权限异常详情条
  let permAlertHtml = '';
  if (st === SESSION_STATES.PROTECTION_INTERRUPTED && snap.permissions) {
    const permItems = [
      ['usageStats', '使用情况访问'],
      ['overlay', '悬浮窗显示'],
      ['exactAlarm', '精确闹钟'],
    ];
    permAlertHtml = `
      <div class="perm-alert-chips">
        ${permItems
          .map(([k, label]) => {
            const ok = Boolean(snap.permissions[k]);
            return `<span class="perm-chip ${ok ? '' : 'missing'}">${ok ? ICONS.check(13) : ICONS.alert(13)}<span>${label}：${ok ? '正常' : '已关闭'}</span></span>`;
          })
          .join('')}
      </div>
    `;
  }

  // 「仅改今晚」提示条
  const overrideHtml = snap.tonightOverride
    ? `
      <div class="override-strip">
        ${ICONS.clock(14)}
        <span>仅改今晚：${
          snap.tonightOverride.mode === 'PAUSE_TONIGHT'
            ? '暂停今晚一次'
            : `${esc(snap.tonightOverride.start)} – ${esc(snap.tonightOverride.end)}`
        } · 次晚 ${formatDateTimeShort(snap.tonightOverride.nextRegularResumeAt)} 自动恢复原计划</span>
      </div>
    `
    : '';

  // 左侧主操作卡（应急取码控制台）
  let vaultCardHtml = '';
  if (inLock) {
    const issuedTargetName = issued
      ? issued.actionType === EMERGENCY_ACTIONS.END_TONIGHT
        ? '结束今晚全部限制'
        : `仅放行 ${resolveDesktopAppName(snap, issued.targetAppId)} · 20 分钟`
      : '';

    const quickChoices = [];
    const seenQuick = new Set();
    const pushQuick = (id) => {
      if (!id || seenQuick.has(id)) return;
      const found = restrictedList.find((a) => a.id === id);
      if (found) {
        seenQuick.add(id);
        quickChoices.push(found);
      }
    };
    pushQuick(req?.targetAppId);
    pushQuick(selectedAppId);
    for (const item of restrictedList) {
      if (quickChoices.length >= (restrictedList.length > 8 ? 6 : 8)) break;
      pushQuick(item.id);
    }

    vaultCardHtml = `
      <section class="panel-card">
        <div class="panel-head">
          <h2 class="panel-title">${ICONS.key(16)}<span>实时应急取码</span></h2>
          <span class="panel-sub">请求识别号 <strong class="mono" style="color:var(--fuchsia);">${esc(req?.requestId || '--')}</strong></span>
        </div>

        <div class="field">
          <div class="field-label-row">
            <label>选择 20 分钟单应用放行目标</label>
            <span class="panel-sub">${isWhitelistMode ? '其余未豁免应用保持拦截' : '其余娱乐应用保持拦截'}</span>
          </div>
          <div class="app-picker-grid" role="radiogroup" aria-label="目标应用">
            ${quickChoices
              .map((a) => {
                const isSel = a.id === selectedAppId;
                return `
                  <button type="button" class="app-choice-btn ${isSel ? 'selected' : ''}" data-online-app="${esc(a.id)}" aria-checked="${isSel ? 'true' : 'false'}">
                    ${renderAppGlyph(a.id, 22, isSel)}
                    <span>${esc(a.name)}</span>
                  </button>
                `;
              })
              .join('')}
          </div>
          ${
            restrictedList.length > 8
              ? `
                <div style="margin-top:9px;">
                  <select id="on-target-select" class="select" aria-label="从全部受限应用中选择">
                    ${restrictedList
                      .map((a) => `<option value="${esc(a.id)}" ${a.id === selectedAppId ? 'selected' : ''}>全部可放行应用：${esc(a.name)}</option>`)
                      .join('')}
                  </select>
                </div>
              `
              : ''
          }
        </div>

        <div class="btn-row">
          <button id="btn-issue-temp" class="btn solid" style="flex:1" type="button">
            ${ICONS.key(15)}
            <span>立即显示 20 分钟放行码</span>
          </button>
          <button id="btn-issue-end" class="btn danger-soft" type="button">
            ${snap.activeMode === 'TRIAL' ? '结束试锁' : '结束今晚限制'}
          </button>
        </div>

        ${
          issued
            ? `
              <div class="vault-ticket">
                <div class="vault-head">
                  <span class="vault-target-chip">
                    ${issued.targetAppId ? renderAppGlyph(issued.targetAppId, 20, true) : ICONS.unlock(15)}
                    <span>${esc(issuedTargetName)}</span>
                  </span>
                  <span class="vault-req-tag">${esc(issued.requestId)}</span>
                </div>
                <div class="vault-digits">${formatSixDigitCode(issued.code)}</div>
                <div class="vault-foot">
                  <span>仅电脑端可见 · 单次消费或手机切换目标即刻作废</span>
                  <button id="btn-copy-online" class="btn sm dark-ghost" type="button">
                    ${copiedKey === 'online' ? ICONS.check(14) : ICONS.copy(14)}
                    <span>${copiedKey === 'online' ? '已复制' : '复制'}</span>
                  </button>
                </div>
              </div>
            `
            : `
              <div class="vault-ticket veiled">
                <div class="vault-veiled-dots">• • • &nbsp; • • •</div>
                <div style="font-size:12.5px;color:var(--ink-2);">应急码默认隐藏，点击上方按钮立即生成并显示（无等待）。</div>
              </div>
            `
        }
      </section>
    `;
  } else {
    vaultCardHtml = `
      <section class="panel-card">
        <div class="panel-head">
          <h2 class="panel-title">${ICONS.shieldCheck(16)}<span>应急码待命</span></h2>
          <span class="panel-sub">非锁定态</span>
        </div>
        <div class="vault-ticket veiled" style="margin-top:0;">
          <div style="color:var(--ink-3);margin-bottom:8px;">${ICONS.moon(24)}</div>
          <div style="font-size:14px;font-weight:700;color:var(--ink);">当前手机未处于限制状态</div>
          <div style="font-size:12.5px;color:var(--ink-2);margin-top:4px;">
            非锁定期间不生成应急密码。到点自动进入夜间守夜后，此处将立即开放零等待取码。
          </div>
        </div>
        <div class="btn-row">
          <button id="btn-open-offline-shortcut" class="btn subtle sm" type="button">
            ${ICONS.keyboard(14)}
            <span>打开离线算码工具</span>
            <span class="kbd">Ctrl+K</span>
          </button>
        </div>
      </section>
    `;
  }

  // 右侧上下文卡（受限名单 + 今晚关键参数）
  const previewApps = [];
  const seenPreview = new Set();
  const pushPreview = (id) => {
    if (!id || seenPreview.has(id)) return;
    const found = restrictedList.find((a) => a.id === id);
    if (found) {
      seenPreview.add(id);
      previewApps.push(found);
    }
  };
  pushPreview(snap.tempAllow?.appId);
  pushPreview(req?.targetAppId);
  for (const item of restrictedList) {
    if (previewApps.length >= 10) break;
    pushPreview(item.id);
  }
  const hiddenRestCount = Math.max(0, restrictedList.length - previewApps.length);

  const contextCardHtml = `
    <section class="panel-card">
      <div class="panel-head">
        <h2 class="panel-title">${ICONS.grid(15)}<span>${isWhitelistMode ? '严格白名单拦截' : '今晚受限应用'}</span></h2>
        <span class="panel-sub">${isWhitelistMode ? `${restrictedList.length} 个未豁免应用` : `${restrictedList.length} 个受限应用`}</span>
      </div>

      <div class="app-tag-list">
        ${
          previewApps.length === 0
            ? '<span class="panel-sub">暂未选择受限应用</span>'
            : previewApps
                .map((a) => {
                  const isAllowedNow = snap.tempAllow?.appId === a.id;
                  return `
                    <span class="app-tag ${isAllowedNow ? 'allowed-now' : ''}">
                      ${renderAppGlyph(a.id, 20, false)}
                      <span>${esc(a.name)}</span>
                      ${isAllowedNow ? `<span style="font-size:10.5px;font-weight:700;">· 放行中</span>` : ''}
                    </span>
                  `;
                })
                .join('') +
              (hiddenRestCount > 0
                ? `<span class="app-tag" style="opacity:0.78;">+ 其余 ${hiddenRestCount} 个已装应用</span>`
                : '')
        }
      </div>

      <div class="kv-list">
        ${
          snap.restrictionMode
            ? `
              <div class="kv-row">
                <span class="kv-k">守夜策略</span>
                <span class="kv-v">${isWhitelistMode ? '严格白名单 · 除豁免外全拦' : '仅拦指定应用'}</span>
              </div>
            `
            : ''
        }
        ${
          snap.blockSettingsDuringLock !== undefined
            ? `
              <div class="kv-row">
                <span class="kv-k">防绕过保护</span>
                <span class="kv-v" style="${snap.blockSettingsDuringLock ? 'color:var(--safe);' : ''}">${snap.blockSettingsDuringLock ? '系统设置与管家已拦截' : '已关闭'}</span>
              </div>
            `
            : ''
        }
        <div class="kv-row">
          <span class="kv-k">归属会话</span>
          <span class="kv-v mono">${esc(snap.sessionId)}</span>
        </div>
        <div class="kv-row">
          <span class="kv-k">固定修改截止</span>
          <span class="kv-v mono">${formatTimeHM(snap.freezeCutoffAt)}${snap.isFrozen ? ' · 已冻结' : ''}</span>
        </div>
        <div class="kv-row">
          <span class="kv-k">历史已消费应急码</span>
          <span class="kv-v">${snap.consumedCount} 次</span>
        </div>
        <div class="kv-row">
          <span class="kv-k">同步通道</span>
          <span class="kv-v" style="color:var(--safe);">局域网实时在线</span>
        </div>
      </div>
    </section>
  `;

  elMain.innerHTML = `
    <div class="canvas-wrap">
      <section class="hero-card ${heroTone}">
        <div class="hero-top">
          <span class="status-badge"><span class="dot ${dotCls}"></span>${badgeText}</span>
          <span class="session-pill">${ICONS.clock(13)}<span>${esc(snap.sessionId)}</span></span>
        </div>

        <div class="hero-main">
          <div>
            <h1 class="hero-title" ${sideCdType === 'locked' || sideCdType === 'trial' || sideCdType === 'prelock' ? `data-dt-hero-title="${sideCdType}"` : ''}>${heroTitle}</h1>
            <p class="hero-sub">${heroSub}</p>
          </div>
          <div class="hero-side-stat">
            <div class="hero-side-label">${sideLabel}</div>
            <div class="hero-side-val" ${sideCdType === 'idle' || sideCdType === 'allow' ? `data-dt-cd="${sideCdType}"` : ''}>${esc(sideVal)}</div>
          </div>
        </div>

        ${allowBarHtml}
        ${permAlertHtml}
        ${overrideHtml}
        ${
          showRhythm
            ? `<div class="hero-rhythm">${renderRhythmBarSvg({
                nowMs,
                startAt: snap.startAt,
                endAt: snap.endAt,
                freezeCutoffAt: snap.freezeCutoffAt,
                paused: rhythmPaused,
                tone: rhythmTone,
              })}</div>`
            : ''
        }
      </section>

      <div class="bento-grid">
        ${vaultCardHtml}
        ${contextCardHtml}
      </div>
    </div>
  `;

  elMain.querySelectorAll('[data-online-app]').forEach((btn) => {
    btn.addEventListener('click', () => {
      store.selectedOnlineAppId = btn.dataset.onlineApp;
      renderAll();
    });
  });
  elMain.querySelector('#on-target-select')?.addEventListener('change', (e) => {
    store.selectedOnlineAppId = e.target.value;
    renderAll();
  });
  elMain.querySelector('#btn-issue-temp')?.addEventListener('click', () => {
    store.issueOnlineCode(EMERGENCY_ACTIONS.TEMP_ALLOW_15M, store.selectedOnlineAppId);
  });
  elMain.querySelector('#btn-issue-end')?.addEventListener('click', () => {
    store.endTonightConfirmTarget = 'ONLINE';
    store.emit();
  });
  elMain.querySelector('#btn-copy-online')?.addEventListener('click', () => {
    if (d.issuedCode?.code) copyText(d.issuedCode.code, '应急码', 'online');
  });
  elMain.querySelector('#btn-open-offline-shortcut')?.addEventListener('click', () => {
    activeView = 'offline';
    renderAll();
    document.getElementById('off-req-id')?.focus();
  });
}

// ---------------- 视图 4：本机离线算码（HMAC-SHA256） ----------------
function renderOfflineCanvas(d, snap, nowMs, autoGuided = false) {
  const off = store.offlineForm;
  const offRes = store.offlineResult;
  const restrictedList = buildDesktopAppList(snap, d, off.targetAppId);
  const defaultSessionId = inferCurrentSessionId(nowMs);

  if (!off.targetAppId || !restrictedList.some((a) => a.id === off.targetAppId)) {
    off.targetAppId = restrictedList[0]?.id || 'tv.danmaku.bili';
  }

  const offlineBanner = !d.connected
    ? `
      <div class="notice warn">
        <div style="display:flex;align-items:center;gap:8px;">
          ${ICONS.wifiOff(16)}
          <span><strong>局域网未连接${autoGuided ? ' · 已自动切换至本机离线算码' : ''}</strong> — 宿舍断网、AP 隔离或深夜开机时，直接用本机密钥算码即可。</span>
        </div>
        ${snap ? `<span class="mono" style="font-size:11.5px;white-space:nowrap;">上次同步 ${formatTimeHM(snap.syncedAt)}</span>` : ''}
      </div>
    `
    : '';

  const resultTicketHtml = offRes
    ? `
      <div class="vault-ticket" style="margin-top:0;">
        <div class="vault-head">
          <span class="vault-target-chip">
            ${offRes.targetAppId ? renderAppGlyph(offRes.targetAppId, 20, true) : ICONS.unlock(15)}
            <span>${
              offRes.actionType === EMERGENCY_ACTIONS.END_TONIGHT
                ? '结束今晚全部限制'
                : `仅放行 ${esc(resolveDesktopAppName(snap, offRes.targetAppId))} · 20 分钟`
            }</span>
          </span>
          <span class="vault-req-tag">${esc(offRes.requestId)}</span>
        </div>
        <div class="vault-digits">${formatSixDigitCode(offRes.code)}</div>
        <div class="kv-list" style="margin-top:0;border-top-color:rgba(255,255,255,0.1);">
          <div class="kv-row" style="border-bottom-color:rgba(255,255,255,0.08);padding:7px 0;">
            <span class="kv-k">绑定会话</span>
            <span class="kv-v mono">${esc(offRes.sessionId)}</span>
          </div>
          <div class="kv-row" style="border-bottom:none;padding:7px 0 10px;">
            <span class="kv-k">计算时刻</span>
            <span class="kv-v mono">${formatTimeHMS(offRes.computedAt)}</span>
          </div>
        </div>
        <div class="vault-foot">
          <span>HMAC-SHA256 派生 · 手机校验后单次失效</span>
          <button id="btn-copy-offline" class="btn sm dark-ghost" type="button">
            ${copiedKey === 'offline' ? ICONS.check(14) : ICONS.copy(14)}
            <span>${copiedKey === 'offline' ? '已复制' : '复制'}</span>
          </button>
        </div>
      </div>
    `
    : `
      <div class="panel-card">
        <div class="panel-head">
          <h2 class="panel-title">${ICONS.shield(16)}<span>离线算码说明</span></h2>
          <span class="panel-sub">纯本机计算</span>
        </div>
        <div class="vault-ticket veiled" style="margin-top:0;">
          <div class="vault-veiled-dots">• • • &nbsp; • • •</div>
          <div style="font-size:12.5px;color:var(--ink-2);">在左侧输入手机拦截页的 6 位识别号，按回车即可立刻算出。</div>
        </div>
        <div class="pillar-list" style="margin-top:14px;gap:9px;">
          <div class="pillar-item" style="padding:10px 12px;">
            <div class="pillar-ico" style="width:26px;height:26px;font-size:12px;font-weight:800;">1</div>
            <div class="pillar-desc" style="margin:0;color:var(--ink-2);">在手机夜间拦截页展开应急解锁，抄录 6 位识别号（如 <span class="mono">K7M4-92</span>）。</div>
          </div>
          <div class="pillar-item" style="padding:10px 12px;">
            <div class="pillar-ico" style="width:26px;height:26px;font-size:12px;font-weight:800;">2</div>
            <div class="pillar-desc" style="margin:0;color:var(--ink-2);">确认「操作类型」与「目标应用」与手机当前选中项完全一致。</div>
          </div>
          <div class="pillar-item" style="padding:10px 12px;">
            <div class="pillar-ico" style="width:26px;height:26px;font-size:12px;font-weight:800;">3</div>
            <div class="pillar-desc" style="margin:0;color:var(--ink-2);">凌晨 00:00–11:59 会自动归属昨晚入睡夜，无需手动减一天。</div>
          </div>
        </div>
      </div>
    `;

  elMain.innerHTML = `
    <div class="canvas-wrap">
      <div class="page-header">
        <div>
          <div class="kicker"><span class="dot ${d.connected ? 'ok' : 'warn'}"></span>${d.connected ? '离线算码 · 随时可用' : '完全离线模式'}</div>
          <h1 class="h1">本机离线算码</h1>
          <p class="lead">使用本机加密保存的配对密钥通过 HMAC-SHA256 直接派生，零网络依赖。</p>
        </div>
      </div>

      ${offlineBanner}

      <div class="bento-equal">
        <section class="panel-card">
          <div class="field">
            <div class="field-label-row">
              <label for="off-req-id">手机请求识别号</label>
              <span class="kbd">Ctrl+K</span>
            </div>
            <input id="off-req-id" class="input req-input" placeholder="例如 K7M4-92" value="${esc(off.requestId)}" autocomplete="off" spellcheck="false" />
          </div>

          <div class="field">
            <div class="field-label-row">
              <label>操作类型</label>
              <span class="panel-sub">须与手机端一致</span>
            </div>
            <div class="seg">
              <button id="off-act-temp" type="button" class="${off.actionType === EMERGENCY_ACTIONS.TEMP_ALLOW_15M ? 'active' : ''}">放行 20 分钟（默认）</button>
              <button id="off-act-end" type="button" class="${off.actionType === EMERGENCY_ACTIONS.END_TONIGHT ? 'active-danger' : ''}">结束今晚限制</button>
            </div>
          </div>

          ${
            off.actionType === EMERGENCY_ACTIONS.TEMP_ALLOW_15M
              ? `
                <div class="field">
                  <div class="field-label-row">
                    <label for="off-target-app">目标应用</label>
                    <span class="panel-sub">单应用绑定</span>
                  </div>
                  <select id="off-target-app" class="select">
                    ${restrictedList
                      .map((a) => `<option value="${a.id}" ${a.id === off.targetAppId ? 'selected' : ''}>${esc(a.name)}</option>`)
                      .join('')}
                  </select>
                </div>
              `
              : ''
          }

          <div class="field">
            <div class="field-label-row">
              <label for="off-session-id">归属会话</label>
              <div style="display:flex;gap:5px;">
                <button id="off-session-auto" class="btn xs subtle" type="button">自动推算</button>
                <button id="off-session-trial" class="btn xs subtle mono" type="button">trial:1</button>
              </div>
            </div>
            <input id="off-session-id" class="input mono" value="${esc(off.sessionId || defaultSessionId)}" autocomplete="off" />
          </div>

          <div class="btn-row">
            <button id="btn-calc-offline" class="btn solid block" type="button">
              ${ICONS.key(15)}
              <span>立即生成离线应急码</span>
            </button>
          </div>
        </section>

        <div>
          ${resultTicketHtml}
        </div>
      </div>
    </div>
  `;

  elMain.querySelector('#off-req-id')?.addEventListener('input', (e) => {
    store.offlineForm.requestId = e.target.value.toUpperCase();
  });
  elMain.querySelector('#off-req-id')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (store.offlineForm.actionType === EMERGENCY_ACTIONS.END_TONIGHT) {
        store.endTonightConfirmTarget = 'OFFLINE';
        store.emit();
      } else {
        store.computeOfflineCode();
      }
    }
  });
  elMain.querySelector('#off-session-id')?.addEventListener('input', (e) => {
    store.offlineForm.sessionId = e.target.value;
  });
  elMain.querySelector('#off-session-auto')?.addEventListener('click', () => {
    store.offlineForm.sessionId = inferCurrentSessionId(store.getDisplayNowMs());
    renderAll();
  });
  elMain.querySelector('#off-session-trial')?.addEventListener('click', () => {
    store.offlineForm.sessionId = 'trial:1';
    renderAll();
  });
  elMain.querySelector('#off-act-temp')?.addEventListener('click', () => {
    store.offlineForm.actionType = EMERGENCY_ACTIONS.TEMP_ALLOW_15M;
    renderAll();
  });
  elMain.querySelector('#off-act-end')?.addEventListener('click', () => {
    store.offlineForm.actionType = EMERGENCY_ACTIONS.END_TONIGHT;
    renderAll();
  });
  elMain.querySelector('#off-target-app')?.addEventListener('change', (e) => {
    store.offlineForm.targetAppId = e.target.value;
  });
  elMain.querySelector('#btn-calc-offline')?.addEventListener('click', () => {
    if (store.offlineForm.actionType === EMERGENCY_ACTIONS.END_TONIGHT) {
      store.endTonightConfirmTarget = 'OFFLINE';
      store.emit();
    } else {
      store.computeOfflineCode();
    }
  });
  elMain.querySelector('#btn-copy-offline')?.addEventListener('click', () => {
    if (store.offlineResult?.code) copyText(store.offlineResult.code, '离线应急码', 'offline');
  });
}

// ---------------- 视图 5：记录与设备 ----------------
function renderLogsCanvas(d, snap) {
  const events = snap?.events || [];
  const backendLabel =
    store.secretStorageBackend === 'WINDOWS_DPAPI'
      ? 'Windows DPAPI 用户级加密'
      : store.secretStorageBackend === 'POSIX_DEV_FALLBACK'
        ? '本地受限权限存储'
        : 'DPAPI 本地模拟层';

  const isReal = store.serviceMode === 'WINDOWS_COMPANION_REAL';
  const lanList = isReal && store.lanIps.length > 0 ? store.lanIps.map((ip) => `${ip}:${store.httpPort}`) : [];

  elMain.innerHTML = `
    <div class="canvas-wrap">
      <div class="page-header">
        <div>
          <div class="kicker">${ICONS.laptop(14)}<span>设备安全与同步日志</span></div>
          <h1 class="h1">记录与设备</h1>
          <p class="lead">管理当前配对的 Android 手机、本机密钥保护方式与局域网服务信息。</p>
        </div>
        <button id="btn-dt-unbind" class="btn sm danger-soft" type="button">
          ${ICONS.unlink(14)}
          <span>解除手机配对</span>
        </button>
      </div>

      <section class="panel-card">
        <div class="panel-head">
          <h2 class="panel-title">${ICONS.shieldCheck(16)}<span>已配对设备与安全凭证</span></h2>
          <span class="status-badge" style="background:var(--safe-soft);color:var(--safe);">
            <span class="dot ok"></span>${esc(cleanDeviceName(d.pairing.mobileName))}
          </span>
        </div>

        <div class="device-meta-grid">
          <div class="meta-tile">
            <div class="meta-tile-k">配对编号 (Pair ID)</div>
            <div class="meta-tile-v mono" style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
              <span class="meta-tile-ellipsis" title="${esc(d.pairing.pairId || '--')}">${esc(d.pairing.pairId || '--')}</span>
              ${
                d.pairing.pairId
                  ? `<button id="btn-copy-pairid" class="btn xs subtle" type="button" title="复制配对编号">${copiedKey === 'pairid' ? ICONS.check(12) : ICONS.copy(12)}</button>`
                  : ''
              }
            </div>
          </div>

          <div class="meta-tile">
            <div class="meta-tile-k">密钥加密存储后端</div>
            <div class="meta-tile-v"><span class="meta-tile-ellipsis" title="${esc(backendLabel)}">${esc(backendLabel)}</span></div>
          </div>

          <div class="meta-tile">
            <div class="meta-tile-k">${isReal ? `本机局域网 · UDP ${store.udpPort}` : '运行服务模式'}</div>
            <div class="meta-tile-v mono" style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
              <span class="meta-tile-ellipsis" title="${esc(lanList.length > 0 ? lanList[0] : isReal ? `127.0.0.1:${store.httpPort}` : '共享模拟演示服务')}">${esc(lanList.length > 0 ? lanList[0] : isReal ? `127.0.0.1:${store.httpPort}` : '共享模拟演示服务')}</span>
              ${
                lanList.length > 0
                  ? `<button id="btn-copy-log-lan" class="btn xs subtle" type="button" title="复制局域网地址">${copiedKey === 'loglan' ? ICONS.check(12) : ICONS.copy(12)}</button>`
                  : ''
              }
            </div>
          </div>
        </div>

        ${
          lanList.length > 1
            ? `<div class="notice" style="margin-top:12px;">全部局域网候选地址：<span class="mono">${esc(lanList.join(' / '))}</span></div>`
            : ''
        }
      </section>

      <section class="panel-card">
        <div class="panel-head">
          <h2 class="panel-title">${ICONS.history(16)}<span>状态时间轴</span></h2>
          <span class="panel-sub">最近 ${Math.min(events.length, 20)} 条记录</span>
        </div>

        ${
          events.length === 0
            ? '<p class="lead" style="padding:12px 0;">暂无状态同步或取码记录。</p>'
            : `
              <div class="timeline">
                ${events
                  .slice(0, 20)
                  .map(
                    (ev) => `
                  <div class="tl-item">
                    <div class="tl-dot-col"><span class="dot ${classifyEventTone(ev.kind)}"></span></div>
                    <div class="tl-ts">${formatDateTimeShort(ev.ts)}</div>
                    <div class="tl-msg">${esc(ev.message)}</div>
                  </div>
                `
                  )
                  .join('')}
              </div>
            `
        }
      </section>
    </div>
  `;

  elMain.querySelector('#btn-dt-unbind')?.addEventListener('click', () => store.unbindPairing());
  elMain.querySelector('#btn-copy-pairid')?.addEventListener('click', () => {
    if (d.pairing.pairId) copyText(d.pairing.pairId, '配对编号', 'pairid');
  });
  elMain.querySelector('#btn-copy-log-lan')?.addEventListener('click', () => {
    if (lanList.length > 0) copyText(`http://${lanList[0]}/`, '局域网地址', 'loglan');
  });
}

// ---------------- 结束今晚二次确认模态窗 ----------------
function renderConfirmModal() {
  const target = store.endTonightConfirmTarget;
  if (!target) {
    elConfirm.classList.add('hidden');
    elConfirm.innerHTML = '';
    return;
  }

  const isTrial = store.data?.snapshot?.activeMode === 'TRIAL';
  elConfirm.classList.remove('hidden');
  elConfirm.innerHTML = `
    <div class="modal-card">
      <div class="modal-icon">${ICONS.alert(20)}</div>
      <h2 style="margin:0 0 8px;font-size:18px;font-weight:800;letter-spacing:-0.3px;">${isTrial ? '确认结束本次白天试锁？' : '确认结束今晚全部限制？'}</h2>
      <p class="lead" style="font-size:13px;line-height:1.65;">
        ${
          isTrial
            ? '确认后将立即显示结束试锁的 6 位应急码（无等待），手机验证后即恢复常态。'
            : '使用后手机今晚所有娱乐应用限制都将提前解除（明晚仍按常规计划照常开启）。若仅需临时查资料，建议改用默认的 20 分钟单应用放行。'
        }
      </p>
      <div class="btn-row" style="margin-top:20px;">
        <button id="cm-cancel" class="btn subtle" style="flex:1" type="button">取消 <span class="kbd" style="margin-left:4px;">Esc</span></button>
        <button id="cm-confirm" class="btn accent" style="flex:1" type="button">确认，立即显示</button>
      </div>
    </div>
  `;

  elConfirm.onclick = (e) => {
    if (e.target === elConfirm) {
      store.endTonightConfirmTarget = null;
      store.emit();
    }
  };
  elConfirm.querySelector('#cm-cancel')?.addEventListener('click', () => {
    store.endTonightConfirmTarget = null;
    store.emit();
  });
  elConfirm.querySelector('#cm-confirm')?.addEventListener('click', async () => {
    const mode = store.endTonightConfirmTarget;
    store.endTonightConfirmTarget = null;
    if (mode === 'ONLINE') {
      await store.issueOnlineCode(EMERGENCY_ACTIONS.END_TONIGHT, null);
    } else {
      store.offlineForm.actionType = EMERGENCY_ACTIONS.END_TONIGHT;
      await store.computeOfflineCode();
    }
  });
}

// ---------------- 模拟演示控制浮窗（真实伴随模式隐藏） ----------------
function renderDevBar() {
  if (store.serviceMode === 'WINDOWS_COMPANION_REAL') {
    elDevFloat?.classList.add('hidden');
    return;
  }
  elDevFloat?.classList.remove('hidden');
  const sim = store.sim;
  if (!sim) return;
  elDevActions.innerHTML = `
    <button class="btn sm" type="button" data-dt-sim="power">电源：${sim.pcPoweredOn ? '开' : '关'}</button>
    <button class="btn sm" type="button" data-dt-sim="lan">局域网：${sim.lanConnected ? '通' : '断'}</button>
    <button class="btn sm" type="button" data-dt-sim="0100">跳到 01:00</button>
    <button class="btn sm" type="button" data-dt-sim="end">自然结束</button>
    <button class="btn sm" type="button" data-dt-sim="reset-pair">重置预配对</button>
  `;
  elDevActions.querySelectorAll('[data-dt-sim]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const act = btn.dataset.dtSim;
      if (act === 'power') await desktopSystemAdapter.devSim.setNetwork({ pcPoweredOn: !sim.pcPoweredOn });
      else if (act === 'lan') await desktopSystemAdapter.devSim.setNetwork({ lanConnected: !sim.lanConnected });
      else if (act === '0100') await desktopSystemAdapter.devSim.adjustTime('JUMP_NIGHT_0100');
      else if (act === 'end') await desktopSystemAdapter.devSim.adjustTime('JUMP_NATURAL_END');
      else if (act === 'reset-pair') await desktopSystemAdapter.devSim.resetAll({ autoPair: true });
      await store.refresh();
    });
  });
}

// ---------------- 全量渲染 & 每秒无闪烁读数更新 ----------------
function renderAll() {
  const d = store.data;
  if (!d) return;

  if (d.pairing.status !== 'PAIRED' && activeView !== 'main') {
    activeView = 'main';
  }

  renderSidebar();
  renderPowerOffScreen();
  renderDevBar();
  renderConfirmModal();

  if (store.toastText) {
    elToast.textContent = store.toastText;
    elToast.classList.remove('hidden');
  } else {
    elToast.classList.add('hidden');
  }

  if (!d.pcPoweredOn) return;
  if (['off-req-id', 'off-session-id'].includes(document.activeElement?.id)) return;

  if (d.pairing.status !== 'PAIRED') {
    renderUnpairedCanvas();
    return;
  }

  const nowMs = store.getDisplayNowMs();
  const snap = d.snapshot;

  if (activeView === 'offline') renderOfflineCanvas(d, snap, nowMs, false);
  else if (activeView === 'logs') renderLogsCanvas(d, snap);
  else renderMainCanvas(d, snap, nowMs);
}

function renderClockTickOnly() {
  const d = store.data;
  if (!d) return;
  const nowMs = store.getDisplayNowMs();
  elClock.textContent = formatTimeHMS(nowMs);
  elDate.textContent = formatDateBadge(nowMs);

  // 配对码倒计时局部刷新
  const pairCd = elMain.querySelector('[data-dt-cd="pair"]');
  if (pairCd && d.pairing?.pendingExpiresAt) {
    const rem = Math.max(0, d.pairing.pendingExpiresAt - nowMs);
    pairCd.textContent = `剩余 ${formatCountdown(rem)}`;
    const bar = elMain.querySelector('[data-pair-bar]');
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, (rem / (3 * 60 * 1000)) * 100)).toFixed(1)}%`;
  }

  const snap = d.snapshot;
  if (!snap || !d.connected) return;

  // 在线主画布倒计时实时刷新
  const heroTitleEl = elMain.querySelector('[data-dt-hero-title]');
  if (heroTitleEl) {
    const kind = heroTitleEl.dataset.dtHeroTitle;
    if (kind === 'locked') heroTitleEl.textContent = `距自动恢复 ${formatCountdown(Math.max(0, snap.endAt - nowMs))}`;
    else if (kind === 'trial') heroTitleEl.textContent = `剩余 ${formatCountdown(Math.max(0, snap.endAt - nowMs))}`;
    else if (kind === 'prelock') heroTitleEl.textContent = `${formatCountdown(Math.max(0, snap.startAt - nowMs))} 后自动锁定`;
  }

  const idleCd = elMain.querySelector('[data-dt-cd="idle"]');
  if (idleCd && snap.startAt) {
    idleCd.textContent = formatCountdown(Math.max(0, snap.startAt - nowMs));
  }

  if (snap.tempAllow) {
    const rem = Math.max(0, snap.tempAllow.expiresAt - nowMs);
    const total = Math.max(1, snap.tempAllow.expiresAt - snap.tempAllow.startedAt);
    const allowCd = elMain.querySelector('[data-dt-cd="allow"]');
    if (allowCd) allowCd.textContent = formatCountdown(rem);
    const bar = elMain.querySelector('[data-allow-bar]');
    if (bar) {
      bar.style.width = `${Math.max(0, Math.min(100, (rem / total) * 100)).toFixed(1)}%`;
      bar.classList.toggle('near-end', rem <= 60 * 1000);
    }
  }
}

store.subscribe(renderAll);
store.subscribeTick(renderClockTickOnly);
store.init();
