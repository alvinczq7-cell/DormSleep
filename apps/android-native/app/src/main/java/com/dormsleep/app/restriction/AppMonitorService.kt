package com.dormsleep.app.restriction

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.AlarmClock
import android.provider.Settings
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.app.NotificationCompat
import com.dormsleep.app.MainActivity
import com.dormsleep.app.data.LocalStateEngine
import com.dormsleep.app.scheduler.SleepAlarmScheduler
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 夜间前台应用监控与全屏悬浮窗拦截服务（多信号防绕过强化版）。
 * 防护机制：
 * 1. 锁机/试锁期间 150ms 高频检测（待机自动降至 1000ms 省电）；
 * 2. 完整 UsageEvents 生命周期状态机（RESUMED / USER_INTERACTION / PAUSED / STOPPED），
 *    过滤状态栏与输入法瞬态，彻底解决多任务后台回弹漏检与悬浮小窗/分屏绕过；
 * 3. Android 10+ UsageStats.lastTimeVisible 增量交叉校验，即便系统静默从后台恢复应用也能立即捕获；
 * 4. 命中受限应用后「全屏拦截层 + 主动踢回桌面」双重处置，强制暂停受限应用并锁定遮罩直到用户返回桌面/打开安全应用；
 * 5. 与可选 DormSleepAccessibilityService 无障碍增强联动，实现 0ms 窗口切换拦截与 GLOBAL_ACTION_HOME 强制退回；
 * 6. 监听亮屏/解锁广播与 onTaskRemoved 1 秒看门狗自动拉活。
 */
class AppMonitorService : Service() {
    companion object {
        const val CHANNEL_ID = "dormsleep_guard_channel"
        const val NOTIF_ID = 1001
        const val EXTRA_BLOCKED_PKG = "extra_blocked_pkg"
        private const val GUARD_POLL_INTERVAL_MS = 150L
        private const val IDLE_POLL_INTERVAL_MS = 1000L
        private const val WATCHDOG_INTERVAL_MS = 45_000L
        private const val EVICT_THROTTLE_MS = 600L

        @Volatile
        private var runningInstance: AppMonitorService? = null

        fun notifyBlockedFromAccessibility(context: Context, blockedPkg: String) {
            val inst = runningInstance
            if (inst != null) {
                inst.handler.post {
                    runCatching { inst.handleAccessibilityBlocked(blockedPkg) }
                }
            } else {
                val svc = Intent(context, AppMonitorService::class.java).apply {
                    putExtra(EXTRA_BLOCKED_PKG, blockedPkg)
                }
                runCatching {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(svc)
                    else context.startService(svc)
                }
            }
        }

        fun notifySafeAppEntered(pkg: String, ts: Long) {
            val inst = runningInstance ?: return
            inst.handler.post {
                runCatching { inst.handleAccessibilitySafeApp(pkg, ts) }
            }
        }
    }

    private data class ForegroundSample(
        val blockedPkg: String?,
        val topNonLauncherSafePkg: String?,
        val topNonLauncherSafeTs: Long,
    )

    private lateinit var engine: LocalStateEngine
    private val handler = Handler(Looper.getMainLooper())
    private var lastKnownForegroundPkg: String? = null
    private var lastNotifText: String = ""
    private var lastWatchdogAt: Long = 0L

    // 拦截层钉住与主动退回桌面防抖状态
    private var pinnedBlockedPkg: String? = null
    private var pinnedSinceMs: Long = 0L
    private var lastDismissedPkg: String? = null
    private var lastDismissedAtMs: Long = 0L
    private var lastEvictionAtMs: Long = 0L

    // Android 10+ lastTimeVisible 增量表，用于捕获静默多任务切回
    private val lastSeenVisibleTs = HashMap<String, Long>()
    private var visibleBaselineInitialized = false

