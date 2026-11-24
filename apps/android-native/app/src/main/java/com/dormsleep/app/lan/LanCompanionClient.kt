package com.dormsleep.app.lan

import com.dormsleep.app.crypto.DormSleepCrypto
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.UUID

data class DiscoveredCompanion(
    val host: String,
    val httpPort: Int,
    val desktopName: String,
    val pairId: String?,
)

/**
 * 与 Windows 本地伴随服务 (services/windows-companion/companion_server.py) 通信的局域网客户端：
 * 1. 多网卡定向广播 UDP 发现 (DORMSLEEP_DISCOVER_V1, 默认端口 41740)
 *    —— 专门适配 Android / HarmonyOS 手机开个人热点 (SoftAP) 场景：同时向热点子网定向广播并绑定本地网卡发送，
 *    避免 255.255.255.255 被系统默认路由误发往蜂窝移动网络。
 * 2. 支持手动填写电脑局域网地址 (IP:端口) 直连配对，彻底绕过校园网/防火墙拦截 UDP 广播的问题。
 * 3. HMAC-SHA256 签名心跳同步与在线校验。
 */
class LanCompanionClient(
    private val udpPort: Int = 41740,
) {
    fun parseManualEndpoint(rawInput: String?, defaultPort: Int = 4180): Pair<String, Int>? {
        val cleaned = rawInput?.trim()?.removePrefix("http://")?.removePrefix("https://")?.trimEnd('/') ?: return null
        if (cleaned.isBlank()) return null
        val hostPart = cleaned.substringBefore('/')
        return if (':' in hostPart) {
            val h = hostPart.substringBefore(':').trim()
            val p = hostPart.substringAfter(':').trim().toIntOrNull() ?: defaultPort
            if (h.isBlank()) null else (h to p)
        } else {
            hostPart to defaultPort
        }
    }

    private fun collectLocalBroadcastTargets(): List<Pair<InetAddress?, InetAddress>> {
        val targets = mutableListOf<Pair<InetAddress?, InetAddress>>()
        runCatching {
            val ifaces = NetworkInterface.getNetworkInterfaces() ?: return@runCatching
            while (ifaces.hasMoreElements()) {
                val iface = ifaces.nextElement()
                if (!iface.isUp || iface.isLoopback) continue
                for (ia in iface.interfaceAddresses) {
                    val addr = ia.address
                    if (addr is Inet4Address && !addr.isLoopbackAddress) {
                        val bcast = ia.broadcast
                        if (bcast != null) {
                            targets.add(addr to bcast)
                        }
                    }
                }
            }
        }
        runCatching {
            targets.add(null to InetAddress.getByName("255.255.255.255"))
        }
        return targets
    }

    fun discoverOnLan(timeoutMs: Int = 2000): DiscoveredCompanion? {
        val magic = "DORMSLEEP_DISCOVER_V1".toByteArray(StandardCharsets.UTF_8)
        val targets = collectLocalBroadcastTargets()

        // 1) 优先按每个本地 IPv4 网卡（含个人热点 SoftAP 网卡 wlan1/ap0）绑定源地址发定向广播
        val perSocketTimeout = (timeoutMs / maxOf(1, targets.size)).coerceIn(450, 900)
        for ((localAddr, bcastAddr) in targets) {
            val found = probeSingleTarget(magic, localAddr, bcastAddr, perSocketTimeout)
            if (found != null) return found
        }

        // 2) 兜底：单 socket 同时群发所有广播地址并等待响应
        return runCatching {
            DatagramSocket().use { sock ->
                sock.broadcast = true
                sock.soTimeout = timeoutMs.coerceAtLeast(1000)
                val seen = HashSet<String>()
                for ((_, bcastAddr) in targets) {
                    val ip = bcastAddr.hostAddress ?: continue
                    if (seen.add(ip)) {
                        runCatching {
                            sock.send(DatagramPacket(magic, magic.size, bcastAddr, udpPort))
                        }
                    }
                }
                receiveDiscoveryReply(sock)
            }
        }.getOrNull()
    }

    private fun probeSingleTarget(
        magic: ByteArray,
        localAddr: InetAddress?,
        bcastAddr: InetAddress,
        timeoutMs: Int,
    ): DiscoveredCompanion? {
        return runCatching {
            val sock = if (localAddr != null) DatagramSocket(0, localAddr) else DatagramSocket()
            sock.use {
                it.broadcast = true
                it.soTimeout = timeoutMs
                it.send(DatagramPacket(magic, magic.size, bcastAddr, udpPort))
                receiveDiscoveryReply(it)
            }
        }.getOrNull()
    }

    private fun receiveDiscoveryReply(sock: DatagramSocket): DiscoveredCompanion? {
        val buf = ByteArray(1024)
        val reply = DatagramPacket(buf, buf.size)
        sock.receive(reply)
        val obj = JSONObject(String(reply.data, 0, reply.length, StandardCharsets.UTF_8))
        if (obj.optString("service") != "DormSleepCompanion") return null
        return DiscoveredCompanion(
            host = reply.address.hostAddress ?: return null,
            httpPort = obj.getInt("httpPort"),
            desktopName = obj.optString("desktopName", "Windows 电脑"),
            pairId = if (obj.isNull("pairId")) null else obj.optString("pairId"),
        )
    }

    fun confirmPairing(baseUrl: String, pairCode: String, mobileName: String): JSONObject {
        val body = JSONObject()
            .put("pairCode", pairCode.trim().uppercase())
            .put("mobileName", mobileName)
        return postJson("$baseUrl/api/lan/v1/pair/confirm", body, null, null, "/api/lan/v1/pair/confirm")
    }

    fun sendHeartbeat(baseUrl: String, pairId: String, sharedSecret: String, snapshot: JSONObject): JSONObject {
        val path = "/api/lan/v1/phone/heartbeat"
        val body = JSONObject().put("snapshot", snapshot)
        return postJson("$baseUrl$path", body, pairId, sharedSecret, path)
    }

    fun verifyOnlineCode(
        baseUrl: String,
        pairId: String,
        sharedSecret: String,
        sessionId: String,
        requestId: String,
        actionType: String,
        targetAppId: String?,
        code: String,
    ): JSONObject {
        val path = "/api/lan/v1/emergency/verify-online"
        val body = JSONObject()
            .put("sessionId", sessionId)
            .put("requestId", requestId)
            .put("actionType", actionType)
            .put("targetAppId", targetAppId ?: JSONObject.NULL)
            .put("code", code)
        return postJson("$baseUrl$path", body, pairId, sharedSecret, path)
    }

    private fun postJson(
        urlStr: String,
        body: JSONObject,
        pairId: String?,
        sharedSecret: String?,
        signingPath: String,
    ): JSONObject {
        val bytes = body.toString().toByteArray(StandardCharsets.UTF_8)
        val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 3000
            readTimeout = 3500
            doOutput = true
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
            if (pairId != null && sharedSecret != null) {
                val ts = System.currentTimeMillis()
                val nonce = UUID.randomUUID().toString()
                val sig = DormSleepCrypto.signLanRequest(sharedSecret, pairId, ts, nonce, "POST", signingPath, bytes)
                setRequestProperty("X-DS-PairId", pairId)
                setRequestProperty("X-DS-Timestamp", ts.toString())
                setRequestProperty("X-DS-Nonce", nonce)
                setRequestProperty("X-DS-Signature", sig)
            }
        }
        conn.outputStream.use { it.write(bytes) }
        val stream = if (conn.responseCode in 200..299) conn.inputStream else conn.errorStream
        val text = stream?.bufferedReader(StandardCharsets.UTF_8)?.use { it.readText() } ?: "{}"
        return JSONObject(text)
    }
}
