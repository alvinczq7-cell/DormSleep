// 前后端/本地模拟服务通信契约（供手机端、电脑端及后续真实后端/本地服务共用）

export const API_ENDPOINTS = {
  // 共享状态查询与 SSE 实时事件流
  STATE: '/api/state',
  EVENTS: '/api/events',

  // 设备配对与解绑
  PAIR_START: '/api/pair/start',
  PAIR_CONFIRM: '/api/pair/confirm',
  PAIR_UNBIND: '/api/pair/unbind',

  // 计划、仅改今晚、应用与权限配置
  SCHEDULE_UPDATE: '/api/mobile/schedule',
  TONIGHT_OVERRIDE: '/api/mobile/tonight-override',
  APPS_UPDATE: '/api/mobile/apps',
  PERMISSIONS_UPDATE: '/api/mobile/permissions',
  ONBOARDING_COMPLETE: '/api/mobile/onboarding-complete',

  // 白天试锁（3 分钟，可跳过）
  TRIAL_START: '/api/mobile/trial/start',
  TRIAL_SKIP: '/api/mobile/trial/skip',

  // 手机端前台模拟（用于演示“到点时停留在受限应用内”）
  FOREGROUND_SET: '/api/mobile/foreground',

  // 应急解锁请求与校验（在线 + 离线统一遵循绑定与单次消费规则）
  EMERGENCY_REQUEST_PREPARE: '/api/mobile/emergency/prepare',
  EMERGENCY_VERIFY: '/api/mobile/emergency/verify',
  EMERGENCY_RELOCK_EARLY: '/api/mobile/emergency/relock-early',
  DESKTOP_ISSUE_CODE: '/api/desktop/emergency/issue',

  // 开发调试与模拟控制（正式发布版本中移除，独立边界）
  SIM_TIME_SET: '/api/sim/time',
  SIM_START_IN_ONE_MINUTE: '/api/sim/start-in-one-minute',
  SIM_NETWORK_SET: '/api/sim/network',
  SIM_REBOOT_MOBILE: '/api/sim/reboot-mobile',
  SIM_RESET_ALL: '/api/sim/reset',
};

export const CAPABILITY_BADGES = {
  SIMULATED: '模拟层提供',
  REUSABLE_LOGIC: '可复用真实逻辑',
  DEVICE_VERIFY: '待真机验证',
};
