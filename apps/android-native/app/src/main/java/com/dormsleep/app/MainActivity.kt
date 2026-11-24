package com.dormsleep.app

import android.annotation.SuppressLint
import android.app.AlarmManager
import android.app.AppOpsManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.os.Process
import android.provider.AlarmClock
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import com.dormsleep.app.data.LocalStateEngine
import com.dormsleep.app.lan.LanSyncManager
import com.dormsleep.app.restriction.AppMonitorService
import com.dormsleep.app.restriction.DormSleepAccessibilityService
import com.dormsleep.app.restriction.InstalledAppScanner
import com.dormsleep.app.scheduler.SleepAlarmScheduler
import com.dormsleep.app.security.KeystoreSecretStore
import org.json.JSONObject

/**
 * Android 主界面容器：
 * 1. 与 AppMonitorService 共享 LocalStateEngine 进程级单例；
 * 2. 拦截页打开时接管系统返回键（直接回桌面，防止按返回绕过回到受限应用）；
 * 3. 通过 MobileJsBridge 暴露真实已装应用扫描、限制模式与锁机防绕过开关。
 */
class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private lateinit var engine: LocalStateEngine
    private lateinit var secretStore: KeystoreSecretStore
    private lateinit var lanSync: LanSyncManager

    @Volatile
    var currentBlockedPkg: String? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        engine = LocalStateEngine.getInstance(this)
        secretStore = KeystoreSecretStore(this)
        handleIncomingBlockedIntent(intent)

        lanSync = LanSyncManager(
            engine = engine,
            secretStore = secretStore,
            permissionsProvider = { readRealPermissions() },
            onConnectivityChanged = { notifyWebStateChanged() },
        )

        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (currentBlockedPkg != null || engine.isActivelyGuarding()) {
                        // 锁机拦截时按返回直接回手机桌面，绝不退回受限应用
                        goToHomeScreen()
                    } else {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                        isEnabled = true
                    }
                }
            },
        )

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            setBackgroundColor(0xFF080B1A.toInt())
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                    val orig = request.url
                    if (orig.host == "appassets.androidplatform.net") {
                        val path = orig.path ?: "/"
                        val remapped = if (path.startsWith("/www/")) orig
                        else orig.buildUpon().path("/www$path").build()
                        return assetLoader.shouldInterceptRequest(remapped)
                    }
                    return super.shouldInterceptRequest(view, request)
                }
            }
            addJavascriptInterface(
                MobileJsBridge(this@MainActivity, engine, secretStore, lanSync),
                "DormSleepNative",
            )
            loadUrl("https://appassets.androidplatform.net/mobile/index.html")
        }
        setContentView(webView)

        lanSync.start()
        SleepAlarmScheduler.rescheduleFromState(this)
        ensureMonitorServiceRunningIfPermitted()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIncomingBlockedIntent(intent)
        notifyWebStateChanged()
    }

    private fun handleIncomingBlockedIntent(intent: Intent?) {
        val pkg = intent?.getStringExtra("blocked_pkg")
        currentBlockedPkg = pkg
        if (!pkg.isNullOrBlank() && pkg !in InstalledAppScanner.GUARDED_SETTINGS_PKGS && engine.isActivelyGuarding()) {
            engine.switchEmergencyRequest("TEMP_ALLOW_15M", pkg)
        }
    }

    fun goToHomeScreen() {
        currentBlockedPkg = null
        val home = Intent(Intent.ACTION_MAIN).apply {
            addCategory(Intent.CATEGORY_HOME)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        runCatching { startActivity(home) }
        notifyWebStateChanged()
    }

    override fun onResume() {
        super.onResume()
        lanSync.triggerImmediateSync()
        ensureMonitorServiceRunningIfPermitted()
        notifyWebStateChanged()
    }

    override fun onDestroy() {
        lanSync.stop()
        super.onDestroy()
    }

    fun readRealPermissions(): JSONObject {
        val appOps = getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        val usageMode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            appOps.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), packageName)
        } else {
            @Suppress("DEPRECATION")
            appOps.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), packageName)
        }
        val am = getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val exactAlarmOk = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms()
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        val batteryOk = pm.isIgnoringBatteryOptimizations(packageName)

        return JSONObject()
            .put("usageStats", usageMode == AppOpsManager.MODE_ALLOWED)
            .put("overlay", Settings.canDrawOverlays(this))
            .put("exactAlarm", exactAlarmOk)
            .put("batteryIgnore", batteryOk)
            .put("accessibilityGuard", DormSleepAccessibilityService.isServiceConnected())
    }

    fun ensureMonitorServiceRunningIfPermitted() {
        val p = readRealPermissions()
        if (p.getBoolean("usageStats") && p.getBoolean("overlay")) {
            val svc = Intent(this, AppMonitorService::class.java)
            runCatching {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(svc)
                else startService(svc)
            }
        }
    }

    fun notifyWebStateChanged() {
        webView.post {
            webView.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('dormsleep:native-state'));",
                null,
            )
        }
    }
}

