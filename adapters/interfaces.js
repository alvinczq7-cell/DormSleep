/**
 * 系统能力适配层边界定义（仅声明接口契约，方便后续无缝替换为 Android / Windows 原生实现）
 *
 * 1. TimeSchedulerAdapter（时间调度）
 *    - updateRegularSchedule(schedule)
 *    - applyTonightOverride({ mode, start, end })
 *    - startDaytimeTrial() / skipDaytimeTrial()
 *    真实替换目标：Android AlarmManager (SCHEDULE_EXACT_ALARM) + RECEIVE_BOOT_COMPLETED + 本地数据库
 *
 * 2. AppRestrictionAdapter（应用限制与权限）
 *    - updateAppLists({ restrictedAppIds, exemptAppIds })
 *    - updatePermissions(patch)
 *    - setForegroundApp(appId)   // 仅前端演示模拟；真实 Android 由 UsageStatsManager 自动采集
 *    真实替换目标：Android UsageStatsManager + SYSTEM_ALERT_WINDOW 悬浮窗服务 + ForegroundService
 *
 * 3. DeviceLinkAdapter（设备配对与局域网通信）
 *    - startPairing() / confirmPairing(pairCode) / unbindPairing({ lostPc })
 *    - subscribeState(client, onUpdate)
 *    真实替换目标：Windows 本地 HTTP/WebSocket 服务 + mDNS/UDP 局域网发现 + TLS/签名握手
 *
 * 4. EmergencyAuthAdapter（应急请求绑定、发码与校验）
 *    - prepareEmergencyRequest({ actionType, targetAppId })
 *    - issueOnlineCode({ actionType, targetAppId })        // 仅电脑端
 *    - deriveOfflineCodeLocal({ ... })                     // 电脑端纯本地 Web Crypto HMAC-SHA256
 *    - verifyEmergencyCode(code)                           // 手机端校验与持久化消费
 *    - relockEarly()
 *    真实替换目标：Android Keystore + SQLite 持久化消费表 / Windows DPAPI + CSPRNG
 */

export const ADAPTER_CAPABILITY_MANIFEST = {
  mobile: [
    {
      name: '时间调度与跨午夜会话归属',
      mode: '模拟层 + 可复用规则',
      realTarget: 'Android AlarmManager (SCHEDULE_EXACT_ALARM) + RECEIVE_BOOT_COMPLETED',
      needsDeviceVerify: true,
    },
    {
      name: '受限娱乐应用前台拦截与悬浮窗覆盖',
      mode: '模拟层提供',
      realTarget: 'UsageStatsManager + SYSTEM_ALERT_WINDOW + ForegroundService',
      needsDeviceVerify: true,
    },
    {
      name: '电话/闹钟/校园码快捷放行不误伤',
      mode: '模拟层提供',
      realTarget: 'Android Intent 跳转系统拨号/闹钟及白名单包名放行',
      needsDeviceVerify: true,
    },
    {
      name: '应急请求绑定、切换作废与离线 HMAC 校验',
      mode: '可复用真实密码学逻辑',
      realTarget: 'Android Keystore 保存共享密钥 + Room/SQLite 持久化消费表',
      needsDeviceVerify: true,
    },
  ],
  desktop: [
    {
      name: '首次配对与本地共享密钥存储',
      mode: '模拟层提供（浏览器内存/JSON）',
      realTarget: 'Windows 本地伴随服务 + DPAPI 加密存储',
      needsDeviceVerify: true,
    },
    {
      name: '局域网自动发现与状态实时同步',
      mode: '共享本地模拟服务 (HTTP + SSE)',
      realTarget: 'mDNS / UDP 局域网广播 + 本地 HTTP/WebSocket',
      needsDeviceVerify: true,
    },
    {
      name: '在线 CSPRNG 发码与完全离线 HMAC-SHA256 派生',
      mode: '可复用真实密码学逻辑',
      realTarget: 'Windows 本地服务 CSPRNG / Web Crypto HMAC-SHA256',
      needsDeviceVerify: false,
    },
  ],
};
