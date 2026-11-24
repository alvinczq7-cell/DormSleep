// 熄灯守夜（DormSleep）Android 手机端交互与视图层
// 同时适配真实 Android WebView 满屏运行与桌面浏览器双端演示

import {
  APP_CATALOG,
  APP_MAP,
  EMERGENCY_ACTIONS,
  SESSION_STATES,
  TEMP_ALLOW_MINUTES,
} from '../../shared/constants.js';
import { ICONS, renderAppGlyph } from '../../shared/icons.js';
import { computeSleepDurationText, renderAllowRingSvg, renderSleepDialSvg } from '../../shared/sleepDial.js';
import {
  describeNightType,
  formatCountdown,
  formatDateTimeShort,
  formatTimeHM,
} from '../../shared/scheduleEngine.js';
import { mobileSystemAdapter } from '../../adapters/mobileSystemAdapter.js';
import { MobileStore } from './store.js';

const store = new MobileStore();
const IS_NATIVE = mobileSystemAdapter.isNativeAndroid();

if (IS_NATIVE) {
  document.documentElement.classList.add('native-android');
}

// 本地 UI 轻交互态
let overlayUnlockOpen = false;
let lastNativeOverlayKey = '';
let tonightEditorOpen = false;
let deviceLogMode = 'consumed'; // 'consumed' | 'events'
let appSearchQuery = '';
let devOpen = false;

const elPhone = document.getElementById('phone-shell');
const elBrandDot = document.getElementById('sb-brand-dot');
const elSbTime = document.getElementById('sb-time');
const elSbLink = document.getElementById('sb-link');
const elSbPerm = document.getElementById('sb-perm');
const elNotif = document.getElementById('notif-banner');
const elMain = document.getElementById('app-main');
const elNav = document.getElementById('bottom-nav');
const elFg = document.getElementById('foreground-view');
const elOverlay = document.getElementById('overlay-layer');
const elFeedback = document.getElementById('feedback-modal');
const elToast = document.getElementById('toast');
const elDevDrawer = document.getElementById('dev-drawer');
const elDevToggle = document.getElementById('dev-toggle');
const elDevPanel = document.getElementById('dev-panel');
const elDevArrow = document.getElementById('dev-arrow');

if (elBrandDot) elBrandDot.innerHTML = ICONS.brandMark(20);

// 真实 Android WebView 内彻底隐藏开发调试抽屉与模拟前景层
if (IS_NATIVE) {
  elDevDrawer?.classList.add('hidden');
}

elDevToggle?.addEventListener('click', () => {
  devOpen = !devOpen;
  elDevPanel?.classList.toggle('hidden', !devOpen);
  if (elDevArrow) elDevArrow.textContent = devOpen ? '×' : '';
});

const NAV_ITEMS = [
  { id: 'home', label: '今晚', icon: ICONS.moon(18) },
  { id: 'schedule', label: '计划', icon: ICONS.calendar(18) },
  { id: 'apps', label: '应用', icon: ICONS.grid(18) },
  { id: 'device', label: '设备', icon: ICONS.laptop(18) },
];

elNav.innerHTML = NAV_ITEMS.map(
  (item) => `
    <button type="button" data-tab="${item.id}" class="nav-btn">
      <span class="nav-ico-wrap">${item.icon}</span>
      <span>${item.label}</span>
    </button>
  `
).join('');

elNav.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  store.setTab(btn.dataset.tab);
});

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cleanName(name, fallback = '宿舍电脑') {
  return String(name || fallback).replace('（模拟）', '');
}

function getGuardOptions(d) {
  return {
    restrictionMode: d?.guardOptions?.restrictionMode || store.localGuardOptions.restrictionMode || 'WHITELIST_ALL',
    blockSettingsDuringLock:
      d?.guardOptions?.blockSettingsDuringLock !== undefined
        ? Boolean(d.guardOptions.blockSettingsDuringLock)
        : Boolean(store.localGuardOptions.blockSettingsDuringLock),
  };
}

function getCatalogApps(d) {
  if (Array.isArray(d?.installedApps) && d.installedApps.length > 0) {
    return d.installedApps;
  }
  return APP_CATALOG.filter((a) => a.category !== 'MANDATORY');
}

function resolveMobileAppName(d, appId) {
  if (!appId) return '指定应用';
  if (d?.live?.appLabels && d.live.appLabels[appId]) return d.live.appLabels[appId];
  const inst = Array.isArray(d?.installedApps) ? d.installedApps.find((x) => x.id === appId) : null;
  if (inst?.name) return inst.name;
  return APP_MAP[appId]?.name || appId;
}

function renderSwitch(on, attrs, tone = '') {
  return `<button type="button" role="switch" aria-checked="${on ? 'true' : 'false'}" class="switch ${on ? 'on' : ''} ${tone}" ${attrs}></button>`;
}

function isNightStatus(status) {
  return [SESSION_STATES.LOCKED, SESSION_STATES.TEMP_ALLOW, SESSION_STATES.TRIAL_LOCKED].includes(status);
}

