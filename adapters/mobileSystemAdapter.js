// Android 手机端系统能力适配层
// 自动识别运行环境：
// - 在真实 Android WebView 外壳内：自动路由到 window.DormSleepNative (Kotlin MobileJsBridge)
// - 在桌面浏览器演示模式：对接共享本地模拟服务 (mock-bridge/server.py)

import { API_ENDPOINTS } from '../shared/protocol.js';
import { apiGet, apiPost, subscribeEvents } from './mockHttpClient.js';

function getNativeBridge() {
  return typeof window !== 'undefined' && window.DormSleepNative ? window.DormSleepNative : null;
}

function callNative(method, payload = {}) {
  const bridge = getNativeBridge();
  const raw = bridge.invoke(method, JSON.stringify(payload));
  return JSON.parse(raw);
}

export const mobileSystemAdapter = {
  isNativeAndroid() {
    return Boolean(getNativeBridge());
  },

  async fetchState() {
    if (getNativeBridge()) return callNative('getState');
    return apiGet(`${API_ENDPOINTS.STATE}?client=mobile`);
  },
  subscribe(onUpdate) {
    if (getNativeBridge()) {
      const handler = (ev) => onUpdate(ev.detail || { type: 'native_state' });
      window.addEventListener('dormsleep:native-state', handler);
      return () => window.removeEventListener('dormsleep:native-state', handler);
    }
    return subscribeEvents(onUpdate);
  },

  async confirmPairing(pairCode, companionAddress = '') {
    if (getNativeBridge()) return callNative('confirmPairing', { pairCode, companionAddress });
    return apiPost(API_ENDPOINTS.PAIR_CONFIRM, { pairCode });
  },
  async unbindPairing({ lostPc = false } = {}) {
    if (getNativeBridge()) return callNative('unbindPairing', { lostPc });
    return apiPost(API_ENDPOINTS.PAIR_UNBIND, { lostPc });
  },
  async completeOnboarding(morningChecklistConfirmed = true) {
    if (getNativeBridge()) return callNative('completeOnboarding', { morningChecklistConfirmed });
    return apiPost(API_ENDPOINTS.ONBOARDING_COMPLETE, { morningChecklistConfirmed });
  },

  async updateSchedule({ schoolNight, weekendNight, preReminderMinutes }) {
    const payload = { schoolNight, weekendNight, preReminderMinutes };
    if (getNativeBridge()) return callNative('updateSchedule', payload);
    return apiPost(API_ENDPOINTS.SCHEDULE_UPDATE, payload);
  },
  async applyTonightOverride({ mode, start, end }) {
    const payload = { mode, start, end };
    if (getNativeBridge()) return callNative('applyTonightOverride', payload);
    return apiPost(API_ENDPOINTS.TONIGHT_OVERRIDE, payload);
  },
  async startDaytimeTrial() {
    if (getNativeBridge()) return callNative('startDaytimeTrial');
    return apiPost(API_ENDPOINTS.TRIAL_START);
  },
  async skipDaytimeTrial() {
    if (getNativeBridge()) return callNative('skipDaytimeTrial');
    return apiPost(API_ENDPOINTS.TRIAL_SKIP);
  },

  async updateAppLists({ restrictedAppIds, exemptAppIds }) {
    const payload = { restrictedAppIds, exemptAppIds };
    if (getNativeBridge()) return callNative('updateAppLists', payload);
    return apiPost(API_ENDPOINTS.APPS_UPDATE, payload);
  },
  async updateGuardOptions({ restrictionMode, blockSettingsDuringLock }) {
    const payload = {};
    if (restrictionMode !== undefined) payload.restrictionMode = restrictionMode;
    if (blockSettingsDuringLock !== undefined) payload.blockSettingsDuringLock = blockSettingsDuringLock;
    if (getNativeBridge()) return callNative('updateGuardOptions', payload);
    return { ok: true, guardOptions: payload };
  },
  async updatePermissions(patch) {
    if (getNativeBridge()) return callNative('requestNativePermissions', patch);
    return apiPost(API_ENDPOINTS.PERMISSIONS_UPDATE, patch);
  },
  async setForegroundApp(appId) {
    if (getNativeBridge()) return callNative('launchEssentialApp', { appId });
    return apiPost(API_ENDPOINTS.FOREGROUND_SET, { appId });
  },

  async prepareEmergencyRequest({ actionType, targetAppId }) {
    const payload = { actionType, targetAppId };
    if (getNativeBridge()) return callNative('prepareEmergencyRequest', payload);
    return apiPost(API_ENDPOINTS.EMERGENCY_REQUEST_PREPARE, payload);
  },
  async verifyEmergencyCode(code) {
    if (getNativeBridge()) return callNative('verifyEmergencyCode', { code });
    return apiPost(API_ENDPOINTS.EMERGENCY_VERIFY, { code });
  },
  async relockEarly() {
    if (getNativeBridge()) return callNative('relockEarly');
    return apiPost(API_ENDPOINTS.EMERGENCY_RELOCK_EARLY);
  },

  devSim: {
    async adjustTime(action, deltaSeconds = 0) {
      return apiPost(API_ENDPOINTS.SIM_TIME_SET, { action, deltaSeconds });
    },
    async startInOneMinute(durationMinutes = 30) {
      return apiPost(API_ENDPOINTS.SIM_START_IN_ONE_MINUTE, { durationMinutes });
    },
    async setNetwork({ lanConnected, pcPoweredOn }) {
      return apiPost(API_ENDPOINTS.SIM_NETWORK_SET, { lanConnected, pcPoweredOn });
    },
    async rebootMobile() {
      return apiPost(API_ENDPOINTS.SIM_REBOOT_MOBILE);
    },
    async resetAll({ autoPair = false } = {}) {
      return apiPost(API_ENDPOINTS.SIM_RESET_ALL, { autoPair });
    },
  },
};