class MobileJsBridge(
    private val activity: MainActivity,
    private val engine: LocalStateEngine,
    private val secretStore: KeystoreSecretStore,
    private val lanSync: LanSyncManager,
) {
    @JavascriptInterface
    fun invoke(method: String, payloadJson: String): String {
        val payload = runCatching { JSONObject(payloadJson) }.getOrElse { JSONObject() }
        val result: JSONObject = when (method) {
            "getState" -> engine.buildWebViewStatePayload(
                permissions = activity.readRealPermissions(),
                lanConnected = lanSync.isLanConnected,
                blockedPkg = activity.currentBlockedPkg,
            )

            "confirmPairing" -> {
                val res = lanSync.confirmPairingBlocking(
                    pairCode = payload.optString("pairCode", ""),
                    mobileName = "${Build.MANUFACTURER} ${Build.MODEL}",
                    manualAddress = payload.optString("companionAddress", "").ifBlank { null },
                )
                activity.notifyWebStateChanged()
                res
            }

            "unbindPairing" -> {
                val res = engine.unbindPairing(payload.optBoolean("lostPc", false))
                if (res.optBoolean("ok") && !res.optBoolean("deferred")) {
                    secretStore.clear()
                }
                lanSync.triggerImmediateSync()
                res
            }

            "completeOnboarding" -> {
                engine.completeOnboarding(payload.optBoolean("morningChecklistConfirmed", true))
                activity.ensureMonitorServiceRunningIfPermitted()
                lanSync.triggerImmediateSync()
                JSONObject().put("ok", true)
            }

            "updateSchedule" -> {
                val res = engine.updateSchedule(
                    schoolNight = payload.getJSONObject("schoolNight"),
                    weekendNight = payload.getJSONObject("weekendNight"),
                    preReminderMinutes = payload.optInt("preReminderMinutes", 10),
                )
                SleepAlarmScheduler.rescheduleFromState(activity)
                activity.ensureMonitorServiceRunningIfPermitted()
                lanSync.triggerImmediateSync()
                res
            }

            "applyTonightOverride" -> {
                val res = engine.applyTonightOverride(
                    mode = payload.optString("mode", ""),
                    start = if (payload.isNull("start")) null else payload.optString("start"),
                    end = if (payload.isNull("end")) null else payload.optString("end"),
                )
                SleepAlarmScheduler.rescheduleFromState(activity)
                activity.ensureMonitorServiceRunningIfPermitted()
                lanSync.triggerImmediateSync()
                res
            }

            "startDaytimeTrial" -> {
                val res = engine.startDaytimeTrial()
                SleepAlarmScheduler.rescheduleFromState(activity)
                activity.ensureMonitorServiceRunningIfPermitted()
                lanSync.triggerImmediateSync()
                res
            }

            "skipDaytimeTrial" -> {
                val res = engine.skipDaytimeTrial()
                lanSync.triggerImmediateSync()
                res
            }

            "updateAppLists" -> {
                val rArr = payload.optJSONArray("restrictedAppIds")
                val eArr = payload.optJSONArray("exemptAppIds")
                val rList = if (rArr == null) emptyList() else List(rArr.length()) { rArr.getString(it) }
                val eList = if (eArr == null) emptyList() else List(eArr.length()) { eArr.getString(it) }
                val res = engine.updateAppLists(rList, eList)
                activity.ensureMonitorServiceRunningIfPermitted()
                lanSync.triggerImmediateSync()
                res
            }

            "updateGuardOptions" -> {
                val mode = if (payload.has("restrictionMode") && !payload.isNull("restrictionMode")) {
                    payload.optString("restrictionMode")
                } else null
                val blockSettings = if (payload.has("blockSettingsDuringLock") && !payload.isNull("blockSettingsDuringLock")) {
                    payload.optBoolean("blockSettingsDuringLock")
                } else null
                val res = engine.updateGuardOptions(mode, blockSettings)
                activity.ensureMonitorServiceRunningIfPermitted()
                lanSync.triggerImmediateSync()
                res
            }

            "requestNativePermissions" -> {
                openMissingPermissionSettings(payload)
                JSONObject().put("ok", true)
            }

            "launchEssentialApp" -> {
                val appId = if (payload.isNull("appId")) null else payload.optString("appId")
                if (appId.isNullOrBlank()) {
                    activity.goToHomeScreen()
                } else {
                    launchSafePackage(appId)
                }
                JSONObject().put("ok", true)
            }

            "prepareEmergencyRequest" -> {
                val res = engine.switchEmergencyRequest(
                    actionType = payload.optString("actionType", "TEMP_ALLOW_15M"),
                    targetAppId = if (payload.isNull("targetAppId")) null else payload.optString("targetAppId"),
                )
                lanSync.triggerImmediateSync()
                res
            }

            "verifyEmergencyCode" -> verifyOnlineThenOffline(payload.optString("code", ""))

            "relockEarly" -> {
                val res = engine.relockEarly()
                SleepAlarmScheduler.rescheduleFromState(activity)
                activity.ensureMonitorServiceRunningIfPermitted()
                lanSync.triggerImmediateSync()
                res
            }

            else -> JSONObject().put("ok", false).put("errorCode", "UNKNOWN_METHOD")
        }
        return result.toString()
    }

    private fun verifyOnlineThenOffline(code: String): JSONObject {
        val secret = secretStore.loadSharedSecret()
            ?: return JSONObject().put("ok", false).put("errorCode", "NOT_PAIRED")
        val snap = engine.buildLiveSnapshot(activity.readRealPermissions())
        val req = snap.optJSONObject("activeRequest")
            ?: return JSONObject().put("ok", false).put("errorCode", "SESSION_NOT_LOCKED")

        val onlineRes = lanSync.verifyOnlineIfReachableBlocking(
            sessionId = req.getString("sessionId"),
            requestId = req.getString("requestId"),
            actionType = req.getString("actionType"),
            targetAppId = if (req.isNull("targetAppId")) null else req.getString("targetAppId"),
            code = code,
        )

        val finalRes = when {
            onlineRes != null && onlineRes.optBoolean("ok") -> {
                engine.verifyOfflineOrApplyResult(code, secret, onlineAlreadyVerified = true)
            }
            onlineRes != null && onlineRes.optString("errorCode") in setOf("CODE_ALREADY_USED", "REQUEST_INVALIDATED", "REQUEST_MISMATCH") -> {
                engine.verifyOfflineOrApplyResult(code, secret, onlineAlreadyVerified = false, onlineErrorCode = onlineRes.optString("errorCode"))
            }
            else -> {
                engine.verifyOfflineOrApplyResult(code, secret, onlineAlreadyVerified = false)
            }
        }

        if (finalRes.optBoolean("ok")) {
            activity.currentBlockedPkg = null
            SleepAlarmScheduler.rescheduleFromState(activity)
            activity.ensureMonitorServiceRunningIfPermitted()
            lanSync.triggerImmediateSync()
        }
        return finalRes
    }

    private fun openMissingPermissionSettings(payload: JSONObject = JSONObject()) {
        if (payload.has("accessibilityGuard")) {
            runCatching {
                activity.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            }
            return
        }
        val perms = activity.readRealPermissions()
        val intent = when {
            !perms.getBoolean("usageStats") -> Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)
            !perms.getBoolean("overlay") -> Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:${activity.packageName}"),
            )
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !perms.getBoolean("exactAlarm") ->
                Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM)
            !perms.getBoolean("batteryIgnore") -> Intent(
                Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:${activity.packageName}"),
            )
            else -> null
        }
        if (intent != null) {
            runCatching { activity.startActivity(intent) }
        } else {
            activity.ensureMonitorServiceRunningIfPermitted()
        }
    }

    private fun launchSafePackage(appId: String) {
        val intent = when (appId) {
            "com.android.dialer" -> Intent(Intent.ACTION_DIAL)
            "com.android.mms" -> Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_APP_MESSAGING)
            "com.android.deskclock" -> Intent(AlarmClock.ACTION_SHOW_ALARMS)
            else -> activity.packageManager.getLaunchIntentForPackage(appId)
        }
        intent?.let {
            it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            activity.startActivity(it)
        }
    }
}