function formatDialCountdown(ms) {
  const safe = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

// ---------------- 顶部状态栏 + 氛围主题切换 + 关键常驻横幅 ----------------
function renderStatusBarAndNotif() {
  const d = store.data;
  if (!d) return;
  const nowMs = store.getDisplayNowMs();
  const live = d.live;

  elSbTime.textContent = formatTimeHM(nowMs);
  elSbLink.innerHTML = `<span class="dot ${d.lanConnected ? 'ok' : 'warn'}"></span><span>${d.lanConnected ? '在线' : '离线'}</span>`;
  elSbPerm.innerHTML = `<span class="dot ${live.permissionsOk ? 'ok' : 'danger'}"></span><span>${live.permissionsOk ? '就绪' : '缺权限'}</span>`;

  const night = isNightStatus(live.status);
  const preLock = live.status === SESSION_STATES.PRE_LOCK_REMINDER;
  const allowMode = Boolean(live.tempAllow);
  elPhone.classList.toggle('night-mode', night && !allowMode);
  elPhone.classList.toggle('allow-mode', allowMode);
  document.body.classList.toggle('night-mode', night);
  elPhone.classList.toggle('prelock-mode', preLock);

  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.setAttribute('content', allowMode ? '#06141B' : night ? '#060814' : '#090C1E');

  if (live.status === SESSION_STATES.PROTECTION_INTERRUPTED) {
    elNotif.className = 'notif-banner danger';
    elNotif.innerHTML = `
      <span class="notif-left">${ICONS.shieldAlert(15)}<span>系统权限已关闭，夜间保护中断</span></span>
      <button type="button" class="btn xs danger-text" id="notif-fix-perm">立即修复</button>
    `;
    elNotif.querySelector('#notif-fix-perm')?.addEventListener('click', () => {
      store.updatePermissions({ usageStats: true, overlay: true, exactAlarm: true });
      if (!IS_NATIVE) store.showToast('已恢复关键系统权限');
    });
  } else if (live.tempAllow) {
    const appName = resolveMobileAppName(d, live.tempAllow.appId);
    const remMs = Math.max(0, live.tempAllow.expiresAt - nowMs);
    const nearEnd = remMs <= 60 * 1000;
    elNotif.className = `notif-banner ${nearEnd ? 'accent' : 'safe'}`;
    elNotif.innerHTML = `
      <span class="notif-left">${ICONS.clock(14)}<span>${nearEnd ? '即将恢复拦截' : '仅放行'} ${esc(appName)} · ${formatTimeHM(live.tempAllow.expiresAt)} 恢复</span></span>
      <span class="mono" style="font-size:11.5px;white-space:nowrap;">${formatDialCountdown(remMs)}</span>
    `;
  } else if (preLock) {
    const remMs = Math.max(0, live.startAt - nowMs);
    elNotif.className = 'notif-banner accent';
    elNotif.innerHTML = `
      <span class="notif-left">${ICONS.sunset(15)}<span>睡前收尾提醒 · 请准备休息</span></span>
      <span class="mono" style="font-size:11.5px;white-space:nowrap;">${formatDialCountdown(remMs)}</span>
    `;
  } else {
    elNotif.className = 'notif-banner hidden';
    elNotif.innerHTML = '';
  }
}

// ---------------- 首次 4 步引导 ----------------
function renderOnboarding() {
  const d = store.data;
  const step = store.onboardingStep;
  elNav.classList.add('hidden');
  elMain.classList.add('no-nav');

  const stepHeader = `
    <div class="ob-head">
      <span class="kicker-pill">${ICONS.moon(13)}<span>熄灯守夜 · 首次配置</span></span>
      <span class="ob-step-label">${step} / 4</span>
    </div>
    <div class="step-bar">
      ${[1, 2, 3, 4]
        .map((i) => `<div class="step-seg ${i < step ? 'done' : i === step ? 'active' : ''}"></div>`)
        .join('')}
    </div>
  `;

  if (step === 1) {
    const p = d.permissions;
    elMain.innerHTML = `
      ${stepHeader}
      <h1 class="page-h1">诚实边界与系统授权</h1>
      <p class="page-lead">仅限制你选中的娱乐应用，电话、短信、闹钟与校园门禁始终畅通。本应用不是整机锁屏，若权限被关闭会明确提示。</p>

      <div class="group">
        ${[
          ['usageStats', '使用情况访问', '识别当前打开的应用是否受限', ICONS.grid(16)],
          ['overlay', '悬浮窗显示', '到点自动弹出低亮夜间拦截页', ICONS.moon(16)],
          ['exactAlarm', '精确闹钟', '确保准点开始与次日准点恢复', ICONS.alarm(16)],
          ['batteryIgnore', '忽略电池优化', '防止夜间息屏后后台服务被回收', ICONS.shieldCheck(16)],
        ]
          .map(
            ([k, title, sub, icon]) => `
          <div class="row">
            <div class="row-left">
              <span class="app-glyph" style="width:34px;height:34px;border-radius:10px;background:${p[k] ? 'var(--safe-soft)' : 'var(--surface-muted)'};color:${p[k] ? 'var(--safe)' : 'var(--ink-2)'};">${icon}</span>
              <div>
                <div class="row-title">${title}</div>
                <div class="row-sub">${sub}</div>
              </div>
            </div>
            ${renderSwitch(p[k], `data-perm="${k}"`, 'safe')}
          </div>
        `
          )
          .join('')}
      </div>

      <div class="note-line" style="margin-top:12px;">
        ${ICONS.shield(15)}
        <span>${IS_NATIVE ? '开启开关将自动跳转至 Android 系统权限设置页，授权后返回即可。' : '当前为浏览器演示模拟授权；打包至真机后会直接引导前往 Android 系统设置。'}</span>
      </div>

      <div class="btn-row" style="margin-top:16px;">
        <button id="ob-next-1" type="button" class="btn solid block" ${d.live.permissionsOk ? '' : 'disabled'}>
          <span>${d.live.permissionsOk ? '继续下一步' : '请先开启前三项核心权限'}</span>
          ${d.live.permissionsOk ? ICONS.chevronRight(16) : ''}
        </button>
      </div>
    `;
    elMain.querySelectorAll('[data-perm]').forEach((btn) => {
      btn.addEventListener('click', () => store.updatePermissions({ [btn.dataset.perm]: !d.permissions[btn.dataset.perm] }));
    });
    elMain.querySelector('#ob-next-1')?.addEventListener('click', () => store.setOnboardingStep(2));
    return;
  }

  if (step === 2) {
    const paired = d.pairing.status === 'PAIRED';
    elMain.innerHTML = `
      ${stepHeader}
      <h1 class="page-h1">配对宿舍电脑</h1>
      <p class="page-lead">纯本地局域网配对，免注册、无云端。半夜确有急事时走到电脑前即可立即取码，宿舍断网也能离线算码。</p>

      <div class="group group-pad">
        <div class="pair-link-diagram">
          <div class="pair-node">${ICONS.smartphone(22)}</div>
          <div class="pair-wire"></div>
          <div class="pair-node">${ICONS.laptop(22)}</div>
        </div>
        ${
          paired
            ? `
              <div class="note-line safe" style="margin:0;align-items:center;">
                ${ICONS.shieldCheck(17)}
                <div>
                  <div style="font-weight:700;">已成功配对 ${esc(cleanName(d.pairing.desktopName))}</div>
                  <div style="font-size:11.5px;opacity:0.85;">本地安全密钥已存入设备，断网亦可离线校验</div>
                </div>
              </div>
            `
            : `
              <div class="field">
                <label for="ob-pair-code">输入电脑端显示的 8 位配对码</label>
                <input id="ob-pair-code" class="input pair-code-input" maxlength="8" autocomplete="off" placeholder="A8K3M9Q2" />
              </div>
              <div class="field" style="margin-top:12px;">
                <label for="ob-pair-host">电脑局域网地址（可选，搜不到电脑时填写）</label>
                <input id="ob-pair-host" class="input mono" autocomplete="off" placeholder="留空自动发现，如 192.168.43.128:4180" />
              </div>
              <div class="btn-row">
                <button id="ob-pair-submit" type="button" class="btn solid block">${ICONS.link(15)}<span>确认配对</span></button>
              </div>
            `
        }
      </div>

      <div class="btn-row" style="margin-top:16px;">
        <button id="ob-prev-2" type="button" class="btn subtle">上一步</button>
        <button id="ob-next-2" type="button" class="btn solid" style="flex:1" ${paired ? '' : 'disabled'}>继续下一步</button>
      </div>
    `;
    const pairInput = elMain.querySelector('#ob-pair-code');
    const hostInput = elMain.querySelector('#ob-pair-host');
    const doPair = async () => {
      const code = pairInput?.value.trim() || '';
      const host = hostInput?.value.trim() || '';
      if (!code) return store.showToast('请输入电脑端 8 位配对码');
      await store.confirmPairing(code, host);
    };
    elMain.querySelector('#ob-pair-submit')?.addEventListener('click', doPair);
    pairInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doPair();
    });
    hostInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doPair();
    });
    elMain.querySelector('#ob-prev-2')?.addEventListener('click', () => store.setOnboardingStep(1));
    elMain.querySelector('#ob-next-2')?.addEventListener('click', () => store.setOnboardingStep(3));
    return;
  }

  if (step === 3) {
    const exempt = new Set(d.apps.exemptAppIds);
    const catalog = getCatalogApps(d);
    const essentialApps = catalog.filter((a) => a.category === 'ESSENTIAL' || a.category === 'HYBRID');

    elMain.innerHTML = `
      ${stepHeader}
      <h1 class="page-h1">核对明早必用清单</h1>
      <p class="page-lead">默认采用「严格白名单」守夜：除电话/短信/闹钟与你豁免的校园刚需外，其余应用锁机期间均被拦截。</p>

      <div class="mandatory-strip">
        ${ICONS.shieldCheck(16)}
        <span>系统电话、短信与早八闹钟已默认强制放行，不可限制</span>
      </div>

      <div class="group">
        ${
          essentialApps.length === 0
            ? '<div class="row"><span class="row-sub">未检测到需要特别提示的校园/混合应用，你随时可在「应用」页勾选本机任意已装应用加入豁免白名单。</span></div>'
            : essentialApps
                .map((app) => {
                  const checked = exempt.has(app.id);
                  return `
                    <div class="row" style="align-items:flex-start;">
                      <div class="row-left" style="align-items:flex-start;">
                        ${renderAppGlyph(app.id, 34, false)}
                        <div style="min-width:0;">
                          <div class="row-title">
                            ${esc(app.name)}
                            ${checked && app.campusCodeWarning ? '<span class="tag warn" style="margin-left:4px;">整应用放行 · 含校园码</span>' : ''}
                          </div>
                          <div class="row-sub">${esc(app.description)}</div>
                          ${
                            app.campusCodeWarning
                              ? `<div class="note-line warn" style="margin:7px 0 2px;padding:8px 10px;font-size:11.5px;">${ICONS.alert(14)}<span>${esc(app.campusWarningText)}</span></div>`
                              : ''
                          }
                        </div>
                      </div>
                      ${renderSwitch(checked, `data-ob-exempt="${app.id}"`, 'safe')}
                    </div>
                  `;
                })
                .join('')
        }
      </div>

      <div class="btn-row" style="margin-top:16px;">
        <button id="ob-prev-3" type="button" class="btn subtle">上一步</button>
        <button id="ob-next-3" type="button" class="btn solid" style="flex:1">清单已核对，继续</button>
      </div>
    `;
    elMain.querySelectorAll('[data-ob-exempt]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.obExempt;
        const nextExempt = new Set(d.apps.exemptAppIds);
        const nextRestricted = new Set(d.apps.restrictedAppIds);
        if (nextExempt.has(id)) nextExempt.delete(id);
        else {
          nextExempt.add(id);
          nextRestricted.delete(id);
        }
        store.updateApps([...nextRestricted], [...nextExempt]);
      });
    });
    elMain.querySelector('#ob-prev-3')?.addEventListener('click', () => store.setOnboardingStep(2));
    elMain.querySelector('#ob-next-3')?.addEventListener('click', () => store.setOnboardingStep(4));
    return;
  }

  // Step 4: 白天 3 分钟试锁（可跳过）
  elMain.innerHTML = `
    ${stepHeader}
    <h1 class="page-h1">白天试锁 3 分钟</h1>
    <p class="page-lead">趁白天清醒走一遍完整闭环，确认不会误拦闹钟和校园码。满 3 分钟自动恢复，也可以直接跳过。</p>

    <div class="group">
      <div class="row">
        <div class="row-left">
          <span class="app-glyph" style="width:34px;height:34px;border-radius:10px;background:var(--accent-soft);color:var(--accent);">${ICONS.moon(16)}</span>
          <div><div class="row-title">试开受限娱乐应用</div><div class="row-sub">弹出柔和低亮拦截页</div></div>
        </div>
      </div>
      <div class="row">
        <div class="row-left">
          <span class="app-glyph" style="width:34px;height:34px;border-radius:10px;background:var(--safe-soft);color:var(--safe);">${ICONS.idCard(16)}</span>
          <div><div class="row-title">试开闹钟与校园门禁</div><div class="row-sub">验证必用入口一键直达</div></div>
        </div>
      </div>
      <div class="row">
        <div class="row-left">
          <span class="app-glyph" style="width:34px;height:34px;border-radius:10px;background:var(--surface-muted);color:var(--ink);">${ICONS.key(16)}</span>
          <div><div class="row-title">到电脑体验一次取码</div><div class="row-sub">感受 20 分钟单应用放行或结束试锁</div></div>
        </div>
      </div>
    </div>

    <div class="btn-row" style="flex-direction:column;margin-top:18px;gap:10px;">
      <button id="ob-start-trial" type="button" class="btn solid block">${ICONS.flask(16)}<span>开始 3 分钟白天试锁</span></button>
      <button id="ob-skip-trial" type="button" class="btn subtle block">跳过试锁，今晚按计划生效</button>
    </div>
  `;
  elMain.querySelector('#ob-start-trial')?.addEventListener('click', async () => {
    await store.completeOnboarding(true);
    await store.startTrial();
  });
  elMain.querySelector('#ob-skip-trial')?.addEventListener('click', () => store.skipTrial());
}

