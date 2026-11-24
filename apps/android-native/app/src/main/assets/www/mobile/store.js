// Android 手机端业务状态层（与界面渲染和系统适配层严格解耦）

import { mobileSystemAdapter } from '../../adapters/mobileSystemAdapter.js';
import { ERROR_MESSAGES } from '../../shared/constants.js';

export class MobileStore {
  constructor() {
    this.data = null;
    this.sim = null;
    this.serverNowMs = Date.now();
    this.lastSyncLocalMs = Date.now();
    this.activeTab = 'home';
    this.onboardingStep = 1;
    this.manualOverlayOpen = false;
    this.emergencyInput = '';
    this.emergencyError = '';
    this.feedback = null; // 解锁后的平静反馈弹窗数据
    this.localGuardOptions = {
      restrictionMode: 'WHITELIST_ALL',
      blockSettingsDuringLock: true,
    };
    this.toastTimer = null;
    this.toastText = '';
    this.listeners = new Set();
    this.tickListeners = new Set();
    this.unsubEvents = null;
    this.clockTimer = null;
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
    this.unsubEvents = mobileSystemAdapter.subscribe(() => {
      this.refresh();
    });
    this.clockTimer = setInterval(() => {
      this.emitTick();
    }, 1000);
  }

  async refresh() {
    try {
      const resp = await mobileSystemAdapter.fetchState();
      this.serverNowMs = resp.nowMs;
      this.lastSyncLocalMs = Date.now();
      this.sim = resp.sim;
      this.data = resp.mobile;

      // 若已退出锁定且非试锁，自动关闭手动打开的拦截页
      const st = this.data?.live?.status;
      if (!['LOCKED', 'TEMP_ALLOW', 'TRIAL_LOCKED'].includes(st)) {
        this.manualOverlayOpen = false;
      }
      this.emit();
    } catch (err) {
      this.showToast(`连接共享模拟服务失败：${err.message}`);
    }
  }

  setTab(tab) {
    this.activeTab = tab;
    this.emit();
  }

  setOnboardingStep(step) {
    this.onboardingStep = step;
    this.emit();
  }

  openManualOverlay() {
    this.manualOverlayOpen = true;
    this.emergencyError = '';
    this.emit();
  }

  closeManualOverlay() {
    this.manualOverlayOpen = false;
    this.emergencyError = '';
    this.emit();
  }

  clearFeedback() {
    this.feedback = null;
    this.emit();
  }

  async confirmPairing(pairCode, companionAddress = '') {
    const res = await mobileSystemAdapter.confirmPairing(pairCode, companionAddress);
    if (!res.ok) {
      this.showToast(ERROR_MESSAGES[res.errorCode] || '配对失败');
      return res;
    }
    this.showToast('已成功与宿舍电脑配对');
    await this.refresh();
    return res;
  }

  async unbindPairing(lostPc = false) {
    const res = await mobileSystemAdapter.unbindPairing({ lostPc });
    if (res.ok && res.deferred) {
      this.showToast('锁定期间发起遗失解绑，已进入 24 小时冷却期');
    } else if (res.ok) {
      this.showToast('已解除电脑配对');
    }
    await this.refresh();
    return res;
  }

  async completeOnboarding(morningChecklistConfirmed = true) {
    await mobileSystemAdapter.completeOnboarding(morningChecklistConfirmed);
    this.showToast('首次配置完成');
    await this.refresh();
  }

  async updateSchedule(payload) {
    const res = await mobileSystemAdapter.updateSchedule(payload);
    if (res.ok) {
      this.showToast(
        res.deferredToNextNight
          ? '已过今晚截止时间，常规计划修改已保存并将于下一晚生效'
          : '常规就寝计划已保存'
      );
    }
    await this.refresh();
    return res;
  }

