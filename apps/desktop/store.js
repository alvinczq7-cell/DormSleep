// Windows 电脑端业务状态层（与渲染层和 desktopSystemAdapter 解耦）

import { desktopSystemAdapter } from '../../adapters/desktopSystemAdapter.js';
import { EMERGENCY_ACTIONS, ERROR_MESSAGES } from '../../shared/constants.js';
import { inferCurrentSessionId } from '../../shared/scheduleEngine.js';

export class DesktopStore {
  constructor() {
    this.data = null;
    this.sim = null;
    this.serviceMode = 'MOCK';
    this.secretStorageBackend = 'MOCK';
    this.lanIps = [];
    this.httpPort = 4180;
    this.udpPort = 41740;
    this.serverNowMs = Date.now();
    this.lastSyncLocalMs = Date.now();
    this.listeners = new Set();
    this.tickListeners = new Set();

    // 在线签发选择的临时状态
    this.selectedOnlineAppId = null;

    // 离线取码表单与结果（完全本机计算，不依赖网络）
    this.offlineModeManual = false;
    this.offlineForm = {
      sessionId: '',
      requestId: '',
      actionType: EMERGENCY_ACTIONS.TEMP_ALLOW_15M,
      targetAppId: 'tv.danmaku.bili',
    };
    this.offlineResult = null;

    // 结束今晚限制确认弹窗（无 3 秒等待，点击确认即出码）
    this.endTonightConfirmTarget = null; // 'ONLINE' | 'OFFLINE' | null

    this.toastText = '';
    this.toastTimer = null;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  subscribeTick(fn) {
    this.tickListeners.add(fn);
    return () => this.tickListeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn(this);
  }

  emitTick() {
    for (const fn of this.tickListeners) fn(this);
  }

  getDisplayNowMs() {
    return this.serverNowMs + (Date.now() - this.lastSyncLocalMs);
  }

  showToast(text) {
    this.toastText = text;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastText = '';
      this.emit();
    }, 3200);
    this.emit();
  }

  async init() {
    await this.refresh();
    desktopSystemAdapter.subscribe(() => this.refresh());
    setInterval(() => this.emitTick(), 1000);
  }

  async refresh() {
    try {
      const resp = await desktopSystemAdapter.fetchState();
      this.serverNowMs = resp.nowMs;
      this.lastSyncLocalMs = Date.now();
      this.serviceMode = resp.serviceMode || 'MOCK';
      this.secretStorageBackend = resp.secretStorageBackend || 'MOCK';
      this.lanIps = Array.isArray(resp.lanIps) ? resp.lanIps : [];
      this.httpPort = resp.httpPort || 4180;
      this.udpPort = resp.udpPort || 41740;
      this.sim = resp.sim;
      this.data = resp.desktop;

      if (!this.offlineForm.sessionId) {
        this.offlineForm.sessionId = inferCurrentSessionId(this.serverNowMs);
      }
      const req = this.data?.snapshot?.activeRequest;
      if (this.data?.connected && req?.targetAppId) {
        this.selectedOnlineAppId = req.targetAppId;
      } else if (!this.selectedOnlineAppId) {
        this.selectedOnlineAppId = this.data?.knownRestrictedAppIds?.[0] || 'tv.danmaku.bili';
      }
      this.emit();
    } catch (err) {
      this.showToast(`连接本地伴随服务失败：${err.message}`);
    }
  }

  async startPairing() {
    const res = await desktopSystemAdapter.startPairing();
    if (res.ok) {
      this.showToast(`已生成 8 位配对码：${res.pairCode}（3 分钟有效）`);
    }
    await this.refresh();
    return res;
  }

  async unbindPairing() {
    await desktopSystemAdapter.unbindPairing();
    this.offlineResult = null;
    this.showToast('已解除配对');
    await this.refresh();
  }

  async issueOnlineCode(actionType, targetAppId) {
    const res = await desktopSystemAdapter.issueOnlineEmergencyCode({ actionType, targetAppId });
    if (!res.ok) {
      this.showToast(ERROR_MESSAGES[res.errorCode] || '生成应急码失败');
      return res;
    }
    this.showToast('已立即生成并显示本次 6 位应急码（无等待）');
    await this.refresh();
    return res;
  }

  async computeOfflineCode() {
    const p = this.data?.pairing;
    if (!p || p.status !== 'PAIRED' || (!p.offlineSharedSecret && !p.serverSideOfflineCalc)) {
      this.showToast('请先完成与手机的首次配对');
      return null;
    }
    const reqId = this.offlineForm.requestId.trim().toUpperCase();
    if (!reqId) {
      this.showToast('请输入手机上显示的请求识别号（如 K7M4-92）');
      return null;
    }
    const sessionId = this.offlineForm.sessionId.trim() || inferCurrentSessionId(this.getDisplayNowMs());
    const actionType = this.offlineForm.actionType;
    const targetAppId = actionType === EMERGENCY_ACTIONS.END_TONIGHT ? null : this.offlineForm.targetAppId;

    const code = await desktopSystemAdapter.deriveOfflineEmergencyCodeLocal({
      sharedSecret: p.offlineSharedSecret,
      pairId: p.pairId,
      sessionId,
      requestId: reqId,
      actionType,
      targetAppId,
      useServerSideCalc: Boolean(p.serverSideOfflineCalc),
    });

    this.offlineResult = {
      code,
      sessionId,
      requestId: reqId,
      actionType,
      targetAppId,
      computedAt: this.getDisplayNowMs(),
    };
    this.showToast('已通过本机标准 HMAC-SHA256 立即算出离线应急码');
    this.emit();
    return this.offlineResult;
  }
}