// ---------------- Tab 1：今晚首页 ----------------
function renderHomeTab() {
  const d = store.data;
  const live = d.live;
  const nowMs = store.getDisplayNowMs();
  const night = isNightStatus(live.status);
  const effRestricted = new Set(live.effectiveRestrictedAppIds);
  const guard = getGuardOptions(d);
  const isWhitelist = guard.restrictionMode === 'WHITELIST_ALL';

  let heroHtml = '';

  if (live.status === SESSION_STATES.PROTECTION_INTERRUPTED) {
    heroHtml = `
      <div class="state-hero-card danger">
        <div class="state-orb danger">${ICONS.shieldAlert(26)}</div>
        <span class="kicker-pill danger"><span class="dot danger"></span>保护已中断</span>
        <h1 class="page-h1" style="margin-top:10px;">缺少关键系统权限</h1>
        <p class="page-lead" style="margin-bottom:16px;">检测到使用情况、悬浮窗或精确闹钟权限已关闭，今晚限制目前未真正生效。</p>
        <button id="home-fix-perm" type="button" class="btn accent block">${ICONS.shieldCheck(16)}<span>立即恢复系统权限</span></button>
      </div>
    `;
  } else if (live.tempAllow) {
    const allowApp = resolveMobileAppName(d, live.tempAllow.appId);
    const otherCount = Math.max(0, live.effectiveRestrictedAppIds.length - 1);
    const totalMs = Math.max(1, live.tempAllow.expiresAt - live.tempAllow.startedAt);
    const remMs = Math.max(0, live.tempAllow.expiresAt - nowMs);

    heroHtml = `
      <section class="dial-hero">
        <span class="kicker-pill safe"><span class="dot ok"></span>${live.activeMode === 'TRIAL' ? '试锁临时放行' : '临时放行 20 分钟中'}</span>
        ${renderAllowRingSvg({
          remMs,
          totalMs,
          appName: allowApp,
          expiresText: formatTimeHM(live.tempAllow.expiresAt),
          isNight: night,
        })}
        <div class="metric-strip">
          <div class="metric-cell"><span>本次放行</span><strong style="color:var(--safe);">${esc(allowApp)}</strong></div>
          <div class="metric-cell"><span>其余受限</span><strong>${isWhitelist ? '除豁免外全拦' : `${otherCount} 个仍拦截`}</strong></div>
          <div class="metric-cell"><span>恢复拦截</span><strong class="mono">${formatTimeHM(live.tempAllow.expiresAt)}</strong></div>
        </div>
        <div class="btn-row" style="width:100%;">
          <button id="home-relock-now" type="button" class="btn solid block">${ICONS.lock(15)}<span>办完急事，立即恢复锁定</span></button>
        </div>
      </section>
    `;
  } else if (live.status === SESSION_STATES.TRIAL_LOCKED || live.status === SESSION_STATES.LOCKED) {
    const remMs = Math.max(0, live.endAt - nowMs);
    const isTrial = live.status === SESSION_STATES.TRIAL_LOCKED;

    heroHtml = `
      <section class="dial-hero">
        <span class="kicker-pill warn"><span class="dot warn"></span>${isTrial ? '白天试锁 3 分钟' : '夜间守夜生效中'}</span>
        ${renderSleepDialSvg({
          nowMs,
          startAt: live.startAt,
          endAt: live.endAt,
          freezeCutoffAt: null,
          centerBadge: isTrial ? '试锁倒计时' : '距自动恢复',
          centerMain: formatDialCountdown(remMs),
          centerSub: isTrial ? '满 3 分钟自动恢复' : `${formatTimeHM(live.endAt)} 准时结束`,
          accentColor: '#F0A35E',
          isNight: true,
        })}
        <div class="metric-strip">
          <div class="metric-cell">
            <span>${isWhitelist ? '限制模式' : '受限应用'}</span>
            <strong>${isWhitelist ? '严格白名单' : `${effRestricted.size} 个已拦`}</strong>
          </div>
          <div class="metric-cell">
            <span>${guard.blockSettingsDuringLock ? '防绕过保护' : '必要服务'}</span>
            <strong style="color:var(--safe);">${guard.blockSettingsDuringLock ? '设置已拦' : '全部畅通'}</strong>
          </div>
          <div class="metric-cell"><span>自动恢复</span><strong class="mono">${formatTimeHM(live.endAt)}</strong></div>
        </div>
        <div class="btn-row" style="width:100%;">
          <button id="home-open-overlay" type="button" class="btn accent block">${ICONS.key(15)}<span>打开夜间拦截页 / 输入应急码</span></button>
        </div>
      </section>
    `;
  } else if (live.status === SESSION_STATES.ENDED_EARLY) {
    heroHtml = `
      <div class="state-hero-card">
        <div class="state-orb">${ICONS.unlock(24)}</div>
        <span class="kicker-pill safe"><span class="dot ok"></span>今晚已提前解除</span>
        <h1 class="page-h1" style="margin-top:10px;">所有应用已恢复</h1>
        <p class="page-lead" style="margin-bottom:16px;">明晚 <strong class="mono">${formatDateTimeShort(live.nextRegularResumeAt)}</strong> 将按常规计划照常开启。</p>
        <button id="home-relock-now" type="button" class="btn subtle block">${ICONS.lock(15)}<span>办完事了，重新开启今晚限制</span></button>
      </div>
    `;
  } else if (live.status === SESSION_STATES.NATURAL_ENDED) {
    heroHtml = `
      <div class="state-hero-card">
        <div class="state-orb">${ICONS.sun(26)}</div>
        <span class="kicker-pill safe"><span class="dot ok"></span>已按时自然恢复</span>
        <h1 class="page-h1" style="margin-top:10px;">早安，守夜完成</h1>
        <p class="page-lead" style="margin-bottom:0;">已于 <strong class="mono">${formatTimeHM(live.endAt)}</strong> 自动解除限制（无需取码）。明晚 <strong class="mono">${formatDateTimeShort(live.nextRegularResumeAt)}</strong> 继续。</p>
      </div>
    `;
  } else {
    const paused = live.status === SESSION_STATES.PAUSED_TONIGHT;
    const pre = live.status === SESSION_STATES.PRE_LOCK_REMINDER;
    const remMs = Math.max(0, live.startAt - nowMs);
    heroHtml = `
      <section class="dial-hero">
        <span class="kicker-pill ${pre ? 'warn' : ''}">
          <span class="dot ${pre ? 'warn' : 'ok'}"></span>
          ${paused ? '今晚已暂停一次' : pre ? '睡前收尾提醒中' : describeNightType(live.nightKey)}
        </span>
        ${renderSleepDialSvg({
          nowMs,
          startAt: live.startAt,
          endAt: live.endAt,
          freezeCutoffAt: live.freezeCutoffAt,
          centerBadge: paused ? '单晚暂停' : pre ? '即将锁定' : '今晚熄灯',
          centerMain: paused ? '今晚休息' : pre ? formatDialCountdown(remMs) : formatTimeHM(live.startAt),
          centerSub: paused ? '明晚自动恢复' : pre ? `${formatTimeHM(live.startAt)} 自动生效` : `至次日 ${formatTimeHM(live.endAt)}`,
          accentColor: pre ? '#C85A28' : '#26304D',
          isNight: false,
          isPreLock: pre,
          paused,
        })}
        <div class="dial-caption" data-home-caption="1">
          ${
            paused
              ? `下次恢复常规计划 <strong class="mono">${formatDateTimeShort(live.nextRegularResumeAt)}</strong>`
              : `距开始 <strong class="mono" data-home-start-cd="1">${formatCountdown(remMs)}</strong> · 提前 ${d.schedule.preReminderMinutes} 分钟收尾提醒`
          }
        </div>
        <div class="metric-strip">
          <div class="metric-cell"><span>就寝时段</span><strong class="mono">${paused ? '已暂停' : `${formatTimeHM(live.startAt)}–${formatTimeHM(live.endAt)}`}</strong></div>
          <div class="metric-cell"><span>修改截止</span><strong class="mono">${formatTimeHM(live.freezeCutoffAt)}</strong></div>
          <div class="metric-cell">
            <span>${isWhitelist ? '守夜模式' : '受限娱乐'}</span>
            <strong>${isWhitelist ? '严格白名单' : `${effRestricted.size} 个应用`}</strong>
          </div>
        </div>
      </section>
    `;
  }

  // 「仅改今晚」卡片
  const frozen = live.isFrozen;
  const ov = live.tonightOverride;
  const startVal = ov?.start || formatTimeHM(live.startAt);
  const endVal = ov?.end || formatTimeHM(live.endAt);

  const tonightBlock = `
    <div class="sec-head">
      <h2 class="sec-title">仅改今晚</h2>
      <span class="sec-note">${frozen ? `已过固定截止 ${formatTimeHM(live.freezeCutoffAt)}` : `固定截止 ${formatTimeHM(live.freezeCutoffAt)}`}</span>
    </div>
    <div class="group group-pad">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
        <div style="min-width:0;">
          <div class="row-title">
            ${
              ov
                ? ov.mode === 'PAUSE_TONIGHT'
                  ? '今晚已暂停一次'
                  : `今晚临时调整为 ${esc(ov.start)} – ${esc(ov.end)}`
                : '临时改期或暂停今晚一次'
            }
          </div>
          <div class="row-sub">
            ${
              ov
                ? `明晚 ${formatDateTimeShort(ov.nextRegularResumeAt)} 自动恢复原计划`
                : frozen
                  ? '已进入冻结期，今晚不可再改期或暂停'
                  : '截止时间固定，推迟开始不延长修改窗口'
            }
          </div>
        </div>
        ${
          frozen
            ? `<span class="tag">${ICONS.lock(11)}<span>已冻结</span></span>`
            : `<button id="toggle-tonight-edit" type="button" class="btn sm subtle">${tonightEditorOpen ? '收起' : '调整'}</button>`
        }
      </div>

      ${
        !frozen && tonightEditorOpen
          ? `
            <div class="form-2" style="margin-top:12px;">
              <div class="field"><label for="tonight-start">今晚开始</label><input id="tonight-start" type="time" class="input mono" value="${esc(startVal)}" /></div>
              <div class="field"><label for="tonight-end">明早结束</label><input id="tonight-end" type="time" class="input mono" value="${esc(endVal)}" /></div>
            </div>
            <div class="btn-row">
              <button id="btn-tonight-save" type="button" class="btn solid" style="flex:1">保存仅改今晚</button>
              <button id="btn-tonight-pause" type="button" class="btn subtle">暂停今晚</button>
              ${ov ? '<button id="btn-tonight-clear" type="button" class="btn sm subtle">恢复原计划</button>' : ''}
            </div>
          `
          : ''
      }
    </div>
  `;

  // 浏览器演示模式专属：模拟打开应用区（真实 Android WebView 内完全隐藏）
  let quickAppsBlock = '';
  if (!IS_NATIVE) {
    const restrictedApps = APP_CATALOG.filter((a) => effRestricted.has(a.id)).slice(0, 4);
    const safeApps = APP_CATALOG.filter((a) => a.category === 'MANDATORY' || live.effectiveExemptAppIds.includes(a.id)).slice(0, 4);

    quickAppsBlock = `
      <div class="sec-head">
        <h2 class="sec-title">模拟打开应用</h2>
        <span class="sec-note">演示拦截与放行</span>
      </div>
      <div class="group">
        <div class="quick-apps">
          ${[...restrictedApps, ...safeApps]
            .map((app) => {
              const isRestr = effRestricted.has(app.id);
              const isAllowed = live.tempAllow?.appId === app.id;
              return `
                <button type="button" class="quick-app-btn" data-open-app="${app.id}">
                  ${renderAppGlyph(app.id, 40, night)}
                  <span class="quick-app-name">${esc(app.name.split('（')[0])}</span>
                  <span class="quick-app-state" style="${isAllowed ? 'color:var(--safe);font-weight:700;' : isRestr && night ? 'color:var(--accent);' : ''}">
                    ${isAllowed ? `放行至${formatTimeHM(live.tempAllow.expiresAt)}` : isRestr ? '受限' : '必用'}
                  </span>
                </button>
              `;
            })
            .join('')}
        </div>
      </div>
    `;
  }

  elMain.innerHTML = `${heroHtml}${tonightBlock}${quickAppsBlock}`;

  elMain.querySelector('#home-fix-perm')?.addEventListener('click', () => {
    store.updatePermissions({ usageStats: true, overlay: true, exactAlarm: true });
  });
  elMain.querySelector('#home-relock-now')?.addEventListener('click', () => store.relockEarly());
  elMain.querySelector('#home-open-overlay')?.addEventListener('click', () => store.openManualOverlay());
  elMain.querySelector('#toggle-tonight-edit')?.addEventListener('click', () => {
    tonightEditorOpen = !tonightEditorOpen;
    renderAll();
  });
  elMain.querySelector('#btn-tonight-save')?.addEventListener('click', async () => {
    await store.applyTonightOverride({
      mode: 'CUSTOM_TIME',
      start: elMain.querySelector('#tonight-start').value,
      end: elMain.querySelector('#tonight-end').value,
    });
    tonightEditorOpen = false;
  });
  elMain.querySelector('#btn-tonight-pause')?.addEventListener('click', async () => {
    await store.applyTonightOverride({ mode: 'PAUSE_TONIGHT' });
    tonightEditorOpen = false;
  });
  elMain.querySelector('#btn-tonight-clear')?.addEventListener('click', async () => {
    await store.applyTonightOverride({ mode: 'CLEAR' });
    tonightEditorOpen = false;
  });
  elMain.querySelectorAll('[data-open-app]').forEach((btn) => {
    btn.addEventListener('click', () => store.openSimulatedApp(btn.dataset.openApp));
  });
}

