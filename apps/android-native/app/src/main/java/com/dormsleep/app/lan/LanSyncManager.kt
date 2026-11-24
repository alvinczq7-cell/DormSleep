package com.dormsleep.app.lan

import com.dormsleep.app.data.LocalStateEngine
import com.dormsleep.app.security.KeystoreSecretStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * 后台局域网同步协调器：
 * - 周期性自动通过 UDP 发现 Windows 伴随服务并推送 HMAC 签名心跳
 * - 维护当前局域网在线标志（断连/AP 隔离自动切为 false，触发前端离线识别码提示）
 * - 提供在线优先 + 离线无缝降级的应急校验入口
 */
class LanSyncManager(
    private val engine: LocalStateEngine,
    private val secretStore: KeystoreSecretStore,
    private val permissionsProvider: () -> JSONObject,
    private val onConnectivityChanged: () -> Unit,
) {
    private val client = LanCompanionClient()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var heartbeatJob: Job? = null

    @Volatile
    var isLanConnected: Boolean = false
        private set

    @Volatile
    private var activeBaseUrl: String? = null

    fun start() {
        if (heartbeatJob?.isActive == true) return
        heartbeatJob = scope.launch {
            while (isActive) {
                syncOnce()
                delay(10_000L)
            }
        }
    }

    fun stop() {
        heartbeatJob?.cancel()
        heartbeatJob = null
    }

    fun triggerImmediateSync() {
        scope.launch { syncOnce() }
    }

    private fun resolveCompanionUrl(): String? {
        activeBaseUrl?.let { return it }
        val (savedHost, savedPort) = engine.getPairingEndpoint()
        if (!savedHost.isNullOrBlank()) {
            return "http://$savedHost:$savedPort".also { activeBaseUrl = it }
        }
        val found = client.discoverOnLan(timeoutMs = 1200)
        if (found != null) {
            return "http://${found.host}:${found.httpPort}".also { activeBaseUrl = it }
        }
        return null
    }

    fun confirmPairingBlocking(
        pairCode: String,
        mobileName: String,
        manualAddress: String? = null,
    ): JSONObject {
        val manual = client.parseManualEndpoint(manualAddress)
        val targetHost: String
        val targetPort: Int
        val fallbackName: String

        if (manual != null) {
            targetHost = manual.first
            targetPort = manual.second
            fallbackName = "Windows 宿舍电脑"
        } else {
            val discovered = client.discoverOnLan(timeoutMs = 2400)
                ?: return JSONObject().put("ok", false).put("errorCode", "PC_OFFLINE")
            targetHost = discovered.host
            targetPort = discovered.httpPort
            fallbackName = discovered.desktopName
        }

        val baseUrl = "http://$targetHost:$targetPort"
        val res = runCatching { client.confirmPairing(baseUrl, pairCode, mobileName) }
            .getOrElse { return JSONObject().put("ok", false).put("errorCode", "PC_OFFLINE") }

        if (res.optBoolean("ok")) {
            val pairId = res.getString("pairId")
            val secret = res.getString("sharedSecret")
            val desktopName = res.optString("desktopName", fallbackName)
            secretStore.saveSharedSecret(secret)
            engine.savePairing(pairId, desktopName, targetHost, targetPort)
            activeBaseUrl = baseUrl
            setConnected(true)
            triggerImmediateSync()
        }
        return res
    }

    fun verifyOnlineIfReachableBlocking(
        sessionId: String,
        requestId: String,
        actionType: String,
        targetAppId: String?,
        code: String,
    ): JSONObject? {
        val pairId = engine.getPairId() ?: return null
        val secret = secretStore.loadSharedSecret() ?: return null
        val baseUrl = resolveCompanionUrl() ?: return null
        return runCatching {
            client.verifyOnlineCode(baseUrl, pairId, secret, sessionId, requestId, actionType, targetAppId, code)
                .also { setConnected(true) }
        }.getOrElse {
            activeBaseUrl = null
            setConnected(false)
            null
        }
    }

    private fun syncOnce() {
        val pairId = engine.getPairId()
        val secret = secretStore.loadSharedSecret()
        if (pairId.isNullOrBlank() || secret.isNullOrBlank()) {
            setConnected(false)
            return
        }
        val baseUrl = resolveCompanionUrl()
        if (baseUrl == null) {
            setConnected(false)
            return
        }
        val snap = engine.buildLiveSnapshot(permissionsProvider())
        val ok = runCatching {
            val res = client.sendHeartbeat(baseUrl, pairId, secret, snap)
            res.optBoolean("ok", false)
        }.getOrElse { false }

        if (!ok) {
            // 下次重试重新通过 UDP 发现（防止笔记本 DHCP 换 IP）
            activeBaseUrl = null
        }
        setConnected(ok)
    }

    private fun setConnected(next: Boolean) {
        if (isLanConnected != next) {
            isLanConnected = next
            onConnectivityChanged()
        }
    }
}
