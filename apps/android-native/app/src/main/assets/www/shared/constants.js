// 共享领域常量与默认应用目录（手机端、电脑端与适配层共用）

export const SESSION_STATES = {
  IDLE: 'IDLE',                         // 待机（未到锁定时间）
  PRE_LOCK_REMINDER: 'PRE_LOCK_REMINDER', // 睡前收尾提醒中（开始前 N 分钟）
  LOCKED: 'LOCKED',                     // 夜间限制生效中
  TEMP_ALLOW: 'TEMP_ALLOW',             // 临时放行中（仅单个选定应用 20 分钟）
  ENDED_EARLY: 'ENDED_EARLY',           // 今晚已提前结束限制
  NATURAL_ENDED: 'NATURAL_ENDED',       // 本次锁定已到点自然结束
  PAUSED_TONIGHT: 'PAUSED_TONIGHT',     // 通过「仅改今晚」暂停了今晚一次
  PROTECTION_INTERRUPTED: 'PROTECTION_INTERRUPTED', // 关键权限被撤销，保护已中断
  TRIAL_LOCKED: 'TRIAL_LOCKED',         // 白天试锁中（限时 3 分钟，可跳过）
};

export const EMERGENCY_ACTIONS = {
  TEMP_ALLOW_15M: 'TEMP_ALLOW_15M',
  END_TONIGHT: 'END_TONIGHT',
};

export const TEMP_ALLOW_MINUTES = 20;
export const FREEZE_MINUTES_BEFORE_START = 30;
export const TRIAL_DURATION_MINUTES = 3;
export const LOST_PC_COOLDOWN_HOURS = 24;

export const APP_CATALOG = [
  // 强制豁免（系统必要功能，不可加入受限名单）
  {
    id: 'com.android.dialer',
    name: '系统电话 / 紧急拨号',
    category: 'MANDATORY',
    icon: '📞',
    description: '急事联络与紧急呼救，始终强制放行',
    campusCodeWarning: false,
  },
  {
    id: 'com.android.mms',
    name: '系统短信',
    category: 'MANDATORY',
    icon: '💬',
    description: '接收验证码与紧急短信，始终强制放行',
    campusCodeWarning: false,
  },
  {
    id: 'com.android.deskclock',
    name: '系统闹钟',
    category: 'MANDATORY',
    icon: '⏰',
    description: '明早早八闹钟保障，始终强制放行',
    campusCodeWarning: false,
  },

  // 必要/校园服务（可按需豁免，含明确范围提示）
  {
    id: 'edu.campus.card',
    name: '校园一卡通 / 独立门禁',
    category: 'ESSENTIAL',
    icon: '🪪',
    description: '宿舍门禁、教学楼打卡、食堂刷码（独立 App 单独放行）',
    campusCodeWarning: false,
  },
  {
    id: 'com.auth.campus',
    name: '校园身份验证器',
    category: 'ESSENTIAL',
    icon: '🔐',
    description: '教务系统、VPN 与实验平台动态口令',
    campusCodeWarning: false,
  },
  {
    id: 'com.tencent.mm',
    name: '微信（含校园门禁小程序）',
    category: 'HYBRID',
    icon: '💚',
    description: '部分高校通过微信小程序刷门禁/收通知',
    campusCodeWarning: true,
    campusWarningText:
      'Android 普通应用无法只放行单个微信小程序而单独拦截朋友圈或视频号。若保留微信用于刷校园码，将放行整个微信应用。',
  },
  {
    id: 'com.eg.android.AlipayGphone',
    name: '支付宝（含校园码小程序）',
    category: 'HYBRID',
    icon: '💙',
    description: '部分高校通过支付宝刷食堂/门禁校园码',
    campusCodeWarning: true,
    campusWarningText:
      'Android 普通应用无法仅放行支付宝内的校园码小程序而屏蔽其他页面。开启豁免将放行整个支付宝应用。',
  },

  // 常见夜间娱乐应用（默认受限或可选受限）
  {
    id: 'tv.danmaku.bili',
    name: '哔哩哔哩',
    category: 'ENTERTAINMENT',
    icon: '📺',
    description: '视频与直播娱乐',
    campusCodeWarning: false,
  },
  {
    id: 'com.ss.android.ugc.aweme',
    name: '抖音',
    category: 'ENTERTAINMENT',
    icon: '🎵',
    description: '短视频娱乐',
    campusCodeWarning: false,
  },
  {
    id: 'com.xingin.xhs',
    name: '小红书',
    category: 'ENTERTAINMENT',
    icon: '📕',
    description: '图文与短视频社区',
    campusCodeWarning: false,
  },
  {
    id: 'com.sina.weibo',
    name: '微博',
    category: 'ENTERTAINMENT',
    icon: '🔥',
    description: '热搜与社交刷屏',
    campusCodeWarning: false,
  },
  {
    id: 'com.tencent.tmgp.sgame',
    name: '王者荣耀',
    category: 'ENTERTAINMENT',
    icon: '🎮',
    description: '竞技手游',
    campusCodeWarning: false,
  },
  {
    id: 'com.miHoYo.Yuanshen',
    name: '原神',
    category: 'ENTERTAINMENT',
    icon: '✨',
    description: '大型手游',
    campusCodeWarning: false,
  },
];

export const APP_MAP = Object.fromEntries(APP_CATALOG.map((app) => [app.id, app]));

export const ERROR_MESSAGES = {
  CODE_INVALID: '应急码不正确，请核对电脑端显示的 6 位数字。',
  CODE_ALREADY_USED: '该应急码已使用并失效，请使用手机当前的新识别号到电脑重新获取。',
  REQUEST_INVALIDATED: '该应急码对应的请求已因切换应用或操作类型而作废，请用新识别号重新取码。',
  REQUEST_MISMATCH: '应急码与当前请求（会话、操作类型或目标应用）不匹配，请核对电脑端设置。',
  COOLDOWN_ACTIVE: '连续输错次数较多，请等待冷却结束后再试。',
  SESSION_NOT_LOCKED: '当前未处于需要解锁的限制状态。',
  SESSION_ALREADY_ENDED: '本次锁定已到点自动结束，所有应用已恢复可用，无需再输入应急码。',
  FROZEN_MODIFICATION: '已过今晚固定修改截止时间，今晚不可再改期或暂停；放宽调整将于下一晚生效。',
  PAIR_CODE_INVALID: '配对码无效或已过期，请在电脑端刷新配对码后重试。',
  PC_OFFLINE: '电脑当前未在线或不在同一局域网，请改用电脑端「离线取码」模式。',
  NOT_PAIRED: '尚未完成与电脑的配对，请先完成首次配对。',
};

export function formatActionLabel(actionType, targetAppId) {
  if (actionType === EMERGENCY_ACTIONS.END_TONIGHT) {
    return '结束今晚限制';
  }
  const appName = APP_MAP[targetAppId]?.name || targetAppId || '指定应用';
  return `临时放行 ${TEMP_ALLOW_MINUTES} 分钟 · ${appName}`;
}