// ---------------- Tab 2：计划页 ----------------
function renderScheduleTab() {
  const d = store.data;
  const s = d.pendingNextNight.schedule || d.schedule;
  const frozen = d.live.isFrozen;

  const schoolDur = computeSleepDurationText(s.schoolNight.start, s.schoolNight.end);
  const wkDur = computeSleepDurationText(s.weekendNight.start, s.weekendNight.end);

  elMain.innerHTML = `
    <h1 class="page-h1">就寝计划</h1>
    <p class="page-lead">${frozen ? '已过今晚固定截止时间，常规计划修改将自动顺延至明晚生效。' : '按入睡那一晚区分上学夜与周末夜，到点自动开启并自动恢复。'}</p>

    ${
      d.pendingNextNight.schedule
        ? `<div class="note-line warn">${ICONS.clock(15)}<span><strong>待明晚生效：</strong>上学夜 ${esc(s.schoolNight.start)}–${esc(s.schoolNight.end)} · 周末夜 ${esc(s.weekendNight.start)}–${esc(s.weekendNight.end)}</span></div>`
        : ''
    }

    <div class="sec-head">
      <h2 class="sec-title">上学夜（周日 – 周四晚）</h2>
      <span class="sec-note" id="dur-school">约 ${esc(schoolDur)}</span>
    </div>
    <div class="group group-pad">
      <div class="row" style="padding-top:0;">
        <div>
          <div class="row-title">启用上学夜守夜</div>
          <div class="row-sub">保障次日早八精神状态</div>
        </div>
        ${renderSwitch(s.schoolNight.enabled, 'id="sch-school-en"', 'accent')}
      </div>
      <div class="form-2" style="margin-top:12px;">
        <div class="field"><label for="sch-school-s">熄灯开始</label><input id="sch-school-s" type="time" class="input mono" value="${esc(s.schoolNight.start)}" /></div>
        <div class="field"><label for="sch-school-e">次日恢复</label><input id="sch-school-e" type="time" class="input mono" value="${esc(s.schoolNight.end)}" /></div>
      </div>
    </div>

    <div class="sec-head">
      <h2 class="sec-title">周末夜（周五、周六晚）</h2>
      <span class="sec-note" id="dur-wk">约 ${esc(wkDur)}</span>
    </div>
    <div class="group group-pad">
      <div class="row" style="padding-top:0;">
        <div>
          <div class="row-title">启用周末夜守夜</div>
          <div class="row-sub">可适当放宽就寝与起床时刻</div>
        </div>
        ${renderSwitch(s.weekendNight.enabled, 'id="sch-wk-en"', 'accent')}
      </div>
      <div class="form-2" style="margin-top:12px;">
        <div class="field"><label for="sch-wk-s">熄灯开始</label><input id="sch-wk-s" type="time" class="input mono" value="${esc(s.weekendNight.start)}" /></div>
        <div class="field"><label for="sch-wk-e">次日恢复</label><input id="sch-wk-e" type="time" class="input mono" value="${esc(s.weekendNight.end)}" /></div>
      </div>
    </div>

    <div class="sec-head">
      <h2 class="sec-title">睡前温和收尾提醒</h2>
      <span class="sec-note">锁定前提前通知</span>
    </div>
    <div class="group group-pad">
      <div class="pill-seg" id="sch-pre-seg" data-val="${s.preReminderMinutes}">
        ${[5, 10, 15]
          .map(
            (m) =>
              `<button type="button" data-pre-min="${m}" class="${s.preReminderMinutes === m ? 'active' : ''}">提前 ${m} 分钟</button>`
          )
          .join('')}
      </div>
    </div>

    <div class="btn-row" style="margin-top:18px;">
      <button id="btn-save-sched" type="button" class="btn solid block">${ICONS.check(16)}<span>${frozen ? '保存（将于明晚生效）' : '保存常规计划'}</span></button>
    </div>
  `;

  ['sch-school-en', 'sch-wk-en'].forEach((id) => {
    const sw = elMain.querySelector(`#${id}`);
    sw?.addEventListener('click', () => {
      const next = !sw.classList.contains('on');
      sw.classList.toggle('on', next);
      sw.setAttribute('aria-checked', String(next));
    });
  });

  const bindDur = (sId, eId, outId) => {
    const sEl = elMain.querySelector(`#${sId}`);
    const eEl = elMain.querySelector(`#${eId}`);
    const outEl = elMain.querySelector(`#${outId}`);
    const upd = () => {
      if (outEl) outEl.textContent = `约 ${computeSleepDurationText(sEl.value, eEl.value)}`;
    };
    sEl?.addEventListener('input', upd);
    eEl?.addEventListener('input', upd);
  };
  bindDur('sch-school-s', 'sch-school-e', 'dur-school');
  bindDur('sch-wk-s', 'sch-wk-e', 'dur-wk');

  const preSeg = elMain.querySelector('#sch-pre-seg');
  preSeg?.querySelectorAll('[data-pre-min]').forEach((btn) => {
    btn.addEventListener('click', () => {
      preSeg.dataset.val = btn.dataset.preMin;
      preSeg.querySelectorAll('[data-pre-min]').forEach((b) => b.classList.toggle('active', b === btn));
    });
  });

  elMain.querySelector('#btn-save-sched')?.addEventListener('click', () => {
    store.updateSchedule({
      schoolNight: {
        enabled: elMain.querySelector('#sch-school-en').classList.contains('on'),
        start: elMain.querySelector('#sch-school-s').value,
        end: elMain.querySelector('#sch-school-e').value,
      },
      weekendNight: {
        enabled: elMain.querySelector('#sch-wk-en').classList.contains('on'),
        start: elMain.querySelector('#sch-wk-s').value,
        end: elMain.querySelector('#sch-wk-e').value,
      },
      preReminderMinutes: Number(preSeg?.dataset.val || 10),
    });
  });
}

// ---------------- Tab 3：应用页（支持严格白名单 / 仅拦指定应用随时切换 + 锁机防绕过开关 + 真机已装应用搜索） ----------------
function renderAppsListInto(container, d) {
  if (!container || !d) return;
  const night = isNightStatus(d.live.status);
  const frozen = d.live.isFrozen;
  const guard = getGuardOptions(d);
  const isWhitelist = guard.restrictionMode === 'WHITELIST_ALL';
  const effRestricted = new Set(d.live.effectiveRestrictedAppIds);
  const effExempt = new Set(d.live.effectiveExemptAppIds);
  const nextRestricted = new Set(d.pendingNextNight.restrictedAppIds ?? d.apps.restrictedAppIds);
  const nextExempt = new Set(d.pendingNextNight.exemptAppIds ?? d.apps.exemptAppIds);

  const catalog = getCatalogApps(d);
  const q = appSearchQuery.trim().toLowerCase();
  const filtered = q
    ? catalog.filter((a) => (a.name || '').toLowerCase().includes(q) || (a.id || '').toLowerCase().includes(q))
    : catalog;

  const sortOrderCat = (cat) => (cat === 'ESSENTIAL' ? 0 : cat === 'HYBRID' ? 1 : cat === 'ENTERTAINMENT' ? 2 : 3);

  let html = '';

  if (isWhitelist) {
    const sorted = [...filtered].sort((a, b) => {
      const aEx = nextExempt.has(a.id) ? 0 : 1;
      const bEx = nextExempt.has(b.id) ? 0 : 1;
      if (aEx !== bEx) return aEx - bEx;
      const ca = sortOrderCat(a.category);
      const cb = sortOrderCat(b.category);
      if (ca !== cb) return ca - cb;
      return (a.name || '').localeCompare(b.name || '', 'zh-CN');
    });

    html = `
      <div class="sec-head">
        <h2 class="sec-title">允许夜间使用的豁免白名单</h2>
        <span class="sec-note">${sorted.length} 个已装应用 · 未勾选全拦</span>
      </div>
      <div class="note-line warn" style="margin-top:0;">
        ${ICONS.alert(15)}
        <span>严格白名单下，仅开启下方「豁免」开关的应用可在锁机期使用；其余所有应用（含新装游戏）均自动拦截。放行微信/支付宝将放行整个应用。</span>
      </div>
      <div class="group">
        ${
          sorted.length === 0
            ? `<div class="row"><span class="row-sub">未找到匹配「${esc(appSearchQuery)}」的已安装应用</span></div>`
            : sorted
                .map((a) => {
                  const isExemptNext = nextExempt.has(a.id);
                  const pendingExempt = !effExempt.has(a.id) && isExemptNext && frozen;
                  return `
                    <div class="row">
                      <div class="row-left">
                        ${renderAppGlyph(a.id, 34, night)}
                        <div style="min-width:0;">
                          <div class="row-title">
                            ${esc(a.name)}
                            ${isExemptNext ? '<span class="tag safe" style="margin-left:4px;">已豁免</span>' : '<span class="tag warn" style="margin-left:4px;">锁机拦截</span>'}
                            ${isExemptNext && a.campusCodeWarning ? '<span class="tag warn" style="margin-left:4px;">整应用放行</span>' : ''}
                            ${pendingExempt ? '<span class="tag" style="margin-left:4px;">明晚生效</span>' : ''}
                          </div>
                          <div class="row-sub">${esc(a.description || a.id)}</div>
                        </div>
                      </div>
                      ${renderSwitch(isExemptNext, `data-toggle-exempt="${esc(a.id)}"`, 'safe')}
                    </div>
                  `;
                })
                .join('')
        }
      </div>
    `;
  } else {
    const campusAndHybrid = filtered.filter((a) => a.category === 'ESSENTIAL' || a.category === 'HYBRID');
    const restrictCandidates = filtered
      .filter((a) => a.category !== 'ESSENTIAL' && a.category !== 'HYBRID')
      .sort((a, b) => {
        const aR = nextRestricted.has(a.id) ? 0 : 1;
        const bR = nextRestricted.has(b.id) ? 0 : 1;
        if (aR !== bR) return aR - bR;
        const ca = sortOrderCat(a.category);
        const cb = sortOrderCat(b.category);
        if (ca !== cb) return ca - cb;
        return (a.name || '').localeCompare(b.name || '', 'zh-CN');
      });

    html = `
      <div class="sec-head">
        <h2 class="sec-title">选择夜间拦截的应用</h2>
        <span class="sec-note">${restrictCandidates.length} 个可选 · 到点弹出拦截页</span>
      </div>
      <div class="group">
        ${
          restrictCandidates.length === 0
            ? `<div class="row"><span class="row-sub">未找到匹配「${esc(appSearchQuery)}」的应用</span></div>`
            : restrictCandidates
                .map((a) => {
                  const isRestrNext = nextRestricted.has(a.id);
                  const pendingRemove = effRestricted.has(a.id) && !isRestrNext;
                  return `
                    <div class="row">
                      <div class="row-left">
                        ${renderAppGlyph(a.id, 34, night)}
                        <div style="min-width:0;">
                          <div class="row-title">
                            ${esc(a.name)}
                            ${pendingRemove ? '<span class="tag warn" style="margin-left:4px;">明晚取消</span>' : ''}
                          </div>
                          <div class="row-sub">${esc(a.description || a.id)}</div>
                        </div>
                      </div>
                      ${renderSwitch(isRestrNext, `data-toggle-restrict="${esc(a.id)}"`, 'accent')}
                    </div>
                  `;
                })
                .join('')
        }
      </div>

      ${
        campusAndHybrid.length > 0
          ? `
            <div class="sec-head">
              <h2 class="sec-title">校园刚需与豁免应用</h2>
              <span class="sec-note">按需放行</span>
            </div>
            <div class="note-line warn" style="margin-top:0;">
              ${ICONS.alert(15)}
              <span>校园码若依赖微信或支付宝小程序，开启豁免将放行整个微信或支付宝应用（Android 普通权限无法单放单个小程序）。</span>
            </div>
            <div class="group">
              ${campusAndHybrid
                .map((a) => {
                  const isExemptNext = nextExempt.has(a.id);
                  const pendingExempt = !effExempt.has(a.id) && isExemptNext && frozen;
                  return `
                    <div class="row">
                      <div class="row-left">
                        ${renderAppGlyph(a.id, 34, night)}
                        <div style="min-width:0;">
                          <div class="row-title">
                            ${esc(a.name)}
                            ${isExemptNext && a.campusCodeWarning ? '<span class="tag warn" style="margin-left:4px;">整应用放行 · 含校园码</span>' : ''}
                            ${pendingExempt ? '<span class="tag" style="margin-left:4px;">明晚生效</span>' : ''}
                          </div>
                          <div class="row-sub">${esc(a.description || a.id)}</div>
                        </div>
                      </div>
                      ${renderSwitch(isExemptNext, `data-toggle-exempt="${esc(a.id)}"`, 'safe')}
                    </div>
                  `;
                })
                .join('')}
            </div>
          `
          : ''
      }
    `;
  }

  container.innerHTML = html;

  container.querySelectorAll('[data-toggle-exempt]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.toggleExempt;
      const r = new Set(nextRestricted);
      const ex = new Set(nextExempt);
      if (ex.has(id)) ex.delete(id);
      else {
        ex.add(id);
        r.delete(id);
      }
      store.updateApps([...r], [...ex]);
    });
  });

  container.querySelectorAll('[data-toggle-restrict]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.toggleRestrict;
      const r = new Set(nextRestricted);
      const ex = new Set(nextExempt);
      if (r.has(id)) r.delete(id);
      else {
        r.add(id);
        ex.delete(id);
      }
      store.updateApps([...r], [...ex]);
    });
  });
}

