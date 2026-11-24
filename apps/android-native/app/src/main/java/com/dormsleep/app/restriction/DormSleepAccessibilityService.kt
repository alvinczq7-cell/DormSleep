package com.dormsleep.app.restriction

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.os.Build
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityWindowInfo
import com.dormsleep.app.data.LocalStateEngine

/**
 * 可选「强力防后台切换增强」无障碍守护服务：
 * - 零延迟响应 TYPE_WINDOW_STATE_CHANGED / TYPE_WINDOWS_CHANGED，彻底封堵从多任务后台、底部手势条、悬浮小窗与分屏切入受限应用；
 * - 直接调用 GLOBAL_ACTION_HOME 将受限应用踢回后台，不依赖容易受系统限制的后台 startActivity；
 * - 严格隐私边界：仅读取窗口所属应用包名（packageName），绝不读取任何屏幕文字、输入框或通知内容。
 */
class DormSleepAccessibilityService : AccessibilityService() {

    companion object {
        @Volatile
        private var instance: DormSleepAccessibilityService? = null

        @Volatile
        private var lastHomeActionAt: Long = 0L

        fun isServiceConnected(): Boolean = instance != null

        fun performHomeIfConnected(): Boolean {
            val svc = instance ?: return false
            val now = System.currentTimeMillis()
            if (now - lastHomeActionAt < 220L) return true
            lastHomeActionAt = now
            return runCatching { svc.performGlobalAction(GLOBAL_ACTION_HOME) }.getOrDefault(false)
        }

        /**
         * 检查当前所有可见应用窗口（包含全屏、分屏、荣耀悬浮小窗），返回第一个命中的受限包名。
         */
        fun findVisibleBlockedPackage(engine: LocalStateEngine, nowMs: Long): String? {
            val svc = instance ?: return null
            if (!engine.isActivelyGuarding(nowMs)) return null
            val ownPkg = svc.packageName

            runCatching {
                val winList = svc.windows ?: emptyList()
                for (w in winList) {
                    if (w.type != AccessibilityWindowInfo.TYPE_APPLICATION) continue
                    val root = runCatching { w.root }.getOrNull() ?: continue
                    val pkg = root.packageName?.toString()
                    if (!pkg.isNullOrBlank() && pkg != ownPkg && engine.shouldBlockPackage(pkg, nowMs)) {
                        return pkg
                    }
                }
            }

            runCatching {
                val pkg = svc.rootInActiveWindow?.packageName?.toString()
                if (!pkg.isNullOrBlank() && pkg != ownPkg && engine.shouldBlockPackage(pkg, nowMs)) {
                    return pkg
                }
            }
            return null
        }
    }

    private lateinit var engine: LocalStateEngine

    override fun onServiceConnected() {
        super.onServiceConnected()
        engine = LocalStateEngine.getInstance(this)
        instance = this
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        val now = System.currentTimeMillis()
        if (!::engine.isInitialized) {
            engine = LocalStateEngine.getInstance(this)
        }
        if (!engine.isActivelyGuarding(now)) return

        val evtPkg = event.packageName?.toString()
        val blockedPkg = when {
            !evtPkg.isNullOrBlank() && evtPkg != packageName && engine.shouldBlockPackage(evtPkg, now) -> evtPkg
            else -> findVisibleBlockedPackage(engine, now)
        }

        if (blockedPkg != null) {
            // 0ms 踢回桌面 + 立即拉起全屏拦截层
            performHomeIfConnected()
            AppMonitorService.notifyBlockedFromAccessibility(this, blockedPkg)
            return
        }

        // 若切到了非桌面的安全/豁免应用（例如来电界面、闹钟或已豁免微信），立即通知撤销拦截遮罩
        if (!evtPkg.isNullOrBlank() && event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            val ignore = InstalledAppScanner.getTransientSystemIgnorePackages(this)
            val launchers = InstalledAppScanner.getLauncherPackages(this)
            if (evtPkg !in ignore && evtPkg !in launchers && !engine.shouldBlockPackage(evtPkg, now)) {
                AppMonitorService.notifySafeAppEntered(evtPkg, now)
            }
        }
    }

    override fun onInterrupt() {
        // no-op
    }

    override fun onUnbind(intent: Intent?): Boolean {
        if (instance === this) instance = null
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }
}
