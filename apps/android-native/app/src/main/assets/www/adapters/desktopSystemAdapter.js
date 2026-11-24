// Windows 电脑端系统能力适配层（当前对接共享本地模拟服务 + 纯本地 Web Crypto 离线算码）

import { API_ENDPOINTS } from '../shared/protocol.js';
import { deriveOfflineEmergencyCode } from '../shared/crypto.js';
import { apiGet, apiPost, subscribeEvents } from './mockHttpClient.js';

export const desktopSystemAdapter = {
  async fetchState() {
    return apiGet(`${API_ENDPOINTS.STATE}?client=desktop`);
  },
  subscribe(onUpdate) {
    return subscribeEvents(onUpdate);
  },

  // DeviceLinkAdapter：发起配对、解绑
  async startPairing() {
    return apiPost(API_ENDPOINTS.PAIR_START);
  },
  async unbindPairing() {
    return apiPost(API_ENDPOINTS.PAIR_UNBIND, { lostPc: false });
  },

  // EmergencyAuthAdapter（在线模式：实时同步手机当前活动请求，点击即显无等待）
  async issueOnlineEmergencyCode({ actionType, targetAppId } = {}) {
    return apiPost(API_ENDPOINTS.DESKTOP_ISSUE_CODE, {
      actionType,
      targetAppId,
    });
  },

  // EmergencyAuthAdapter（完全离线模式）
  // - 真实 Windows 伴随服务模式：直接调用本机后端 /api/desktop/emergency/offline（从 DPAPI 解密，前端不接触明文密钥）
  // - 浏览器模拟服务模式：使用 Web Crypto 标准 HMAC-SHA256 本地派生
  async deriveOfflineEmergencyCodeLocal({
    sharedSecret,
    pairId,
    sessionId,
    requestId,
    actionType,
    targetAppId,
    useServerSideCalc = false,
  }) {
    if (useServerSideCalc || !sharedSecret) {
      const res = await apiPost('/api/desktop/emergency/offline', {
        sessionId,
        requestId,
        actionType,
        targetAppId,
      });
      if (!res.ok) {
        throw new Error(res.errorCode || 'OFFLINE_CALC_FAILED');
      }
      return res.code;
    }
    return deriveOfflineEmergencyCode({
      sharedSecret,
      pairId,
      sessionId,
      requestId,
      actionType,
      targetAppId,
    });
  },

  // 开发调试控制（与正式界面严格分离）
  devSim: {
    async setNetwork({ lanConnected, pcPoweredOn }) {
      return apiPost(API_ENDPOINTS.SIM_NETWORK_SET, { lanConnected, pcPoweredOn });
    },
    async adjustTime(action, deltaSeconds = 0) {
      return apiPost(API_ENDPOINTS.SIM_TIME_SET, { action, deltaSeconds });
    },
    async resetAll({ autoPair = false } = {}) {
      return apiPost(API_ENDPOINTS.SIM_RESET_ALL, { autoPair });
    },
  },
};