function renderAppsTab() {
  const d = store.data;
  const night = isNightStatus(d.live.status);
  const frozen = d.live.isFrozen;
  const guard = getGuardOptions(d);
  const isWhitelist = guard.restrictionMode === 'WHITELIST_ALL';
  const blockSettings = guard.blockSettingsDuringLock;
  const effRestricted = new Set(d.live.effectiveRestrictedAppIds);
  const effExempt = new Set(d.live.effectiveExemptAppIds);
  const mandatory = APP_CATALOG.filter((a) => a.category === 'MANDATORY');

  elMain.innerHTML = `
    <h1 class="page-h1">应用管理</h1>
    <div class="summary-pills">
      ${
        isWhitelist
          ? `<span class="tag warn">严格白名单 · 除豁免外全拦</span>`
          : `<span class="tag warn">今晚受限 ${effRestricted.size} 个</span>`
      }
      <span class="tag safe">已豁免 ${effExempt.size} 个</span>
      <span class="tag ${blockSettings ? 'safe' : ''}">${blockSettings ? '防绕过：已开' : '防绕过：已关'}</span>
    </div>

    ${
      frozen
        ? `<div class="note-line warn">${ICONS.lock(14)}<span>当前处于冻结期：收紧限制立即生效，放宽限制（取消受限或新增豁免）将顺延至明晚生效。限制模式与防绕过开关可随时更改。</span></div>`
        : ''
    }

    <div class="sec-head">
      <h2 class="sec-title">守夜拦截策略</h2>
      <span class="sec-note">随时可切换</span>
    </div>
    <div class="group group-pad">
      <div class="pill-seg cols-2" id="apps-mode-seg">
        <button type="button" data-guard-mode="WHITELIST_ALL" class="${isWhitelist ? 'active' : ''}">严格白名单（推荐）</button>
        <button type="button" data-guard-mode="BLACKLIST_SELECTED" class="${!isWhitelist ? 'active' : ''}">仅拦指定应用</button>
      </div>
      <div class="row-sub" style="margin-top:9px;">
        ${
          isWhitelist
            ? '锁机期间拦截除系统电话/短信/闹钟与下方已豁免应用外的全部第三方应用，新装游戏也自动拦截。'
            : '锁机期间仅拦截你手动勾选的受限应用，未勾选应用保持放行。'
        }
      </div>
      <div class="row" style="margin-top:10px;padding-bottom:${IS_NATIVE ? '12px' : '2px'};border-top:1px solid rgba(255,255,255,0.08);${IS_NATIVE ? '' : 'border-bottom:none;'}">
        <div>
          <div class="row-title">锁机防绕过保护</div>
          <div class="row-sub">锁机/试锁期拦截「系统设置」「手机管家」与卸载器，防强停或删权限（随时可关）</div>
        </div>
        ${renderSwitch(blockSettings, 'id="apps-block-settings-sw"', 'safe')}
      </div>
      ${
        IS_NATIVE
          ? `
            <div class="row" style="padding-bottom:2px;border-bottom:none;">
              <div>
                <div class="row-title">
                  防后台切换增强
                  <span class="tag ${d.permissions?.accessibilityGuard ? 'safe' : 'warn'}" style="margin-left:4px;">${d.permissions?.accessibilityGuard ? '已开启' : '推荐开启'}</span>
                </div>
                <div class="row-sub">通过无障碍 0ms 封堵后台多任务回弹、悬浮小窗与分屏（仅读包名，不读屏幕内容）</div>
              </div>
              ${renderSwitch(Boolean(d.permissions?.accessibilityGuard), 'id="apps-a11y-guard-sw"', 'safe')}
            </div>
          `
          : ''
      }
    </div>

    <div class="sec-head">
      <h2 class="sec-title">${IS_NATIVE ? '本机已安装应用' : '应用列表搜索'}</h2>
      <span class="sec-note">${IS_NATIVE ? '实时读取本机已装应用' : '演示目录'}</span>
    </div>
    <div class="app-search-wrap">
      <input id="apps-search-input" class="app-search-input" type="search" placeholder="搜索本机应用名称或包名..." value="${esc(appSearchQuery)}" autocomplete="off" />
      <button id="apps-search-clear" type="button" class="app-search-clear ${appSearchQuery ? '' : 'hidden'}" aria-label="清空搜索">×</button>
    </div>

    <div id="apps-list-container"></div>

    <div class="sec-head">
      <h2 class="sec-title">系统强制保护（不可限制）</h2>
    </div>
    <div class="group">
      ${mandatory
        .map(
          (a) => `
        <div class="row">
          <div class="row-left">
            ${renderAppGlyph(a.id, 32, night)}
            <div>
              <div class="row-title">${esc(a.name)}</div>
              <div class="row-sub">${esc(a.description)}</div>
            </div>
          </div>
          <span class="tag safe">${ICONS.shieldCheck(12)}<span>始终可用</span></span>
        </div>
      `
        )
        .join('')}
    </div>
  `;

  const listContainer = elMain.querySelector('#apps-list-container');
  renderAppsListInto(listContainer, d);

  elMain.querySelectorAll('[data-guard-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.guardMode;
      if (mode && mode !== guard.restrictionMode) {
        store.updateGuardOptions({ restrictionMode: mode });
      }
    });
  });

  elMain.querySelector('#apps-block-settings-sw')?.addEventListener('click', () => {
    store.updateGuardOptions({ blockSettingsDuringLock: !blockSettings });
  });

  elMain.querySelector('#apps-a11y-guard-sw')?.addEventListener('click', () => {
    if (night && blockSettings && !d.permissions?.accessibilityGuard) {
      store.showToast('锁机期请先临时关闭上方「锁机防绕过保护」，再前往系统无障碍开启');
      return;
    }
    store.updatePermissions({ accessibilityGuard: !d.permissions?.accessibilityGuard });
  });

  const searchInput = elMain.querySelector('#apps-search-input');
  const clearBtn = elMain.querySelector('#apps-search-clear');
  searchInput?.addEventListener('input', (e) => {
    appSearchQuery = e.target.value;
    clearBtn?.classList.toggle('hidden', !appSearchQuery);
    renderAppsListInto(listContainer, store.data);
  });
  clearBtn?.addEventListener('click', () => {
    appSearchQuery = '';
    if (searchInput) {
      searchInput.value = '';
      searchInput.focus();
    }
    clearBtn.classList.add('hidden');
    renderAppsListInto(listContainer, store.data);
  });
}