    private var overlayRoot: View? = null
    private var overlayBlockedPkg: String? = null
    private var overlayClockText: TextView? = null
    private var overlaySubText: TextView? = null
    private var overlayAppText: TextView? = null

    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            // 亮屏或解锁后立即检查一次，防止锁屏前停留在受限应用中解锁直接进入
            handler.post { runCatching { tickGuard() } }
        }
    }

    private val pollRunnable = object : Runnable {
        override fun run() {
            val nextDelay = runCatching { tickGuard() }.getOrDefault(IDLE_POLL_INTERVAL_MS)
            handler.postDelayed(this, nextDelay)
        }
    }

    override fun onCreate() {
        super.onCreate()
        runningInstance = this
        engine = LocalStateEngine.getInstance(this)
        ensureChannel()
        startForeground(NOTIF_ID, buildNotification("熄灯守夜保护已就绪"))

        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_USER_PRESENT)
        }
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(screenReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                @Suppress("DEPRECATION")
                registerReceiver(screenReceiver, filter)
            }
        }
        handler.post(pollRunnable)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val urgentPkg = intent?.getStringExtra(EXTRA_BLOCKED_PKG)
        if (!urgentPkg.isNullOrBlank()) {
            handler.post { runCatching { handleAccessibilityBlocked(urgentPkg) } }
        } else {
            handler.post { runCatching { tickGuard() } }
        }
        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // 锁机/试锁期间用户在多任务列表上划清理应用时，立即通过精确闹钟在 1 秒内拉活守护服务
        if (engine.isActivelyGuarding()) {
            SleepAlarmScheduler.scheduleGuardWatchdog(this, 1000L)
        }
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        if (runningInstance === this) runningInstance = null
        handler.removeCallbacks(pollRunnable)
        runCatching { unregisterReceiver(screenReceiver) }
        removeOverlay()
        if (engine.isActivelyGuarding()) {
            SleepAlarmScheduler.scheduleGuardWatchdog(this, 1500L)
        }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun handleAccessibilityBlocked(blockedPkg: String) {
        val now = System.currentTimeMillis()
        val state = engine.evaluate(now)
        val ns = state.getJSONObject("nightSession")
        val trial = state.optJSONObject("trialSession")
        val endAt = trial?.optLong("endAt", 0L) ?: ns.optLong("endAt", 0L)
        if (blockedPkg != packageName && engine.shouldBlockPackage(blockedPkg, now)) {
            enforceBlock(blockedPkg, now, endAt, trial != null)
        }
    }

    private fun handleAccessibilitySafeApp(pkg: String, ts: Long) {
        val pinned = pinnedBlockedPkg ?: return
        if (ts > pinnedSinceMs + 250L && pkg != pinned && !engine.shouldBlockPackage(pkg, ts)) {
            pinnedBlockedPkg = null
            lastKnownForegroundPkg = pkg
            removeOverlay()
        }
    }

    private fun tickGuard(): Long {
        val now = System.currentTimeMillis()
        val state = engine.evaluate(now)
        val ns = state.getJSONObject("nightSession")
        val trial = state.optJSONObject("trialSession")
        val status = if (trial != null) "TRIAL_LOCKED" else ns.optString("status", "IDLE")
        val ta = trial?.optJSONObject("tempAllow") ?: ns.optJSONObject("tempAllow")
        val endAt = trial?.optLong("endAt", 0L) ?: ns.optLong("endAt", 0L)
        val isGuarding = status == "TRIAL_LOCKED" || status == "LOCKED" || status == "TEMP_ALLOW"

        if (isGuarding) {
            if (now - lastWatchdogAt > WATCHDOG_INTERVAL_MS) {
                lastWatchdogAt = now
                SleepAlarmScheduler.scheduleGuardWatchdog(this, 60_000L)
            }
        }

        val notifText = when {
            ta != null -> {
                val endHm = SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(ta.optLong("expiresAt")))
                val allowName = InstalledAppScanner.resolveAppName(this, ta.optString("appId"))
                "临时放行中：仅 $allowName · $endHm 自动恢复拦截"
            }
            status == "TRIAL_LOCKED" -> "白天试锁保护中（满 3 分钟自动恢复）"
            status == "LOCKED" -> "夜间守夜保护中 · 电话、闹钟与校园码畅通"
            status == "PRE_LOCK_REMINDER" -> "即将自动进入夜间守夜，请准备收尾"
            else -> "熄灯守夜待机中"
        }
        if (notifText != lastNotifText) {
            lastNotifText = notifText
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.notify(NOTIF_ID, buildNotification(notifText))
        }

        if (!isGuarding) {
            pinnedBlockedPkg = null
            removeOverlay()
            return IDLE_POLL_INTERVAL_MS
        }

        val sample = detectForegroundState(now)

        if (sample.blockedPkg != null) {
            enforceBlock(sample.blockedPkg, now, endAt, trial != null)
            return GUARD_POLL_INTERVAL_MS
        }

        // 若拦截遮罩正处于钉住态（因刚将受限应用主动踢回桌面）：
        val pinned = pinnedBlockedPkg
        if (pinned != null) {
            if (!engine.shouldBlockPackage(pinned, now)) {
                // 该应用刚被 15 分钟放行或策略已变更
                pinnedBlockedPkg = null
                removeOverlay()
            } else if (sample.topNonLauncherSafePkg != null && sample.topNonLauncherSafeTs > pinnedSinceMs + 300L) {
                // 用户明确切入安全/豁免应用（如来电、闹钟、熄灯守夜或已豁免微信）
                pinnedBlockedPkg = null
                removeOverlay()
            } else if (Settings.canDrawOverlays(this)) {
                showOrUpdateOverlay(pinned, now, endAt, trial != null)
            }
            return GUARD_POLL_INTERVAL_MS
        }

        removeOverlay()
        return GUARD_POLL_INTERVAL_MS
    }

    /**
     * 双重处置：立即弹出全屏拦截层 + 主动将受限应用踢回桌面（强制其 onPause/onStop，防止后台秒回弹）。
     */
    private fun enforceBlock(blockedPkg: String, nowMs: Long, endAtMs: Long, isTrial: Boolean) {
        if (pinnedBlockedPkg != blockedPkg) {
            pinnedBlockedPkg = blockedPkg
            pinnedSinceMs = nowMs
        }
        if (Settings.canDrawOverlays(this)) {
            showOrUpdateOverlay(blockedPkg, nowMs, endAtMs, isTrial)
        }
        evictBlockedAppToHome(nowMs, force = false)
    }

    private fun evictBlockedAppToHome(nowMs: Long, force: Boolean) {
        if (!force && nowMs - lastEvictionAtMs < EVICT_THROTTLE_MS) return
        lastEvictionAtMs = nowMs

        // 优先走无障碍 GLOBAL_ACTION_HOME（零延迟且不受荣耀后台启动限制）
        if (DormSleepAccessibilityService.performHomeIfConnected()) return

        // 兜底使用系统 HOME Intent 将受限应用压入后台
        val home = Intent(Intent.ACTION_MAIN).apply {
            addCategory(Intent.CATEGORY_HOME)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
        }
        runCatching { startActivity(home) }
    }

    /**
     * 多信号前台与多窗检测：
     * A. 无障碍可见窗口实时检测（已开启增强时 0ms 捕获多任务/小窗/分屏）；
     * B. UsageEvents 完整生命周期状态机（RESUMED + USER_INTERACTION + PAUSED + STOPPED）；
     * C. Android 10+ UsageStats.lastTimeVisible 增量检测（捕获系统静默从后台恢复的应用）；
     * D. 停留超过 2 分钟未操作的静态前台兜底。
     */
    @Suppress("DEPRECATION")
    private fun detectForegroundState(nowMs: Long): ForegroundSample {
        // Signal A：无障碍实时可见窗口（0ms，含分屏/悬浮小窗）
        DormSleepAccessibilityService.findVisibleBlockedPackage(engine, nowMs)?.let {
            lastKnownForegroundPkg = it
            return ForegroundSample(blockedPkg = it, topNonLauncherSafePkg = null, topNonLauncherSafeTs = 0L)
        }

        val usm = getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager
            ?: return ForegroundSample(null, null, 0L)

        val transientIgnore = InstalledAppScanner.getTransientSystemIgnorePackages(this)
        val launchers = InstalledAppScanner.getLauncherPackages(this)

        // Signal B：滚动 2 分钟 UsageEvents 完整生命周期回放
        val activeApps = LinkedHashMap<String, Long>()
        var newestResumedPkg: String? = null
        var newestResumedTs = 0L
        var newestInteractionPkg: String? = null
        var newestInteractionTs = 0L

        val events = runCatching { usm.queryEvents(nowMs - 120_000L, nowMs) }.getOrNull()
        if (events != null) {
            val evt = UsageEvents.Event()
            while (events.hasNextEvent()) {
                events.getNextEvent(evt)
                val pkg = evt.packageName
                if (pkg.isNullOrBlank() || pkg in transientIgnore) continue
                val ts = evt.timeStamp
                val type = evt.eventType

                val isResume = type == UsageEvents.Event.ACTIVITY_RESUMED ||
                    type == UsageEvents.Event.MOVE_TO_FOREGROUND
                val isInteraction = type == UsageEvents.Event.USER_INTERACTION
                val isPauseOrStop = type == UsageEvents.Event.ACTIVITY_PAUSED ||
                    type == UsageEvents.Event.MOVE_TO_BACKGROUND ||
                    (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && type == UsageEvents.Event.ACTIVITY_STOPPED)

                when {
                    isResume -> {
                        activeApps[pkg] = ts
                        if (ts >= newestResumedTs) {
                            newestResumedTs = ts
                            newestResumedPkg = pkg
                        }
                    }
                    isInteraction -> {
                        activeApps[pkg] = ts
                        if (ts >= newestInteractionTs) {
                            newestInteractionTs = ts
                            newestInteractionPkg = pkg
                        }
                    }
                    isPauseOrStop -> {
                        val curTs = activeApps[pkg]
                        if (curTs != null && ts >= curTs) {
                            activeApps.remove(pkg)
                        }
                    }
                }
            }
        }

        // 更新最新已知前台包名
        val freshestEvtPkg = if (newestInteractionTs > newestResumedTs) newestInteractionPkg else newestResumedPkg
        if (freshestEvtPkg != null) {
            lastKnownForegroundPkg = freshestEvtPkg
        }

        // 找出当前活跃集中最新的应用与最新非桌面安全应用
        var maxActivePkg: String? = null
        var maxActiveTs = 0L
        var topSafePkg: String? = null
        var topSafeTs = 0L
        for ((pkg, ts) in activeApps) {
            if (ts >= maxActiveTs) {
                maxActiveTs = ts
                maxActivePkg = pkg
            }
            if (pkg !in launchers && !engine.shouldBlockPackage(pkg, nowMs) && ts >= topSafeTs) {
                topSafeTs = ts
                topSafePkg = pkg
            }
        }

        // 检查 1：活跃未暂停集合中是否命中受限应用（捕获正常切入、多任务取消回弹、悬浮小窗/分屏）
        var detectedBlocked: String? = null
        var detectedBlockedTs = 0L
        for ((pkg, ts) in activeApps) {
            if (pkg == packageName) continue
            if (!engine.shouldBlockPackage(pkg, nowMs)) continue
            if (pkg == lastDismissedPkg && ts <= lastDismissedAtMs) continue

            val isTopmost = (pkg == maxActivePkg)
            val topIsLauncher = maxActivePkg != null && maxActivePkg in launchers
            val recentMultiWindow = (nowMs - ts) <= 20_000L

            if (isTopmost || topIsLauncher || recentMultiWindow) {
                if (ts >= detectedBlockedTs) {
                    detectedBlockedTs = ts
                    detectedBlocked = pkg
                }
            }
        }
        if (detectedBlocked != null) {
            return ForegroundSample(detectedBlocked, topSafePkg, topSafeTs)
        }

        // 检查 2：近 4 秒内受限应用产生过真实触摸交互（兜底部分 ROM 漏发 ACTIVITY_RESUMED）
        if (newestInteractionPkg != null &&
            newestInteractionPkg != packageName &&
            (nowMs - newestInteractionTs) <= 4_000L &&
            engine.shouldBlockPackage(newestInteractionPkg, nowMs) &&
            !(newestInteractionPkg == lastDismissedPkg && newestInteractionTs <= lastDismissedAtMs)
        ) {
            return ForegroundSample(newestInteractionPkg, topSafePkg, topSafeTs)
        }

        // 检查 3（Signal C）：Android 10+ UsageStats.lastTimeVisible 增量检测
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val stats = runCatching {
                usm.queryUsageStats(UsageStatsManager.INTERVAL_BEST, nowMs - 60_000L, nowMs)
            }.getOrNull()
            if (stats != null) {
                var jumpedBlocked: String? = null
                var jumpedTs = 0L
                var freshestColdPkg: String? = null
                var freshestColdTs = 0L

                for (st in stats) {
                    val pkg = st.packageName ?: continue
                    if (pkg in transientIgnore) continue
                    val visTs = st.lastTimeVisible
                    if (visTs <= 0L) continue

                    if (visTs > freshestColdTs) {
                        freshestColdTs = visTs
                        freshestColdPkg = pkg
                    }

                    val prev = lastSeenVisibleTs[pkg] ?: 0L
                    if (visTs > prev) {
                        lastSeenVisibleTs[pkg] = visTs
                        if (visibleBaselineInitialized &&
                            pkg != packageName &&
                            (nowMs - visTs) <= 10_000L &&
                            engine.shouldBlockPackage(pkg, nowMs) &&
                            !(pkg == lastDismissedPkg && visTs <= lastDismissedAtMs) &&
                            visTs >= jumpedTs
                        ) {
                            jumpedTs = visTs
                            jumpedBlocked = pkg
                        }
                    }
                }
                visibleBaselineInitialized = true

                if (jumpedBlocked != null) {
                    lastKnownForegroundPkg = jumpedBlocked
                    return ForegroundSample(jumpedBlocked, topSafePkg, topSafeTs)
                }
                if (lastKnownForegroundPkg == null && freshestColdPkg != null && (nowMs - freshestColdTs) <= 60_000L) {
                    lastKnownForegroundPkg = freshestColdPkg
                }
            }
        } else if (lastKnownForegroundPkg == null) {
            val stats = runCatching {
                usm.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, nowMs - 600_000L, nowMs)
            }.getOrNull()
            val recent = stats
                ?.filter { it.packageName !in transientIgnore && it.lastTimeUsed > 0L }
                ?.maxByOrNull { it.lastTimeUsed }
            if (recent != null && (nowMs - recent.lastTimeUsed) <= 600_000L) {
                lastKnownForegroundPkg = recent.packageName
            }
        }

        // 检查 4（Signal D）：锁定前早已打开某受限应用且静止停留超过 2 分钟
        val staticFg = lastKnownForegroundPkg
        if (activeApps.isEmpty() &&
            staticFg != null &&
            staticFg != packageName &&
            staticFg != lastDismissedPkg &&
            engine.shouldBlockPackage(staticFg, nowMs)
        ) {
            return ForegroundSample(staticFg, topSafePkg, topSafeTs)
        }

        return ForegroundSample(null, topSafePkg, topSafeTs)
    }

    private fun dp(value: Int): Int {
        return (value * resources.displayMetrics.density).toInt()
    }

    private fun formatRemaining(ms: Long): String {
        val safe = maxOf(0L, ms / 1000L)
        val h = safe / 3600L
        val m = (safe % 3600L) / 60L
        val s = safe % 60L
        return if (h > 0) String.format(Locale.US, "%d 小时 %02d 分 %02d 秒", h, m, s)
        else String.format(Locale.US, "%02d 分 %02d 秒", m, s)
    }

    private fun dismissOverlayAndGoHome() {
        val now = System.currentTimeMillis()
        lastDismissedPkg = pinnedBlockedPkg ?: overlayBlockedPkg
        lastDismissedAtMs = now
        pinnedBlockedPkg = null
        lastKnownForegroundPkg = null
        evictBlockedAppToHome(now, force = true)
        removeOverlay()
    }

    private fun releaseOverlayForSafeAction() {
        val now = System.currentTimeMillis()
        lastDismissedPkg = pinnedBlockedPkg ?: overlayBlockedPkg
        lastDismissedAtMs = now
        pinnedBlockedPkg = null
        lastKnownForegroundPkg = null
        removeOverlay()
    }

    private fun showOrUpdateOverlay(blockedPkg: String, nowMs: Long, endAtMs: Long, isTrial: Boolean) {
        val appName = InstalledAppScanner.resolveAppName(this, blockedPkg)
        val isSettingsGuard = blockedPkg in InstalledAppScanner.GUARDED_SETTINGS_PKGS
        val hmNow = SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(nowMs))
        val endHm = SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(endAtMs))
        val remText = formatRemaining(endAtMs - nowMs)
        val subLine = if (isTrial) "白天试锁中 · 距自动恢复还有 $remText" else "距 $endHm 自动恢复还有 $remText"
        val appLine = if (isSettingsGuard) "已保护「$appName」· 锁机防绕过生效中" else "已暂停「$appName」"

        if (overlayRoot != null && overlayBlockedPkg == blockedPkg) {
            overlayClockText?.text = hmNow
            overlaySubText?.text = subLine
            overlayAppText?.text = appLine
            return
        }

        removeOverlay()

        val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }

        @Suppress("DEPRECATION")
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            type,
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                WindowManager.LayoutParams.FLAG_FULLSCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.CENTER
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }

        val root = object : FrameLayout(this) {
            override fun dispatchKeyEvent(event: KeyEvent): Boolean {
                if (event.keyCode == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_UP) {
                    dismissOverlayAndGoHome()
                    return true
                }
                return super.dispatchKeyEvent(event)
            }
        }.apply {
            isFocusable = true
            isFocusableInTouchMode = true
            background = GradientDrawable(
                GradientDrawable.Orientation.TL_BR,
                intArrayOf(
                    Color.parseColor("#FA070918"),
                    Color.parseColor("#FA130E30"),
                    Color.parseColor("#FA060814"),
                ),
            )
        }

        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(24), dp(58), dp(24), dp(36))
        }

        val badge = TextView(this).apply {
            text = if (isTrial) "●  白天试锁守夜中" else "●  熄灯守夜保护中"
            textSize = 12.5f
            setTextColor(Color.parseColor("#E0E7FF"))
            setPadding(dp(14), dp(6), dp(14), dp(6))
            background = GradientDrawable().apply {
                cornerRadius = dp(99).toFloat()
                setColor(Color.parseColor("#2E8B5CF6"))
                setStroke(dp(1), Color.parseColor("#55C4B5FD"))
            }
        }
        col.addView(badge, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT))

        val clockTv = TextView(this).apply {
            text = hmNow
            textSize = 62f
            typeface = Typeface.create("sans-serif-light", Typeface.NORMAL)
            setTextColor(Color.parseColor("#F5F3FF"))
            gravity = Gravity.CENTER
            setPadding(0, dp(28), 0, dp(4))
        }
        overlayClockText = clockTv
        col.addView(clockTv)

        val subTv = TextView(this).apply {
            text = subLine
            textSize = 13.5f
            setTextColor(Color.parseColor("#BFC8EB"))
            gravity = Gravity.CENTER
        }
        overlaySubText = subTv
        col.addView(subTv)

        val appPill = TextView(this).apply {
            text = appLine
            textSize = 13f
            setTextColor(Color.parseColor("#F5D0FE"))
            setPadding(dp(16), dp(8), dp(16), dp(8))
            background = GradientDrawable().apply {
                cornerRadius = dp(99).toFloat()
                setColor(Color.parseColor("#33D946EF"))
                setStroke(dp(1), Color.parseColor("#55E879F9"))
            }
        }
        overlayAppText = appPill
        col.addView(
            appPill,
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(18)
                bottomMargin = dp(32)
            },
        )

        val essLabel = TextView(this).apply {
            text = "必要功能始终畅通 · 一键直达"
            textSize = 11.5f
            setTextColor(Color.parseColor("#8A94B8"))
            gravity = Gravity.CENTER
        }
        col.addView(essLabel, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
            bottomMargin = dp(12)
        })

        val essRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
        }
        fun makeSafeBtn(label: String, onClick: () -> Unit): TextView {
            return TextView(this).apply {
                text = label
                textSize = 13.5f
                typeface = Typeface.DEFAULT_BOLD
                setTextColor(Color.parseColor("#A7F3D0"))
                gravity = Gravity.CENTER
                setPadding(dp(10), dp(16), dp(10), dp(16))
                background = GradientDrawable(
                    GradientDrawable.Orientation.TL_BR,
                    intArrayOf(Color.parseColor("#2810B981"), Color.parseColor("#1D06B6D4")),
                ).apply {
                    cornerRadius = dp(16).toFloat()
                    setStroke(dp(1), Color.parseColor("#5534D399"))
                }
                setOnClickListener { onClick() }
            }
        }

        val btnLp = {
            LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginStart = dp(5)
                marginEnd = dp(5)
            }
        }
        essRow.addView(makeSafeBtn("紧急拨号") {
            releaseOverlayForSafeAction()
            runCatching {
                startActivity(Intent(Intent.ACTION_DIAL).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
        }, btnLp())
        essRow.addView(makeSafeBtn("系统闹钟") {
            releaseOverlayForSafeAction()
            runCatching {
                startActivity(Intent(AlarmClock.ACTION_SHOW_ALARMS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
        }, btnLp())
        essRow.addView(makeSafeBtn("返回桌面") {
            dismissOverlayAndGoHome()
        }, btnLp())
        col.addView(essRow, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))

        col.addView(View(this), LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))

        val unlockBtn = TextView(this).apply {
            text = if (isSettingsGuard) "打开熄灯守夜 · 输入电脑应急码" else "急事用 20 分钟 · 输入电脑应急码"
            textSize = 14.5f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            setPadding(dp(18), dp(15), dp(18), dp(15))
            background = GradientDrawable(
                GradientDrawable.Orientation.LEFT_RIGHT,
                intArrayOf(
                    Color.parseColor("#7C3AED"),
                    Color.parseColor("#C026D3"),
                    Color.parseColor("#EC4899"),
                ),
            ).apply {
                cornerRadius = dp(16).toFloat()
                setStroke(dp(1), Color.parseColor("#44FFFFFF"))
            }
            setOnClickListener {
                releaseOverlayForSafeAction()
                val i = Intent(context, MainActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    putExtra("blocked_pkg", blockedPkg)
                }
                context.startActivity(i)
            }
        }
        col.addView(unlockBtn, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))

        val hintTv = TextView(this).apply {
            text = "受限应用已退回后台 · 点「返回桌面」或按返回键即可退出"
            textSize = 11.5f
            setTextColor(Color.parseColor("#7B84A8"))
            gravity = Gravity.CENTER
            setPadding(0, dp(12), 0, 0)
        }
        col.addView(hintTv)

        root.addView(col, FrameLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))

        runCatching {
            wm.addView(root, params)
            overlayRoot = root
            overlayBlockedPkg = blockedPkg
        }
    }

    private fun removeOverlay() {
        val v = overlayRoot ?: return
        runCatching {
            val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
            wm.removeView(v)
        }
        overlayRoot = null
        overlayBlockedPkg = null
        overlayClockText = null
        overlaySubText = null
        overlayAppText = null
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(CHANNEL_ID, "夜间守夜与临时放行状态", NotificationManager.IMPORTANCE_LOW)
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(ch)
        }
    }

    private fun buildNotification(content: String): Notification {
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentTitle("熄灯守夜")
            .setContentText(content)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }
}