  async applyTonightOverride(payload) {
    const res = await mobileSystemAdapter.applyTonightOverride(payload);
    if (!res.ok) {
      this.showToast(ERROR_MESSAGES[res.errorCode] || '修改失败');
      return res;
    }
    this.showToast(
      payload.mode === 'PAUSE_TONIGHT'
        ? '已暂停今晚一次，明晚自动恢复常规计划'
        : payload.mode === 'CLEAR'
          ? '已恢复今晚常规计划'
          : '「仅改今晚」已生效，次日晚自动恢复原计划'
    );
    await this.refresh();
    return res;
  }

  async updateApps(restrictedAppIds, exemptAppIds) {
    const res = await mobileSystemAdapter.updateAppLists({ restrictedAppIds, exemptAppIds });
    if (res.ok) {
      this.showToast(
        res.deferredToNextNight
          ? '当前处于冻结期，放宽调整已保存并将于下一晚生效'
          : '应用限制名单已更新'
      );
    }
    await this.refresh();
    return res;
  }

  async updateGuardOptions(patch) {
    this.localGuardOptions = { ...this.localGuardOptions, ...patch };
    const res = await mobileSystemAdapter.updateGuardOptions(patch);
    if (res.ok) {
      if (patch.restrictionMode) {
        this.showToast(
          patch.restrictionMode === 'WHITELIST_ALL'
            ? '已切换为严格白名单模式（除必用与豁免外全拦截）'
            : '已切换为仅拦指定应用模式'
        );
      } else if (patch.blockSettingsDuringLock !== undefined) {
        this.showToast(
          patch.blockSettingsDuringLock
            ? '已开启锁机期防绕过保护（拦截系统设置与强停）'
            : '已关闭锁机期系统设置保护'
        );
      }
    }
    await this.refresh();
    return res;
  }

  async updatePermissions(patch) {
    await mobileSystemAdapter.updatePermissions(patch);
    await this.refresh();
  }

  async startTrial() {
    await mobileSystemAdapter.startDaytimeTrial();
    this.activeTab = 'home';
    this.showToast('已开启 3 分钟白天试锁，可试打开娱乐应用或校园码');
    await this.refresh();
  }

  async skipTrial() {
    await mobileSystemAdapter.skipDaytimeTrial();
    this.activeTab = 'home';
    this.showToast('已跳过白天试锁，今晚将按计划生效');
    await this.refresh();
  }

  async openSimulatedApp(appId) {
    const res = await mobileSystemAdapter.setForegroundApp(appId);
    await this.refresh();
    // 若用户点击的是受限应用且当前被拦，自动准备以该应用为默认目标的应急请求（仅在未切换时保持）
    if (this.data?.shouldShowOverlay) {
      const curReq = this.data?.live?.activeRequest;
      if (!curReq || (curReq.actionType === 'TEMP_ALLOW_15M' && curReq.targetAppId !== appId)) {
        await mobileSystemAdapter.prepareEmergencyRequest({
          actionType: 'TEMP_ALLOW_15M',
          targetAppId: appId,
        });
        await this.refresh();
      }
    }
    return res;
  }

  async exitSimulatedApp() {
    await mobileSystemAdapter.setForegroundApp(null);
    this.manualOverlayOpen = false;
    await this.refresh();
  }

  async switchEmergencyRequest(actionType, targetAppId) {
    const res = await mobileSystemAdapter.prepareEmergencyRequest({ actionType, targetAppId });
    this.emergencyInput = '';
    this.emergencyError = '';
    if (res.ok && res.rotated) {
      this.showToast(`已切换请求，旧码已作废，新识别号：${res.request.requestId}`);
    }
    await this.refresh();
    return res;
  }

  async submitEmergencyCode(code) {
    const res = await mobileSystemAdapter.verifyEmergencyCode(code);
    if (!res.ok) {
      this.emergencyError = ERROR_MESSAGES[res.errorCode] || '校验失败，请重试';
      await this.refresh();
      return res;
    }
    this.emergencyInput = '';
    this.emergencyError = '';
    this.manualOverlayOpen = false;
    this.feedback = res;
    await this.refresh();
    return res;
  }

  async relockEarly() {
    await mobileSystemAdapter.relockEarly();
    this.feedback = null;
    this.showToast('已立即恢复夜间限制');
    await this.refresh();
  }
}