// ---------------- Tab 4：设备页 ----------------
function renderDeviceTab() {
  const d = store.data;
  const p = d.pairing;
  const perms = d.permissions;
  const guard = getGuardOptions(d);
  const isWhitelist = guard.restrictionMode === 'WHITELIST_ALL';
  const nowMs = store.getDisplayNowMs();
  const events = d.live?.events || [];

  elMain.innerHTML = `
    <h1 class="page-h1">设备与安全</h1>
    <p class="page-lead">
      ${
        p.status === 'PAIRED'
          ? d.lanConnected
            ? '已与宿舍电脑在局域网实时联通，可在线同步状态与发码。'
            : '当前未连入同一局域网。半夜急用仍可通过 6 位识别号在电脑完全离线算码。'
          : '尚未配对宿舍电脑，请先完成首次本地配对。'
      }
    </p>

    <div class="sec-head">
      <h2 class="sec-title">已配对宿舍电脑</h2>
      <span class="sec-note">${d.lanConnected ? '局域网在线' : '离线可用'}</span>
    </div>
    <div class="group group-pad">
      ${
        p.status === 'PAIRED'
          ? `
            <div class="row" style="padding-top:0;">
              <div class="row-left">
                <span class="app-glyph" style="width:36px;height:36px;border-radius:11px;background:${d.lanConnected ? 'var(--safe-soft)' : 'var(--accent-soft)'};color:${d.lanConnected ? 'var(--safe)' : 'var(--accent)'};">${ICONS.laptop(18)}</span>
                <div>
                  <div class="row-title">${esc(cleanName(p.desktopName))}</div>
                  <div class="row-sub mono">编号 ${esc(p.pairId)}</div>
                </div>
              </div>
              <span class="tag ${d.lanConnected ? 'safe' : 'warn'}">${d.lanConnected ? '在线' : '离线'}</span>
            </div>
            ${
              p.lostPcUnbindEffectiveAt
                ? `<div class="note-line warn" style="margin-top:10px;">${ICONS.clock(15)}<span>锁定中发起遗失电脑解绑，24 小时冷却剩余 <strong class="mono" data-dev-unbind-cd="1">${formatCountdown(p.lostPcUnbindEffectiveAt - nowMs)}</strong>（防一键绕过限制）。</span></div>`
                : ''
            }
            <div class="btn-row">
              <button id="btn-unbind-normal" type="button" class="btn sm subtle" style="flex:1">正常解除配对</button>
              <button id="btn-unbind-lost" type="button" class="btn sm danger-text" style="flex:1">遗失电脑解绑</button>
            </div>
          `
          : `
            <div class="field">
              <label for="dev-pair-input">输入电脑端显示的 8 位配对码</label>
              <input id="dev-pair-input" class="input pair-code-input" maxlength="8" placeholder="A8K3M9Q2" />
            </div>
            <div class="field" style="margin-top:10px;">
              <label for="dev-pair-host">电脑局域网地址（可选，搜不到电脑时填写）</label>
              <input id="dev-pair-host" class="input mono" autocomplete="off" placeholder="留空自动发现，如 192.168.43.128:4180" />
            </div>
            <div class="btn-row"><button id="dev-pair-btn" type="button" class="btn solid block">确认配对</button></div>
          `
      }
    </div>

    <div class="sec-head">
      <h2 class="sec-title">系统权限状态</h2>
      <span class="sec-note">${d.live.permissionsOk ? '全部核心就绪' : '存在缺失'}</span>
    </div>
    <div class="group">
      ${[
        ['usageStats', '使用情况访问', '识别当前前台应用'],
        ['overlay', '悬浮窗显示', '弹出夜间拦截层'],
        ['exactAlarm', '精确闹钟', '准点开始与自动恢复'],
        ['batteryIgnore', '忽略电池优化', '减少夜间后台中断'],
        ...(IS_NATIVE
          ? [['accessibilityGuard', '防后台切换增强（无障碍 · 推荐）', '0ms 封堵后台多任务切入与小窗/分屏，仅监测包名不读屏幕内容']]
          : []),
      ]
        .map(
          ([k, label, sub]) => `
        <div class="row">
          <div>
            <div class="row-title">${label}</div>
            <div class="row-sub">${sub}</div>
          </div>
          ${renderSwitch(Boolean(perms[k]), `data-dev-perm="${k}"`, 'safe')}
        </div>
      `
        )
        .join('')}
    </div>

    ${
      !d.live.permissionsOk
        ? `<div class="btn-row"><button id="dev-fix-all-perm" type="button" class="btn accent block">${ICONS.shieldCheck(15)}<span>一键修复缺失权限</span></button></div>`
        : ''
    }

    <div class="sec-head">
      <h2 class="sec-title">锁机防绕过与策略</h2>
      <span class="sec-note">随时可改</span>
    </div>
    <div class="group">
      <div class="row">
        <div>
          <div class="row-title">锁机防绕过保护</div>
          <div class="row-sub">锁机/试锁期拦截「系统设置」「手机管家」与卸载器，防止中途删权限或强停</div>
        </div>
        ${renderSwitch(guard.blockSettingsDuringLock, 'id="dev-block-settings-sw"', 'safe')}
      </div>
      <div class="row">
        <div>
          <div class="row-title">当前拦截模式：${isWhitelist ? '严格白名单' : '仅拦指定应用'}</div>
          <div class="row-sub">${isWhitelist ? '除系统必用与豁免白名单外全部拦截' : '仅拦截「应用」页中勾选的受限应用'}</div>
        </div>
        <button id="dev-toggle-mode" type="button" class="btn sm subtle">切换</button>
      </div>
    </div>

    <div class="sec-head"><h2 class="sec-title">演练与校验</h2></div>
    <div class="group group-pad">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
        <div>
          <div class="row-title">3 分钟白天试锁</div>
          <div class="row-sub">随时重新演练拦截页、门禁放行与电脑取码</div>
        </div>
        <button id="btn-restart-trial" type="button" class="btn sm subtle">${ICONS.flask(14)}<span>重测</span></button>
      </div>
    </div>

    <div class="sec-head" style="align-items:center;">
      <h2 class="sec-title">最近记录</h2>
      <div class="mini-tabs">
        <button type="button" data-log-mode="consumed" class="${deviceLogMode === 'consumed' ? 'active' : ''}">应急码 (${d.consumedRequests.length})</button>
        <button type="button" data-log-mode="events" class="${deviceLogMode === 'events' ? 'active' : ''}">状态日志 (${events.length})</button>
      </div>
    </div>

    <div class="group">
      ${
        deviceLogMode === 'consumed'
          ? d.consumedRequests.length === 0
            ? '<div class="row"><span class="row-sub">暂无已消费应急码记录</span></div>'
            : d.consumedRequests
                .slice(0, 8)
                .map(
                  (item) => `
              <div class="row">
                <div>
                  <div class="row-title"><span class="mono">${esc(item.requestId)}</span> · ${item.actionType === 'END_TONIGHT' ? '结束今晚' : esc(resolveMobileAppName(d, item.targetAppId))}</div>
                  <div class="row-sub">${formatDateTimeShort(item.consumedAt)} · ${item.mode === 'ONLINE' ? '局域网在线' : '离线校验'}</div>
                </div>
                <span class="tag">已失效</span>
              </div>
            `
                )
                .join('')
          : events.length === 0
            ? '<div class="row"><span class="row-sub">暂无状态记录</span></div>'
            : events
                .slice(0, 12)
                .map(
                  (ev) => `
              <div class="row">
                <div>
                  <div class="row-title" style="font-size:13px;font-weight:500;">${esc(ev.message)}</div>
                  <div class="row-sub mono">${formatDateTimeShort(ev.ts)}</div>
                </div>
              </div>
            `
                )
                .join('')
      }
    </div>
  `;

  const devPairInput = elMain.querySelector('#dev-pair-input');
  const devPairHost = elMain.querySelector('#dev-pair-host');
  const doDevPair = () => {
    const code = devPairInput?.value.trim();
    const host = devPairHost?.value.trim() || '';
    if (code) store.confirmPairing(code, host);
  };
  elMain.querySelector('#dev-pair-btn')?.addEventListener('click', doDevPair);
  devPairInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doDevPair();
  });
  devPairHost?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doDevPair();
  });
  elMain.querySelector('#btn-unbind-normal')?.addEventListener('click', () => store.unbindPairing(false));
  elMain.querySelector('#btn-unbind-lost')?.addEventListener('click', () => store.unbindPairing(true));
  elMain.querySelector('#dev-fix-all-perm')?.addEventListener('click', () => {
    store.updatePermissions({ usageStats: true, overlay: true, exactAlarm: true });
  });
  elMain.querySelector('#dev-block-settings-sw')?.addEventListener('click', () => {
    store.updateGuardOptions({ blockSettingsDuringLock: !guard.blockSettingsDuringLock });
  });
  elMain.querySelector('#dev-toggle-mode')?.addEventListener('click', () => {
    store.updateGuardOptions({
      restrictionMode: isWhitelist ? 'BLACKLIST_SELECTED' : 'WHITELIST_ALL',
    });
  });
  elMain.querySelector('#btn-restart-trial')?.addEventListener('click', () => store.startTrial());
  elMain.querySelectorAll('[data-dev-perm]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const k = btn.dataset.devPerm;
      if (k === 'accessibilityGuard' && isNightStatus(d.live.status) && guard.blockSettingsDuringLock && !perms[k]) {
        store.showToast('锁机期请先临时关闭下方「锁机防绕过保护」，再前往系统无障碍开启');
        return;
      }
      store.updatePermissions({ [k]: !perms[k] });
    });
  });
  elMain.querySelectorAll('[data-log-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      deviceLogMode = btn.dataset.logMode;
      renderDeviceTab();
    });
  });
}

// ---------------- 浏览器演示专用：模拟前台停留 App 画面（真机隐藏） ----------------
function renderForegroundView() {
  if (IS_NATIVE) {
    elFg.classList.add('hidden');
    elFg.innerHTML = '';
    return;
  }

  const d = store.data;
  const fgId = d?.foregroundAppId;
  if (!fgId) {
    elFg.classList.add('hidden');
    elFg.innerHTML = '';
    return;
  }

  const app = APP_MAP[fgId] || { name: fgId };
  const live = d.live;
  const nowMs = store.getDisplayNowMs();
  const isTempAllowed = live.tempAllow?.appId === fgId;
  const isEssential = app.category === 'MANDATORY' || live.effectiveExemptAppIds.includes(fgId);

  elFg.classList.remove('hidden');
  elFg.innerHTML = `
    <div class="fg-head">
      <div style="display:flex;align-items:center;gap:10px;">
        ${renderAppGlyph(fgId, 36, isNightStatus(live.status))}
        <div>
          <div class="row-title">${esc(app.name)}</div>
          <div class="row-sub">浏览器模拟前台停留中</div>
        </div>
      </div>
      <button id="fg-exit-btn" type="button" class="btn sm subtle">返回桌面</button>
    </div>
    <div class="fg-body">
      ${
        isTempAllowed
          ? `<div class="note-line safe" style="margin:0;">${ICONS.clock(15)}<span>临时放行至 ${formatTimeHM(live.tempAllow.expiresAt)}（剩 <strong class="mono" data-fg-cd="1">${formatCountdown(live.tempAllow.expiresAt - nowMs)}</strong>），到点立即拉回拦截页。</span></div>`
          : live.status === SESSION_STATES.PRE_LOCK_REMINDER
            ? `<div class="note-line warn" style="margin:0;">${ICONS.sunset(15)}<span>距夜间限制还有 <strong class="mono" data-fg-cd="1">${formatCountdown(live.startAt - nowMs)}</strong>，到点将自动覆盖此画面。</span></div>`
            : `<div class="note-line ${isEssential ? 'safe' : ''}" style="margin:0;">${isEssential ? ICONS.shieldCheck(15) : ICONS.smartphone(15)}<span>正常使用中${isEssential ? '（必要服务，夜间始终畅通）' : ''}</span></div>`
      }
      <div class="fg-card">
        <div class="row-title">当前停留在「${esc(app.name)}」</div>
        <div class="row-sub" style="margin-top:6px;">
          保持在此画面等待到点，或打开右下角「调试」快进至锁定开始 / 20 分钟到期时刻，即可体验无感自动拉起夜间拦截页。
        </div>
      </div>
    </div>
  `;
  elFg.querySelector('#fg-exit-btn')?.addEventListener('click', () => store.exitSimulatedApp());
}

// ---------------- 夜间低亮全屏拦截层与应急解锁 ----------------
function updateCodeSlotVisuals(val) {
  const slots = elOverlay.querySelectorAll('.code-slot');
  slots.forEach((slot, idx) => {
    const ch = val[idx] || '';
    slot.textContent = ch;
    slot.classList.toggle('filled', Boolean(ch));
    slot.classList.toggle('active', idx === Math.min(val.length, 5));
  });
}

function renderOverlayLayer() {
  const d = store.data;
  if (!d) return;
  const live = d.live;
  const show = Boolean(d.shouldShowOverlay || store.manualOverlayOpen);
  if (!show) {
    elOverlay.classList.add('hidden');
    return;
  }

  const nowMs = store.getDisplayNowMs();
  const remSessionMs = Math.max(0, live.endAt - nowMs);
  const req = live.activeRequest;
  const restrictedIds = Array.isArray(live.effectiveRestrictedAppIds) ? live.effectiveRestrictedAppIds : [];
  const restrictedApps = restrictedIds.map((id) => ({
    id,
    name: resolveMobileAppName(d, id),
  }));
  if (req?.targetAppId && !restrictedApps.some((a) => a.id === req.targetAppId)) {
    restrictedApps.unshift({
      id: req.targetAppId,
      name: resolveMobileAppName(d, req.targetAppId),
    });
  }
  const fgApp = d.foregroundAppId
    ? { id: d.foregroundAppId, name: resolveMobileAppName(d, d.foregroundAppId) }
    : null;
  const inCooldown = Boolean(live.cooldownUntil && nowMs < live.cooldownUntil);

  // 若存在校验错误或冷却提示，或真机从原生拦截页点击「输入电脑应急码」进入，自动展开应急解锁区
  const nativeOverlayKey = IS_NATIVE && d.shouldShowOverlay ? `${d.foregroundAppId || ''}:${req?.requestId || ''}` : '';
  if (nativeOverlayKey && nativeOverlayKey !== lastNativeOverlayKey) {
    lastNativeOverlayKey = nativeOverlayKey;
    overlayUnlockOpen = true;
  }
  if (store.emergencyError || inCooldown) {
    overlayUnlockOpen = true;
  }

  // 用户正在输入 6 位码且 requestId 未变化时，仅更新倒计时，绝不打断输入法焦点
  if (document.activeElement?.id === 'ov-code-input' && elOverlay.dataset.reqId === (req?.requestId || '')) {
    const cdEl = elOverlay.querySelector('#ov-session-cd');
    if (cdEl) cdEl.textContent = formatCountdown(remSessionMs);
    return;
  }

  elOverlay.dataset.reqId = req?.requestId || '';
  elOverlay.classList.remove('hidden');

  const curVal = store.emergencyInput || '';

  elOverlay.innerHTML = `
    <div>
      <div class="ov-top">
        <span class="ov-badge">${ICONS.moon(13)}<span>${live.activeMode === 'TRIAL' ? '白天试锁中' : '熄灯守夜中'}</span></span>
        <button id="ov-close-btn" type="button" class="ov-back-btn">返回桌面</button>
      </div>

      <div class="ov-center">
        <div id="ov-clock-now" class="ov-clock">${formatTimeHM(nowMs)}</div>
        <div class="ov-until">距 ${formatTimeHM(live.endAt)} 自动恢复还有 <strong id="ov-session-cd" class="mono">${formatCountdown(remSessionMs)}</strong></div>
        ${
          fgApp
            ? `<div class="ov-paused-pill">${renderAppGlyph(fgApp.id, 20, true)}<span>已暂停「${esc(fgApp.name)}」</span></div>`
            : ''
        }
        ${
          live.tempAllow
            ? `<div class="ov-allow-note">当前仅放行 ${esc(resolveMobileAppName(d, live.tempAllow.appId))} 至 ${formatTimeHM(live.tempAllow.expiresAt)}</div>`
            : ''
        }
      </div>

      <div class="ov-ess-label">必要功能始终畅通 · 一键直达</div>
      <div class="ov-essentials">
        <button type="button" class="ov-ess-btn" data-quick-safe="com.android.dialer">
          <span class="ov-ess-ico">${ICONS.phone(18)}</span>
          <span>紧急拨号</span>
        </button>
        <button type="button" class="ov-ess-btn" data-quick-safe="com.android.deskclock">
          <span class="ov-ess-ico">${ICONS.alarm(18)}</span>
          <span>系统闹钟</span>
        </button>
        <button type="button" class="ov-ess-btn" data-quick-safe="edu.campus.card">
          <span class="ov-ess-ico">${ICONS.idCard(18)}</span>
          <span>校园门禁</span>
        </button>
      </div>
    </div>

    <div>
      <button id="ov-toggle-unlock" class="ov-unlock-trigger" type="button">
        <span style="display:inline-flex;align-items:center;gap:8px;">${ICONS.key(15)}<span>急事提前使用 · 输入电脑应急码</span></span>
        <span style="font-size:12px;color:#9DA1AD;">${overlayUnlockOpen ? '收起' : '展开 ›'}</span>
      </button>

      ${
        overlayUnlockOpen && req
          ? `
            <div class="ov-drawer">
              <div class="seg-dark">
                <button id="ov-act-temp" type="button" class="${req.actionType === EMERGENCY_ACTIONS.TEMP_ALLOW_15M ? 'active' : ''}">放行 20 分钟</button>
                <button id="ov-act-end" type="button" class="${req.actionType === EMERGENCY_ACTIONS.END_TONIGHT ? 'active-danger' : ''}">${live.activeMode === 'TRIAL' ? '结束试锁' : '结束今晚限制'}</button>
              </div>

              ${
                req.actionType === EMERGENCY_ACTIONS.TEMP_ALLOW_15M
                  ? `
                    <div style="margin-top:10px;">
                      <select id="ov-target-select" class="select" aria-label="选择放行应用">
                        ${restrictedApps
                          .map((a) => `<option value="${a.id}" ${a.id === req.targetAppId ? 'selected' : ''}>仅放行：${esc(a.name)}（切换即作废旧码）</option>`)
                          .join('')}
                      </select>
                    </div>
                  `
                  : ''
              }

              <div class="req-plate">
                <div>
                  <div style="font-size:11px;color:#888B96;">识别号 · <span class="mono">${esc(req.sessionId)}</span></div>
                  <div class="req-code">${esc(req.requestId)}</div>
                </div>
                <span class="req-sync-pill ${d.lanConnected ? 'online' : ''}">${d.lanConnected ? '电脑已同步' : '离线输至电脑'}</span>
              </div>

              <div class="code-slots-wrap">
                <div class="code-slots-visual">
                  ${[0, 1, 2, 3, 4, 5].map(() => '<div class="code-slot"></div>').join('')}
                </div>
                <input id="ov-code-input" class="code-real-input" inputmode="numeric" maxlength="6" autocomplete="one-time-code" aria-label="输入 6 位应急码" value="${esc(curVal)}" ${inCooldown ? 'disabled' : ''} />
              </div>

              <div id="ov-cooldown-note" style="font-size:11.5px;color:#FDBA74;margin-top:7px;min-height:16px;">
                ${
                  inCooldown
                    ? `连续输错冷却中，请等待 ${formatCountdown(live.cooldownUntil - nowMs)}`
                    : live.wrongAttempts > 0
                      ? `已输错 ${live.wrongAttempts} 次，请核对电脑端 6 位数字`
                      : '输入电脑端生成的 6 位应急码'
                }
              </div>
              ${store.emergencyError ? `<div style="font-size:12px;color:#FDA4AF;margin-top:4px;line-height:1.45;">${esc(store.emergencyError)}</div>` : ''}

              <div class="btn-row" style="margin-top:10px;">
                <button id="ov-verify-btn" type="button" class="btn accent block" ${inCooldown ? 'disabled' : ''}>验证并解锁</button>
              </div>
            </div>
          `
          : ''
      }
    </div>
  `;

  if (overlayUnlockOpen) updateCodeSlotVisuals(curVal);

  elOverlay.querySelector('#ov-close-btn')?.addEventListener('click', () => store.exitSimulatedApp());
  elOverlay.querySelector('#ov-toggle-unlock')?.addEventListener('click', () => {
    overlayUnlockOpen = !overlayUnlockOpen;
    renderOverlayLayer();
  });
  elOverlay.querySelectorAll('[data-quick-safe]').forEach((btn) => {
    btn.addEventListener('click', () => {
      store.manualOverlayOpen = false;
      store.openSimulatedApp(btn.dataset.quickSafe);
    });
  });

  elOverlay.querySelector('#ov-act-temp')?.addEventListener('click', () => {
    const fallbackApp = req?.targetAppId || restrictedApps[0]?.id || 'tv.danmaku.bili';
    store.switchEmergencyRequest(EMERGENCY_ACTIONS.TEMP_ALLOW_15M, fallbackApp);
  });
  elOverlay.querySelector('#ov-act-end')?.addEventListener('click', () => {
    store.switchEmergencyRequest(EMERGENCY_ACTIONS.END_TONIGHT, null);
  });
  elOverlay.querySelector('#ov-target-select')?.addEventListener('change', (e) => {
    store.switchEmergencyRequest(EMERGENCY_ACTIONS.TEMP_ALLOW_15M, e.target.value);
  });

  const codeInput = elOverlay.querySelector('#ov-code-input');
  codeInput?.addEventListener('input', (e) => {
    store.emergencyInput = e.target.value.replace(/\D/g, '').slice(0, 6);
    e.target.value = store.emergencyInput;
    updateCodeSlotVisuals(store.emergencyInput);
  });
  codeInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') store.submitEmergencyCode(store.emergencyInput);
  });
  elOverlay.querySelector('#ov-verify-btn')?.addEventListener('click', () => {
    store.submitEmergencyCode(store.emergencyInput);
  });
}

// ---------------- 解锁后平静反馈弹窗 ----------------
function renderFeedbackModal() {
  const fb = store.feedback;
  if (!fb) {
    elFeedback.classList.add('hidden');
    elFeedback.innerHTML = '';
    return;
  }

  const isTemp = fb.actionType === EMERGENCY_ACTIONS.TEMP_ALLOW_15M;
  const targetName = resolveMobileAppName(store.data, fb.targetAppId);

  elFeedback.classList.remove('hidden');
  elFeedback.innerHTML = `
    <div class="modal-card">
      <div class="state-orb" style="margin:0 0 12px;width:44px;height:44px;border-radius:14px;">${ICONS.check(22)}</div>
      <div class="row-title" style="font-size:18px;font-weight:800;">
        ${isTemp ? `已放行「${esc(targetName)}」${TEMP_ALLOW_MINUTES} 分钟` : '今晚限制已提前结束'}
      </div>
      <p class="row-sub" style="margin:8px 0 0;font-size:13px;line-height:1.65;color:var(--ink-2);">
        ${
          isTemp
            ? `将于 <strong class="mono">${formatTimeHM(fb.expiresAt)}</strong> 自动恢复拦截，其余受限娱乐应用保持拦截。本次旧码 <span class="mono">${esc(fb.consumedRequestId)}</span> 已作废。`
            : `全部应用已恢复正常，明晚 <strong class="mono">${formatDateTimeShort(fb.nextRegularResumeAt)}</strong> 将照常开启。本次旧码 <span class="mono">${esc(fb.consumedRequestId)}</span> 已作废。`
        }
      </p>
      <div class="btn-row" style="margin-top:18px;">
        <button id="fb-ok" type="button" class="btn solid" style="flex:1">知道了</button>
        <button id="fb-relock" type="button" class="btn subtle">办完急事，重新锁定</button>
      </div>
    </div>
  `;
  elFeedback.querySelector('#fb-ok')?.addEventListener('click', () => store.clearFeedback());
  elFeedback.querySelector('#fb-relock')?.addEventListener('click', () => store.relockEarly());
}

// ---------------- 浏览器演示调试面板（真机 WebView 自动跳过） ----------------
function renderDevPanel() {
  if (IS_NATIVE) return;
  const d = store.data;
  const sim = store.sim;
  if (!d || !sim) return;

  elDevPanel.innerHTML = `
    <div class="dev-label">演示快捷</div>
    <div class="dev-row">
      <button type="button" class="btn solid" data-sim="one-min">设 1 分钟后开始</button>
      <button type="button" class="btn" data-sim="jump-before-5s">开始前 5 秒</button>
      <button type="button" class="btn" data-sim="jump-start">跳到锁定开始</button>
      <button type="button" class="btn" data-sim="jump-0100">跳到 01:00</button>
      <button type="button" class="btn" data-sim="jump-allow-5s">放行到期前 5 秒</button>
      <button type="button" class="btn" data-sim="jump-end">跳到自然结束</button>
    </div>

    <div class="dev-label">时间微调（${formatDateTimeShort(store.getDisplayNowMs())}）</div>
    <div class="dev-row">
      <button type="button" class="btn" data-delta="60">+1分</button>
      <button type="button" class="btn" data-delta="600">+10分</button>
      <button type="button" class="btn" data-delta="1200">+20分</button>
      <button type="button" class="btn" data-sim="reset-clock">真实时间</button>
    </div>

    <div class="dev-label">环境与故障</div>
    <div class="dev-row">
      <button type="button" class="btn" data-sim="toggle-pc">电脑：${sim.pcPoweredOn ? '开' : '关'}</button>
      <button type="button" class="btn" data-sim="toggle-lan">局域网：${sim.lanConnected ? '通' : '断'}</button>
      <button type="button" class="btn" data-sim="toggle-perm">权限：${d.live.permissionsOk ? '正常' : '撤销'}</button>
      <button type="button" class="btn" data-sim="stay-bili">停留哔哩哔哩</button>
      <button type="button" class="btn" data-sim="reboot">重启手机(${sim.mobileRebootCount})</button>
      <button type="button" class="btn" data-sim="reset-autopair">重置预配对</button>
      <button type="button" class="btn danger-text" data-sim="reset-fresh">首次安装态</button>
    </div>
  `;

  elDevPanel.querySelectorAll('[data-delta]').forEach((btn) => {
    btn.addEventListener('click', () => mobileSystemAdapter.devSim.adjustTime('DELTA', Number(btn.dataset.delta)));
  });
  elDevPanel.querySelectorAll('[data-sim]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const act = btn.dataset.sim;
      if (act === 'one-min') {
        await mobileSystemAdapter.devSim.startInOneMinute(30);
        store.showToast('已设为 1 分钟后开始锁定');
      } else if (act === 'jump-before-5s') await mobileSystemAdapter.devSim.adjustTime('JUMP_BEFORE_LOCK_5S');
      else if (act === 'jump-start') await mobileSystemAdapter.devSim.adjustTime('JUMP_LOCK_START');
      else if (act === 'jump-0100') await mobileSystemAdapter.devSim.adjustTime('JUMP_NIGHT_0100');
      else if (act === 'jump-allow-5s') await mobileSystemAdapter.devSim.adjustTime('JUMP_ALLOW_END_MINUS_5S');
      else if (act === 'jump-end') await mobileSystemAdapter.devSim.adjustTime('JUMP_NATURAL_END');
      else if (act === 'reset-clock') await mobileSystemAdapter.devSim.adjustTime('RESET_REAL');
      else if (act === 'toggle-pc') await mobileSystemAdapter.devSim.setNetwork({ pcPoweredOn: !sim.pcPoweredOn });
      else if (act === 'toggle-lan') await mobileSystemAdapter.devSim.setNetwork({ lanConnected: !sim.lanConnected });
      else if (act === 'toggle-perm') {
        const nextOk = !d.live.permissionsOk;
        await store.updatePermissions({ usageStats: nextOk, overlay: nextOk, exactAlarm: nextOk });
      } else if (act === 'stay-bili') await store.openSimulatedApp('tv.danmaku.bili');
      else if (act === 'reboot') {
        const res = await mobileSystemAdapter.devSim.rebootMobile();
        store.showToast(`重启恢复成功（${res.status}）`);
      } else if (act === 'reset-autopair') {
        await mobileSystemAdapter.devSim.resetAll({ autoPair: true });
        store.setTab('home');
      } else if (act === 'reset-fresh') {
        await mobileSystemAdapter.devSim.resetAll({ autoPair: false });
        store.setOnboardingStep(1);
      }
      await store.refresh();
    });
  });
}

// ---------------- 全量渲染与每秒平滑读数更新 ----------------
const PROTECTED_INPUT_IDS = new Set([
  'ob-pair-code',
  'ob-pair-host',
  'dev-pair-input',
  'dev-pair-host',
  'apps-search-input',
  'tonight-start',
  'tonight-end',
  'sch-school-s',
  'sch-school-e',
  'sch-wk-s',
  'sch-wk-e',
]);

function renderAll() {
  if (!store.data) return;
  renderStatusBarAndNotif();

  const activeId = document.activeElement?.id || '';
  const skipMainReplace = PROTECTED_INPUT_IDS.has(activeId);

  if (!skipMainReplace) {
    if (!store.data.onboarding.completed) {
      renderOnboarding();
    } else {
      elNav.classList.remove('hidden');
      elMain.classList.remove('no-nav');
      elNav.querySelectorAll('button[data-tab]').forEach((b) => {
        b.classList.toggle('active', b.dataset.tab === store.activeTab);
      });
      if (store.activeTab === 'home') renderHomeTab();
      else if (store.activeTab === 'schedule') renderScheduleTab();
      else if (store.activeTab === 'apps') renderAppsTab();
      else if (store.activeTab === 'device') renderDeviceTab();
    }
  }

  renderForegroundView();
  renderOverlayLayer();
  renderFeedbackModal();
  renderDevPanel();

  if (store.toastText) {
    elToast.textContent = store.toastText;
    elToast.classList.remove('hidden');
  } else {
    elToast.classList.add('hidden');
  }
}

function renderClockTickOnly() {
  if (!store.data) return;
  renderStatusBarAndNotif();
  const nowMs = store.getDisplayNowMs();
  const live = store.data.live;

  // 夜间拦截层时钟与倒计时
  const ovClock = elOverlay.querySelector('#ov-clock-now');
  if (ovClock) ovClock.textContent = formatTimeHM(nowMs);
  const cdEl = elOverlay.querySelector('#ov-session-cd');
  if (cdEl && live?.endAt) cdEl.textContent = formatCountdown(Math.max(0, live.endAt - nowMs));
  const ovCool = elOverlay.querySelector('#ov-cooldown-note');
  if (ovCool && live.cooldownUntil && nowMs < live.cooldownUntil) {
    ovCool.textContent = `连续输错冷却中，请等待 ${formatCountdown(live.cooldownUntil - nowMs)}`;
  }

  // 模拟前台倒计时
  const fgCd = elFg.querySelector('[data-fg-cd]');
  if (fgCd) {
    if (live.tempAllow) fgCd.textContent = formatCountdown(Math.max(0, live.tempAllow.expiresAt - nowMs));
    else if (live.status === SESSION_STATES.PRE_LOCK_REMINDER) fgCd.textContent = formatCountdown(Math.max(0, live.startAt - nowMs));
  }

  // 设备页遗失解绑冷却倒计时
  const unbindCd = elMain.querySelector('[data-dev-unbind-cd]');
  if (unbindCd && store.data.pairing?.lostPcUnbindEffectiveAt) {
    unbindCd.textContent = formatCountdown(Math.max(0, store.data.pairing.lostPcUnbindEffectiveAt - nowMs));
  }

  // 首页表盘 / 15 分钟环平滑读数更新
  const startCd = elMain.querySelector('[data-home-start-cd]');
  if (startCd && live?.startAt) {
    startCd.textContent = formatCountdown(Math.max(0, live.startAt - nowMs));
  }

  const dialMain = elMain.querySelector('[data-dial-main]');
  if (dialMain && store.activeTab === 'home' && store.data.onboarding.completed) {
    if (live.tempAllow) {
      const rem = Math.max(0, live.tempAllow.expiresAt - nowMs);
      dialMain.textContent = formatDialCountdown(rem);
      const ring = elMain.querySelector('[data-allow-ring]');
      if (ring) {
        const total = Math.max(1, live.tempAllow.expiresAt - live.tempAllow.startedAt);
        const r = Number(ring.dataset.allowR || 92);
        const circ = 2 * Math.PI * r;
        ring.setAttribute('stroke-dashoffset', (circ * (1 - Math.max(0, Math.min(1, rem / total)))).toFixed(2));
        ring.setAttribute('stroke', rem <= 60 * 1000 ? 'url(#allow-warn)' : 'url(#allow-cyan)');
      }
    } else if (live.status === SESSION_STATES.LOCKED || live.status === SESSION_STATES.TRIAL_LOCKED) {
      dialMain.textContent = formatDialCountdown(Math.max(0, live.endAt - nowMs));
    } else if (live.status === SESSION_STATES.PRE_LOCK_REMINDER) {
      dialMain.textContent = formatDialCountdown(Math.max(0, live.startAt - nowMs));
    }
  }
}

store.subscribe(renderAll);
store.subscribeTick(renderClockTickOnly);
store.init();
