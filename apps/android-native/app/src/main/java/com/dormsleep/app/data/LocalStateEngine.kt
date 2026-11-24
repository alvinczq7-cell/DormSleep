package com.dormsleep.app.data

import android.content.Context
import com.dormsleep.app.crypto.DormSleepCrypto
import com.dormsleep.app.restriction.InstalledAppScanner
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/**
 * Android 手机端本地权威状态机与持久化存储（进程级单例 Source of Truth）。
 * 彻底修复 MainActivity 与 AppMonitorService 各自持有一份内存状态导致锁机不拦截的问题！
 * 完整支持：
 * - 真实已安装应用扫描与未装假应用自动清理
 * - 限制模式可随时切换：WHITELIST_ALL（默认严格白名单：除必用与豁免外全部拦截） / BLACKLIST_SELECTED（仅拦勾选应用）
 * - 锁机期防绕过保护可随时开关：blockSettingsDuringLock（默认开启：锁机期拦截系统设置/手机管家/卸载器）
 */
class LocalStateEngine private constructor(private val appContext: Context) {
    private val stateFile = File(appContext.filesDir, "dormsleep_state.json")
    private val lock = Any()

    companion object {
        const val MODE_WHITELIST_ALL = "WHITELIST_ALL"
        const val MODE_BLACKLIST_SELECTED = "BLACKLIST_SELECTED"

        const val TEMP_ALLOW_MS = 20 * 60 * 1000L
        const val FREEZE_BEFORE_MS = 30 * 60 * 1000L
        const val TRIAL_DURATION_MS = 3 * 60 * 1000L
        const val LOST_PC_COOLDOWN_MS = 24 * 3600 * 1000L

        @Volatile
        private var INSTANCE: LocalStateEngine? = null

        fun getInstance(context: Context): LocalStateEngine {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: LocalStateEngine(context.applicationContext).also { INSTANCE = it }
            }
        }
    }

    private var state: JSONObject = loadOrInit()

    private fun loadOrInit(): JSONObject {
        val loaded = if (stateFile.isFile) {
            runCatching {
                val parsed = JSONObject(stateFile.readText(Charsets.UTF_8))
                if (parsed.optInt("version", 0) == 2) parsed else null
            }.getOrNull()
        } else null

        val st = loaded ?: buildDefaultState(System.currentTimeMillis())
        val migrated = migrateAndPruneInstalledAppsUnlocked(st)
        if (loaded == null || migrated) {
            saveUnlocked(st)
        }
        return st
    }

    /**
     * 补齐新版本 guardOptions 字段，并清理旧版本写死的未安装假包名（如手机未装王者荣耀则自动剔除）。
     */
    private fun migrateAndPruneInstalledAppsUnlocked(st: JSONObject): Boolean {
        var dirty = false
        if (!st.has("guardOptions") || st.isNull("guardOptions")) {
            st.put(
                "guardOptions",
                JSONObject()
                    .put("restrictionMode", MODE_WHITELIST_ALL)
                    .put("blockSettingsDuringLock", true),
            )
            dirty = true
        } else {
            val go = st.getJSONObject("guardOptions")
            if (!go.has("restrictionMode")) {
                go.put("restrictionMode", MODE_WHITELIST_ALL)
                dirty = true
            }
            if (!go.has("blockSettingsDuringLock")) {
                go.put("blockSettingsDuringLock", true)
                dirty = true
            }
        }

        val installedSet = InstalledAppScanner.getInstalledPackageSet(appContext)
        if (installedSet.isNotEmpty()) {
            val apps = st.getJSONObject("apps")
            val ns = st.getJSONObject("nightSession")

            fun pruneArr(arr: JSONArray): Pair<JSONArray, Boolean> {
                val next = JSONArray()
                var changed = false
                for (i in 0 until arr.length()) {
                    val pkg = arr.getString(i)
                    if (pkg in installedSet) next.put(pkg)
                    else changed = true
                }
                return next to changed
            }

            val (prunedR, c1) = pruneArr(apps.getJSONArray("restrictedAppIds"))
            val (prunedE, c2) = pruneArr(apps.getJSONArray("exemptAppIds"))
            val (prunedEffR, c3) = pruneArr(ns.getJSONArray("effectiveRestrictedAppIds"))
            val (prunedEffE, c4) = pruneArr(ns.getJSONArray("effectiveExemptAppIds"))

            if (c1 || c2 || c3 || c4) {
                val finalR = if (prunedR.length() > 0) prunedR else JSONArray(InstalledAppScanner.getDefaultInstalledRestricted(appContext))
                val finalEffR = if (prunedEffR.length() > 0) prunedEffR else JSONArray(toStringList(finalR))
                apps.put("restrictedAppIds", finalR)
                apps.put("exemptAppIds", prunedE)
                ns.put("effectiveRestrictedAppIds", finalEffR)
                ns.put("effectiveExemptAppIds", prunedEffE)
                dirty = true
            }
        }
        return dirty
    }

    private fun saveUnlocked(obj: JSONObject = state) {
        val tmp = File(stateFile.parentFile, "dormsleep_state.tmp")
        tmp.writeText(obj.toString(2), Charsets.UTF_8)
        tmp.renameTo(stateFile)
    }

    fun inferNightKey(nowMs: Long): String {
        val cal = Calendar.getInstance().apply { timeInMillis = nowMs }
        if (cal.get(Calendar.HOUR_OF_DAY) < 12) {
            cal.add(Calendar.DAY_OF_YEAR, -1)
        }
        return SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date(cal.timeInMillis))
    }

    private fun nextNightKey(nightKey: String): String {
        val fmt = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        val cal = Calendar.getInstance().apply {
            time = fmt.parse(nightKey) ?: Date()
            add(Calendar.DAY_OF_YEAR, 1)
        }
        return fmt.format(cal.time)
    }

    private fun isWeekendNight(nightKey: String): Boolean {
        val fmt = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        val cal = Calendar.getInstance().apply { time = fmt.parse(nightKey) ?: Date() }
        val dow = cal.get(Calendar.DAY_OF_WEEK)
        return dow == Calendar.FRIDAY || dow == Calendar.SATURDAY
    }

    private fun parseHm(hm: String): Pair<Int, Int> {
        val parts = hm.trim().split(":")
        require(parts.size == 2) { "时间格式必须为 HH:MM" }
        val h = parts[0].toInt()
        val m = parts[1].toInt()
        require(h in 0..23 && m in 0..59) { "时间范围无效" }
        return h to m
    }

    private fun computeWindowForNight(nightKey: String, startHm: String, endHm: String): Pair<Long, Long> {
        val fmt = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        val base = fmt.parse(nightKey) ?: Date()
        val (sh, sm) = parseHm(startHm)
        val (eh, em) = parseHm(endHm)

        val startCal = Calendar.getInstance().apply {
            time = base
            set(Calendar.HOUR_OF_DAY, sh)
            set(Calendar.MINUTE, sm)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
            if (sh < 12) add(Calendar.DAY_OF_YEAR, 1)
        }
        val endCal = Calendar.getInstance().apply {
            time = base
            set(Calendar.HOUR_OF_DAY, eh)
            set(Calendar.MINUTE, em)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
            if (timeInMillis <= startCal.timeInMillis) add(Calendar.DAY_OF_YEAR, 1)
        }
        return startCal.timeInMillis to endCal.timeInMillis
    }

    private fun activePlanForNight(sched: JSONObject, nightKey: String): JSONObject {
        return if (isWeekendNight(nightKey)) sched.getJSONObject("weekendNight")
        else sched.getJSONObject("schoolNight")
    }

    private fun computeNextRegularResumeAtUnlocked(currentNk: String): Long {
        val nxt = nextNightKey(currentNk)
        val pendingSched = state.getJSONObject("pendingNextNight").optJSONObject("schedule")
        val sched = pendingSched ?: state.getJSONObject("schedule")
        val plan = activePlanForNight(sched, nxt)
        return computeWindowForNight(nxt, plan.getString("start"), plan.getString("end")).first
    }

    private fun buildDefaultState(nowMs: Long): JSONObject {
        val nk = inferNightKey(nowMs)
        val schedule = JSONObject().apply {
            put("schoolNight", JSONObject().put("enabled", true).put("start", "23:30").put("end", "07:00"))
            put("weekendNight", JSONObject().put("enabled", true).put("start", "00:30").put("end", "09:00"))
            put("preReminderMinutes", 10)
        }
        val plan = activePlanForNight(schedule, nk)
        val (baseStart, baseEnd) = computeWindowForNight(nk, plan.getString("start"), plan.getString("end"))
        val realRestricted = InstalledAppScanner.getDefaultInstalledRestricted(appContext)
        val realExempt = InstalledAppScanner.getDefaultInstalledExempt(appContext)

        return JSONObject().apply {
            put("version", 2)
            put("guardOptions", JSONObject().apply {
                put("restrictionMode", MODE_WHITELIST_ALL)
                put("blockSettingsDuringLock", true)
            })
            put("pairing", JSONObject().apply {
                put("status", "UNPAIRED")
                put("pairId", JSONObject.NULL)
                put("desktopName", "Windows 宿舍笔记本")
                put("pairedAt", JSONObject.NULL)
                put("lostPcUnbindRequestedAt", JSONObject.NULL)
                put("lostPcUnbindEffectiveAt", JSONObject.NULL)
                put("companionHost", JSONObject.NULL)
                put("companionPort", 4180)
            })
            put("onboarding", JSONObject().apply {
                put("completed", false)
                put("trialCompleted", false)
                put("trialSkipped", false)
                put("morningChecklistConfirmed", false)
            })
            put("schedule", schedule)
            put("apps", JSONObject().apply {
                put("restrictedAppIds", JSONArray(realRestricted))
                put("exemptAppIds", JSONArray(realExempt))
            })
            put("pendingNextNight", JSONObject().apply {
                put("schedule", JSONObject.NULL)
                put("restrictedAppIds", JSONObject.NULL)
                put("exemptAppIds", JSONObject.NULL)
            })
            put("tonightOverride", JSONObject.NULL)
            put("nightSession", JSONObject().apply {
                put("nightKey", nk)
                put("sessionId", "night:$nk")
                put("baselineStartAt", baseStart)
                put("baselineEndAt", baseEnd)
                put("freezeCutoffAt", baseStart - FREEZE_BEFORE_MS)
                put("startAt", baseStart)
                put("endAt", baseEnd)
                put("enabled", plan.getBoolean("enabled"))
                put("effectiveRestrictedAppIds", JSONArray(realRestricted))
                put("effectiveExemptAppIds", JSONArray(realExempt))
                put("status", "IDLE")
                put("endedEarlyAt", JSONObject.NULL)
                put("naturalEndedAt", JSONObject.NULL)
                put("tempAllow", JSONObject.NULL)
            })
            put("trialSession", JSONObject.NULL)
            put("trialCounter", 0)
            put("emergency", JSONObject().apply {
                put("activeRequest", JSONObject.NULL)
                put("wrongAttempts", 0)
                put("cooldownUntil", JSONObject.NULL)
                put("consumedRequests", JSONArray())
                put("invalidatedRequests", JSONArray())
            })
            put("events", JSONArray())
        }
    }

    private fun logEventUnlocked(kind: String, message: String, nowMs: Long) {
        val events = state.getJSONArray("events")
        val next = JSONArray()
        next.put(
            JSONObject()
                .put("id", "evt_${nowMs}_${DormSleepCrypto.generateRequestId()}")
                .put("ts", nowMs)
                .put("kind", kind)
                .put("message", message)
        )
        for (i in 0 until minOf(events.length(), 79)) {
            next.put(events.getJSONObject(i))
        }
        state.put("events", next)
    }

    private fun toStringList(arr: JSONArray?): List<String> {
        if (arr == null) return emptyList()
        return List(arr.length()) { arr.getString(it) }
    }

    private fun rolloverNightIfNeededUnlocked(nowMs: Long): Boolean {
        val currentNk = inferNightKey(nowMs)
        val ns = state.getJSONObject("nightSession")
        if (ns.getString("nightKey") == currentNk) return false

        val pending = state.getJSONObject("pendingNextNight")
        pending.optJSONObject("schedule")?.let {
            state.put("schedule", it)
            pending.put("schedule", JSONObject.NULL)
        }
        pending.optJSONArray("restrictedAppIds")?.let {
            state.getJSONObject("apps").put("restrictedAppIds", it)
            pending.put("restrictedAppIds", JSONObject.NULL)
        }
        pending.optJSONArray("exemptAppIds")?.let {
            state.getJSONObject("apps").put("exemptAppIds", it)
            pending.put("exemptAppIds", JSONObject.NULL)
        }

        state.put("tonightOverride", JSONObject.NULL)

        val sched = state.getJSONObject("schedule")
        val plan = activePlanForNight(sched, currentNk)
        val (baseStart, baseEnd) = computeWindowForNight(currentNk, plan.getString("start"), plan.getString("end"))
        val apps = state.getJSONObject("apps")

        state.put("nightSession", JSONObject().apply {
            put("nightKey", currentNk)
            put("sessionId", "night:$currentNk")
            put("baselineStartAt", baseStart)
            put("baselineEndAt", baseEnd)
            put("freezeCutoffAt", baseStart - FREEZE_BEFORE_MS)
            put("startAt", baseStart)
            put("endAt", baseEnd)
            put("enabled", plan.getBoolean("enabled"))
            put("effectiveRestrictedAppIds", JSONArray(toStringList(apps.getJSONArray("restrictedAppIds"))))
            put("effectiveExemptAppIds", JSONArray(toStringList(apps.getJSONArray("exemptAppIds"))))
            put("status", "IDLE")
            put("endedEarlyAt", JSONObject.NULL)
            put("naturalEndedAt", JSONObject.NULL)
            put("tempAllow", JSONObject.NULL)
        })

        val em = state.getJSONObject("emergency")
        em.put("activeRequest", JSONObject.NULL)
        em.put("wrongAttempts", 0)
        em.put("cooldownUntil", JSONObject.NULL)
        logEventUnlocked("NIGHT_ROLLOVER", "进入新夜晚周期（$currentNk），待生效改动已自动应用。", nowMs)
        return true
    }

    fun isFrozenUnlocked(nowMs: Long): Boolean {
        val ns = state.getJSONObject("nightSession")
        val st = ns.getString("status")
        if (st == "LOCKED" || st == "TEMP_ALLOW") return true
        if (!ns.getBoolean("enabled")) return false
        if (st == "ENDED_EARLY" || st == "NATURAL_ENDED" || st == "PAUSED_TONIGHT") return false
        val cutoff = ns.getLong("freezeCutoffAt")
        val endAt = ns.getLong("endAt")
        return nowMs in cutoff until endAt
    }

    fun evaluate(nowMs: Long = System.currentTimeMillis()): JSONObject = synchronized(lock) {
        var changed = rolloverNightIfNeededUnlocked(nowMs)

        // 遗失电脑解绑冷却到期自动完成
        val pairing = state.getJSONObject("pairing")
        val unbindAt = pairing.optLong("lostPcUnbindEffectiveAt", 0L)
        if (unbindAt > 0L && nowMs >= unbindAt) {
            pairing.put("status", "UNPAIRED")
            pairing.put("pairId", JSONObject.NULL)
            pairing.put("pairedAt", JSONObject.NULL)
            pairing.put("lostPcUnbindRequestedAt", JSONObject.NULL)
            pairing.put("lostPcUnbindEffectiveAt", JSONObject.NULL)
            logEventUnlocked("PAIR_UNBOUND", "遗失电脑解绑冷却期已满，已完成解绑。", nowMs)
            changed = true
        }

        // 白天试锁状态推进
        val trial = state.optJSONObject("trialSession")
        if (trial != null) {
            val tAllow = trial.optJSONObject("tempAllow")
            if (tAllow != null && nowMs >= tAllow.getLong("expiresAt")) {
                trial.put("tempAllow", JSONObject.NULL)
                logEventUnlocked("TRIAL_ALLOW_EXPIRED", "白天试锁临时放行到期，已恢复拦截。", nowMs)
                changed = true
            }
            if (nowMs >= trial.getLong("endAt")) {
                invalidateActiveRequestUnlocked("试锁自然结束", nowMs)
                state.put("trialSession", JSONObject.NULL)
                state.getJSONObject("onboarding").put("trialCompleted", true)
                logEventUnlocked("TRIAL_ENDED", "白天试锁（3 分钟）已自动结束并恢复正常。", nowMs)
                changed = true
            } else {
                ensureActiveRequestUnlocked(trial.getString("sessionId"), trial.getLong("endAt"), "TEMP_ALLOW_15M", null, nowMs)
            }
        }

        // 正式夜晚状态机推进
        val ns = state.getJSONObject("nightSession")
        val ov = state.optJSONObject("tonightOverride")
        if (ov != null && ov.optString("mode") == "PAUSE_TONIGHT" && ov.optString("nightKey") == ns.getString("nightKey")) {
            if (ns.getString("status") != "PAUSED_TONIGHT") {
                ns.put("status", "PAUSED_TONIGHT")
                changed = true
            }
        } else if (!ns.getBoolean("enabled")) {
            if (ns.getString("status") != "IDLE") {
                ns.put("status", "IDLE")
                changed = true
            }
        } else {
            val st = ns.getString("status")
            val startAt = ns.getLong("startAt")
            val endAt = ns.getLong("endAt")
            val preMs = state.getJSONObject("schedule").getInt("preReminderMinutes") * 60 * 1000L

            if (st != "ENDED_EARLY" && st != "NATURAL_ENDED") {
                when {
                    nowMs >= endAt -> {
                        ns.put("status", "NATURAL_ENDED")
                        ns.put("naturalEndedAt", endAt)
                        ns.put("tempAllow", JSONObject.NULL)
                        invalidateActiveRequestUnlocked("锁定自然结束", nowMs)
                        logEventUnlocked("NATURAL_ENDED", "已到预设结束时间，限制自动解除。", nowMs)
                        changed = true
                    }
                    nowMs >= startAt -> {
                        val ta = ns.optJSONObject("tempAllow")
                        if (ta != null && nowMs >= ta.getLong("expiresAt")) {
                            ns.put("tempAllow", JSONObject.NULL)
                            ns.put("status", "LOCKED")
                            logEventUnlocked("TEMP_ALLOW_EXPIRED", "20 分钟临时放行到期，已自动恢复拦截。", nowMs)
                            changed = true
                        } else if (ta != null) {
                            if (st != "TEMP_ALLOW") {
                                ns.put("status", "TEMP_ALLOW")
                                changed = true
                            }
                        } else if (st != "LOCKED") {
                            ns.put("status", "LOCKED")
                            logEventUnlocked("LOCK_STARTED", "夜间限制自动生效（无需二次确认）。", nowMs)
                            changed = true
                        }
                        if (state.optJSONObject("trialSession") == null) {
                            ensureActiveRequestUnlocked(ns.getString("sessionId"), endAt, "TEMP_ALLOW_15M", null, nowMs)
                        }
                    }
                    nowMs >= startAt - preMs -> {
                        if (st != "PRE_LOCK_REMINDER") {
                            ns.put("status", "PRE_LOCK_REMINDER")
                            logEventUnlocked("PRE_LOCK_REMINDER", "睡前收尾提醒：即将自动进入夜间限制。", nowMs)
                            changed = true
                        }
                    }
                    else -> {
                        if (st != "IDLE") {
                            ns.put("status", "IDLE")
                            changed = true
                        }
                    }
                }
            }
        }

        if (changed) saveUnlocked()
        return JSONObject(state.toString())
    }

    fun isActivelyGuarding(nowMs: Long = System.currentTimeMillis()): Boolean = synchronized(lock) {
        evaluate(nowMs)
        val trial = state.optJSONObject("trialSession")
        if (trial != null) return true
        val st = state.getJSONObject("nightSession").getString("status")
        st == "LOCKED" || st == "TEMP_ALLOW"
    }

    /**
     * 核心拦截判定：
     * 1. 系统桌面、输入法、电话/短信/闹钟与本应用自身始终放行；
     * 2. 系统设置/手机管家/卸载器按 blockSettingsDuringLock 开关决定是否拦截；
     * 3. 当前 15 分钟临时放行的单应用、以及用户勾选的豁免应用放行；
     * 4. WHITELIST_ALL（默认严格白名单）下其余全部拦截；BLACKLIST_SELECTED 下仅拦截勾选应用。
     */
    fun shouldBlockPackage(pkg: String, nowMs: Long = System.currentTimeMillis()): Boolean = synchronized(lock) {
        evaluate(nowMs)
        val trial = state.optJSONObject("trialSession")
        val ns = state.getJSONObject("nightSession")
        val activeStatus = if (trial != null) "TRIAL_LOCKED" else ns.getString("status")
        if (activeStatus != "LOCKED" && activeStatus != "TEMP_ALLOW" && activeStatus != "TRIAL_LOCKED") {
            return false
        }

        // 1) 系统核心/电话/短信/闹钟/桌面/输入法/自身始终放行
        val alwaysSafe = InstalledAppScanner.getAlwaysSafeSystemPackages(appContext)
        if (pkg in alwaysSafe) return false

        val go = state.getJSONObject("guardOptions")
        val blockSettings = go.optBoolean("blockSettingsDuringLock", true)

        // 2) 系统设置 / 手机管家 / 应用卸载器（由用户可随时切换的防绕过开关控制）
        if (pkg in InstalledAppScanner.GUARDED_SETTINGS_PKGS) {
            return blockSettings
        }

        // 3) 15 分钟临时放行单应用放行
        val ta = trial?.optJSONObject("tempAllow") ?: ns.optJSONObject("tempAllow")
        if (ta != null && ta.optString("appId") == pkg && nowMs < ta.optLong("expiresAt", 0L)) {
            return false
        }

        // 4) 用户勾选的校园刚需豁免应用放行
        val exempt = toStringList(ns.getJSONArray("effectiveExemptAppIds"))
        if (pkg in exempt) return false

        // 5) 严格白名单模式 vs 仅拦指定应用模式
        val mode = go.optString("restrictionMode", MODE_WHITELIST_ALL)
        if (mode == MODE_WHITELIST_ALL) {
            return true
        }

        val restricted = toStringList(ns.getJSONArray("effectiveRestrictedAppIds"))
        return pkg in restricted
    }

    // ---------------- 业务写操作 ----------------

    fun updateGuardOptions(
        restrictionMode: String? = null,
        blockSettingsDuringLock: Boolean? = null,
        nowMs: Long = System.currentTimeMillis(),
    ): JSONObject = synchronized(lock) {
        evaluate(nowMs)
        val go = state.getJSONObject("guardOptions")
        if (restrictionMode == MODE_WHITELIST_ALL || restrictionMode == MODE_BLACKLIST_SELECTED) {
            go.put("restrictionMode", restrictionMode)
            logEventUnlocked(
                "GUARD_MODE_CHANGED",
                if (restrictionMode == MODE_WHITELIST_ALL) "已切换为「严格白名单模式」（除必用与豁免外全部拦截）。"
                else "已切换为「仅拦指定应用模式」。",
                nowMs,
            )
        }
        if (blockSettingsDuringLock != null) {
            go.put("blockSettingsDuringLock", blockSettingsDuringLock)
            logEventUnlocked(
                "SETTINGS_GUARD_CHANGED",
                if (blockSettingsDuringLock) "已开启锁机期防绕过保护（拦截系统设置与强停）。"
                else "已关闭锁机期系统设置保护。",
                nowMs,
            )
        }
        saveUnlocked()
        return JSONObject().put("ok", true).put("guardOptions", JSONObject(go.toString()))
    }

    fun savePairing(pairId: String, desktopName: String, host: String?, port: Int) = synchronized(lock) {
        val now = System.currentTimeMillis()
        state.getJSONObject("pairing").apply {
            put("status", "PAIRED")
            put("pairId", pairId)
            put("desktopName", desktopName)
            put("pairedAt", now)
            put("lostPcUnbindRequestedAt", JSONObject.NULL)
            put("lostPcUnbindEffectiveAt", JSONObject.NULL)
            put("companionHost", host ?: JSONObject.NULL)
            put("companionPort", port)
        }
        logEventUnlocked("PAIR_CONFIRMED", "已与 $desktopName 配对成功。", now)
        saveUnlocked()
    }

    fun getPairingEndpoint(): Pair<String?, Int> = synchronized(lock) {
        val p = state.getJSONObject("pairing")
        val host = if (p.isNull("companionHost")) null else p.optString("companionHost")
        host to p.optInt("companionPort", 4180)
    }

    fun getPairId(): String? = synchronized(lock) {
        val p = state.getJSONObject("pairing")
        if (p.isNull("pairId")) null else p.optString("pairId")
    }

    fun unbindPairing(lostPc: Boolean, nowMs: Long = System.currentTimeMillis()): JSONObject = synchronized(lock) {
        evaluate(nowMs)
        val ns = state.getJSONObject("nightSession")
        val inLock = state.optJSONObject("trialSession") != null || ns.getString("status") in setOf("LOCKED", "TEMP_ALLOW")
        val p = state.getJSONObject("pairing")
        if (inLock) {
            val effectiveAt = if (lostPc) nowMs + LOST_PC_COOLDOWN_MS else minOf(nowMs + LOST_PC_COOLDOWN_MS, ns.getLong("endAt"))
            p.put("lostPcUnbindRequestedAt", nowMs)
            p.put("lostPcUnbindEffectiveAt", effectiveAt)
            logEventUnlocked("PAIR_UNBIND_COOLDOWN", "锁定期间发起遗失解绑，进入 24 小时冷却。", nowMs)
            saveUnlocked()
            return JSONObject().put("ok", true).put("deferred", true).put("effectiveAt", effectiveAt)
        } else {
            p.put("status", "UNPAIRED")
            p.put("pairId", JSONObject.NULL)
            p.put("pairedAt", JSONObject.NULL)
            p.put("lostPcUnbindRequestedAt", JSONObject.NULL)
            p.put("lostPcUnbindEffectiveAt", JSONObject.NULL)
            logEventUnlocked("PAIR_UNBOUND", "已解除电脑配对。", nowMs)
            saveUnlocked()
            return JSONObject().put("ok", true).put("deferred", false)
        }
    }

    fun completeOnboarding(morningChecklistConfirmed: Boolean) = synchronized(lock) {
        val ob = state.getJSONObject("onboarding")
        ob.put("completed", true)
        ob.put("morningChecklistConfirmed", morningChecklistConfirmed)
        saveUnlocked()
    }

    fun updateSchedule(schoolNight: JSONObject, weekendNight: JSONObject, preReminderMinutes: Int, nowMs: Long = System.currentTimeMillis()): JSONObject =
        synchronized(lock) {
            evaluate(nowMs)
            parseHm(schoolNight.getString("start"))
            parseHm(schoolNight.getString("end"))
            parseHm(weekendNight.getString("start"))
            parseHm(weekendNight.getString("end"))

            val newSched = JSONObject()
                .put("schoolNight", JSONObject()
                    .put("enabled", schoolNight.getBoolean("enabled"))
                    .put("start", schoolNight.getString("start"))
                    .put("end", schoolNight.getString("end")))
                .put("weekendNight", JSONObject()
                    .put("enabled", weekendNight.getBoolean("enabled"))
                    .put("start", weekendNight.getString("start"))
                    .put("end", weekendNight.getString("end")))
                .put("preReminderMinutes", preReminderMinutes.coerceIn(1, 30))

            val deferred = if (isFrozenUnlocked(nowMs)) {
                state.getJSONObject("pendingNextNight").put("schedule", newSched)
                logEventUnlocked("SCHEDULE_DEFERRED", "冻结期内修改常规计划，将于下一晚生效。", nowMs)
                true
            } else {
                state.put("schedule", newSched)
                state.getJSONObject("pendingNextNight").put("schedule", JSONObject.NULL)
                val ns = state.getJSONObject("nightSession")
                if (state.isNull("tonightOverride")) {
                    val plan = activePlanForNight(newSched, ns.getString("nightKey"))
                    val (sAt, eAt) = computeWindowForNight(ns.getString("nightKey"), plan.getString("start"), plan.getString("end"))
                    ns.put("startAt", sAt).put("endAt", eAt).put("enabled", plan.getBoolean("enabled"))
                    ns.put("freezeCutoffAt", minOf(ns.getLong("freezeCutoffAt"), sAt - FREEZE_BEFORE_MS))
                }
                logEventUnlocked("SCHEDULE_UPDATED", "常规就寝计划已更新。", nowMs)
                false
            }
            evaluate(nowMs)
            saveUnlocked()
            return JSONObject().put("ok", true).put("deferredToNextNight", deferred)
        }

    fun applyTonightOverride(mode: String, start: String?, end: String?, nowMs: Long = System.currentTimeMillis()): JSONObject =
        synchronized(lock) {
            evaluate(nowMs)
            if (isFrozenUnlocked(nowMs)) {
                return JSONObject().put("ok", false).put("errorCode", "FROZEN_MODIFICATION")
            }
            val ns = state.getJSONObject("nightSession")
            val nk = ns.getString("nightKey")
            val nextResume = computeNextRegularResumeAtUnlocked(nk)

            when (mode) {
                "CLEAR" -> {
                    state.put("tonightOverride", JSONObject.NULL)
                    val plan = activePlanForNight(state.getJSONObject("schedule"), nk)
                    val (sAt, eAt) = computeWindowForNight(nk, plan.getString("start"), plan.getString("end"))
                    ns.put("startAt", sAt).put("endAt", eAt).put("enabled", plan.getBoolean("enabled"))
                    if (ns.getString("status") == "PAUSED_TONIGHT") ns.put("status", "IDLE")
                    logEventUnlocked("TONIGHT_OVERRIDE_CLEARED", "已撤销仅改今晚，恢复常规计划。", nowMs)
                }
                "PAUSE_TONIGHT" -> {
                    state.put("tonightOverride", JSONObject()
                        .put("nightKey", nk)
                        .put("mode", "PAUSE_TONIGHT")
                        .put("start", JSONObject.NULL)
                        .put("end", JSONObject.NULL)
                        .put("createdAt", nowMs)
                        .put("nextRegularResumeAt", nextResume))
                    ns.put("status", "PAUSED_TONIGHT")
                    logEventUnlocked("TONIGHT_PAUSED", "已暂停今晚一次，明晚自动恢复常规计划。", nowMs)
                }
                "CUSTOM_TIME" -> {
                    if (start.isNullOrBlank() || end.isNullOrBlank()) {
                        return JSONObject().put("ok", false).put("errorCode", "INVALID_TIME")
                    }
                    val (sAt, eAt) = computeWindowForNight(nk, start, end)
                    state.put("tonightOverride", JSONObject()
                        .put("nightKey", nk)
                        .put("mode", "CUSTOM_TIME")
                        .put("start", start)
                        .put("end", end)
                        .put("createdAt", nowMs)
                        .put("nextRegularResumeAt", nextResume))
                    ns.put("startAt", sAt).put("endAt", eAt).put("enabled", true)
                    ns.put("freezeCutoffAt", minOf(ns.getLong("freezeCutoffAt"), sAt - FREEZE_BEFORE_MS))
                    if (ns.getString("status") == "PAUSED_TONIGHT") ns.put("status", "IDLE")
                    logEventUnlocked("TONIGHT_CUSTOMIZED", "仅改今晚：$start–$end（截止修改时间不变）。", nowMs)
                }
                else -> return JSONObject().put("ok", false).put("errorCode", "INVALID_MODE")
            }
            evaluate(nowMs)
            saveUnlocked()
            return JSONObject().put("ok", true).put("nextRegularResumeAt", nextResume)
        }

    fun updateAppLists(restrictedIds: List<String>, exemptIds: List<String>, nowMs: Long = System.currentTimeMillis()): JSONObject =
        synchronized(lock) {
            evaluate(nowMs)
            val safeSystem = InstalledAppScanner.getAlwaysSafeSystemPackages(appContext)
            val cleanRestricted = restrictedIds.distinct().filter { it !in safeSystem }
            val cleanExempt = exemptIds.distinct().filter { it !in cleanRestricted }
            val ns = state.getJSONObject("nightSession")

            val deferred = if (isFrozenUnlocked(nowMs)) {
                val curEff = toStringList(ns.getJSONArray("effectiveRestrictedAppIds")).toSet()
                val newSet = cleanRestricted.toSet()
                val added = newSet - curEff
                val removed = curEff - newSet
                if (added.isNotEmpty()) {
                    ns.put("effectiveRestrictedAppIds", JSONArray((curEff + added).toList()))
                }
                val curEx = toStringList(ns.getJSONArray("effectiveExemptAppIds")).toSet()
                val newEx = cleanExempt.toSet()
                val addedEx = newEx - curEx   // 放宽限制：冻结期须顺延明晚
                val removedEx = curEx - newEx // 收紧限制：立即生效
                if (removedEx.isNotEmpty()) {
                    ns.put("effectiveExemptAppIds", JSONArray((curEx - removedEx).toList()))
                }
                if (removed.isNotEmpty() || addedEx.isNotEmpty()) {
                    state.getJSONObject("pendingNextNight")
                        .put("restrictedAppIds", JSONArray(cleanRestricted))
                        .put("exemptAppIds", JSONArray(cleanExempt))
                    logEventUnlocked("APPS_RELAX_DEFERRED", "冻结期内放宽应用限制将于下一晚生效。", nowMs)
                    true
                } else {
                    state.getJSONObject("apps")
                        .put("restrictedAppIds", JSONArray(cleanRestricted))
                        .put("exemptAppIds", JSONArray(cleanExempt))
                    state.getJSONObject("pendingNextNight")
                        .put("restrictedAppIds", JSONObject.NULL)
                        .put("exemptAppIds", JSONObject.NULL)
                    false
                }
            } else {
                state.getJSONObject("apps")
                    .put("restrictedAppIds", JSONArray(cleanRestricted))
                    .put("exemptAppIds", JSONArray(cleanExempt))
                ns.put("effectiveRestrictedAppIds", JSONArray(cleanRestricted))
                ns.put("effectiveExemptAppIds", JSONArray(cleanExempt))
                state.getJSONObject("pendingNextNight")
                    .put("restrictedAppIds", JSONObject.NULL)
                    .put("exemptAppIds", JSONObject.NULL)
                false
            }
            saveUnlocked()
            return JSONObject().put("ok", true).put("deferredToNextNight", deferred)
        }

    fun startDaytimeTrial(nowMs: Long = System.currentTimeMillis()): JSONObject = synchronized(lock) {
        val seq = state.optInt("trialCounter", 0) + 1
        state.put("trialCounter", seq)
        val sessId = "trial:$seq"
        val endAt = nowMs + TRIAL_DURATION_MS
        state.put("trialSession", JSONObject()
            .put("seq", seq)
            .put("sessionId", sessId)
            .put("startedAt", nowMs)
            .put("endAt", endAt)
            .put("tempAllow", JSONObject.NULL))
        invalidateActiveRequestUnlocked("开始白天试锁", nowMs)
        ensureActiveRequestUnlocked(sessId, endAt, "TEMP_ALLOW_15M", null, nowMs)
        logEventUnlocked("TRIAL_STARTED", "开始 3 分钟白天试锁。", nowMs)
        saveUnlocked()
        return JSONObject().put("ok", true).put("sessionId", sessId).put("endAt", endAt)
    }

    fun skipDaytimeTrial(nowMs: Long = System.currentTimeMillis()): JSONObject = synchronized(lock) {
        state.getJSONObject("onboarding").put("trialSkipped", true).put("completed", true)
        if (!state.isNull("trialSession")) {
            invalidateActiveRequestUnlocked("跳过试锁", nowMs)
            state.put("trialSession", JSONObject.NULL)
        }
        saveUnlocked()
        return JSONObject().put("ok", true)
    }

    fun switchEmergencyRequest(actionType: String, targetAppId: String?, nowMs: Long = System.currentTimeMillis()): JSONObject =
        synchronized(lock) {
            evaluate(nowMs)
            val trial = state.optJSONObject("trialSession")
            val ns = state.getJSONObject("nightSession")
            val sessionId: String
            val expiresAt: Long
            if (trial != null) {
                sessionId = trial.getString("sessionId")
                expiresAt = trial.getLong("endAt")
            } else if (ns.getString("status") in setOf("LOCKED", "TEMP_ALLOW")) {
                sessionId = ns.getString("sessionId")
                expiresAt = ns.getLong("endAt")
            } else {
                return JSONObject().put("ok", false).put("errorCode", "SESSION_NOT_LOCKED")
            }

            val normTarget = if (actionType == "END_TONIGHT") null else (targetAppId ?: firstRestrictedAppUnlocked())
            val cur = state.getJSONObject("emergency").optJSONObject("activeRequest")
            if (cur != null && cur.getString("sessionId") == sessionId &&
                cur.getString("actionType") == actionType &&
                (if (cur.isNull("targetAppId")) null else cur.getString("targetAppId")) == normTarget
            ) {
                return JSONObject().put("ok", true).put("request", cur).put("rotated", false)
            }
            invalidateActiveRequestUnlocked("切换操作或目标应用", nowMs)
            val req = rotateActiveRequestUnlocked(sessionId, expiresAt, actionType, normTarget, nowMs)
            logEventUnlocked("EMERGENCY_REQ_ROTATED", "应急请求已切换，旧码已作废，新识别号 ${req.getString("requestId")}。", nowMs)
            saveUnlocked()
            return JSONObject().put("ok", true).put("request", req).put("rotated", true)
        }

    fun verifyOfflineOrApplyResult(
        submittedCode: String,
        sharedSecret: String,
        onlineAlreadyVerified: Boolean = false,
        onlineErrorCode: String? = null,
        nowMs: Long = System.currentTimeMillis(),
    ): JSONObject = synchronized(lock) {
        evaluate(nowMs)
        val trial = state.optJSONObject("trialSession")
        val ns = state.getJSONObject("nightSession")
        if (trial == null && ns.getString("status") == "NATURAL_ENDED") {
            return JSONObject().put("ok", false).put("errorCode", "SESSION_ALREADY_ENDED")
        }
        if (trial == null && ns.getString("status") !in setOf("LOCKED", "TEMP_ALLOW")) {
            return JSONObject().put("ok", false).put("errorCode", "SESSION_NOT_LOCKED")
        }

        val em = state.getJSONObject("emergency")
        val cooldownUntil = em.optLong("cooldownUntil", 0L)
        if (cooldownUntil > 0L && nowMs < cooldownUntil) {
            return JSONObject().put("ok", false).put("errorCode", "COOLDOWN_ACTIVE").put("cooldownUntil", cooldownUntil)
        }

        val cur = em.optJSONObject("activeRequest")
            ?: return JSONObject().put("ok", false).put("errorCode", "SESSION_NOT_LOCKED")
        val pairId = getPairId() ?: return JSONObject().put("ok", false).put("errorCode", "NOT_PAIRED")

        val cleanCode = submittedCode.filter { it.isDigit() }
        val codeSha = if (cleanCode.length == 6) DormSleepCrypto.sha256Hex(cleanCode.toByteArray()) else ""

        val matched = if (onlineAlreadyVerified) {
            true
        } else if (onlineErrorCode in setOf("CODE_ALREADY_USED", "REQUEST_INVALIDATED", "REQUEST_MISMATCH")) {
            false
        } else {
            val expected = DormSleepCrypto.deriveOfflineEmergencyCode(
                sharedSecret = sharedSecret,
                pairId = pairId,
                sessionId = cur.getString("sessionId"),
                requestId = cur.getString("requestId"),
                actionType = cur.getString("actionType"),
                targetAppId = if (cur.isNull("targetAppId")) null else cur.getString("targetAppId"),
            )
            cleanCode.length == 6 && DormSleepCrypto.constantTimeEquals(cleanCode, expected)
        }

        if (!matched) {
            val errCode = onlineErrorCode ?: classifyFailureUnlocked(cleanCode, codeSha, sharedSecret, pairId)
            val wrongs = em.optInt("wrongAttempts", 0) + 1
            em.put("wrongAttempts", wrongs)
            if (wrongs >= 5) em.put("cooldownUntil", nowMs + 3 * 60 * 1000L)
            else if (wrongs == 3) em.put("cooldownUntil", nowMs + 30 * 1000L)
            logEventUnlocked("EMERGENCY_VERIFY_FAILED", "应急码校验失败（$errCode，第 $wrongs 次）。", nowMs)
            saveUnlocked()
            return JSONObject()
                .put("ok", false)
                .put("errorCode", errCode)
                .put("wrongAttempts", wrongs)
                .put("cooldownUntil", em.opt("cooldownUntil"))
        }

        val reqId = cur.getString("requestId")
        val sessId = cur.getString("sessionId")
        val actionType = cur.getString("actionType")
        val targetApp = if (cur.isNull("targetAppId")) null else cur.getString("targetAppId")
        val mode = if (onlineAlreadyVerified) "ONLINE" else "OFFLINE"

        val consumedArr = em.getJSONArray("consumedRequests")
        val newConsumed = JSONArray()
        newConsumed.put(
            JSONObject()
                .put("requestId", reqId)
                .put("sessionId", sessId)
                .put("actionType", actionType)
                .put("targetAppId", targetApp ?: JSONObject.NULL)
                .put("consumedAt", nowMs)
                .put("mode", mode)
                .put("codeSha", codeSha)
        )
        for (i in 0 until minOf(consumedArr.length(), 199)) newConsumed.put(consumedArr.getJSONObject(i))
        em.put("consumedRequests", newConsumed)
        em.put("wrongAttempts", 0)
        em.put("cooldownUntil", JSONObject.NULL)
        em.put("activeRequest", JSONObject.NULL)

        if (actionType == "TEMP_ALLOW_15M") {
            val endAt = trial?.getLong("endAt") ?: ns.getLong("endAt")
            val allowEnd = minOf(nowMs + TEMP_ALLOW_MS, endAt)
            val taObj = JSONObject()
                .put("appId", targetApp)
                .put("startedAt", nowMs)
                .put("expiresAt", allowEnd)
                .put("requestId", reqId)
            if (trial != null) {
                trial.put("tempAllow", taObj)
            } else {
                ns.put("tempAllow", taObj)
                ns.put("status", "TEMP_ALLOW")
            }
            val nextReq = rotateActiveRequestUnlocked(sessId, endAt, "TEMP_ALLOW_15M", targetApp, nowMs)
            val appName = targetApp?.let { InstalledAppScanner.resolveAppName(appContext, it) } ?: ""
            logEventUnlocked("TEMP_ALLOW_GRANTED", "临时放行 20 分钟生效（$mode）：$appName。", nowMs)
            saveUnlocked()
            return JSONObject()
                .put("ok", true)
                .put("mode", mode)
                .put("actionType", actionType)
                .put("targetAppId", targetApp)
                .put("expiresAt", allowEnd)
                .put("consumedRequestId", reqId)
                .put("nextRequestId", nextReq.getString("requestId"))
        } else {
            if (trial != null) {
                state.put("trialSession", JSONObject.NULL)
                state.getJSONObject("onboarding").put("trialCompleted", true)
            } else {
                ns.put("status", "ENDED_EARLY")
                ns.put("endedEarlyAt", nowMs)
                ns.put("tempAllow", JSONObject.NULL)
            }
            logEventUnlocked("ENDED_EARLY", "本次限制已提前结束（$mode）。", nowMs)
            saveUnlocked()
            return JSONObject()
                .put("ok", true)
                .put("mode", mode)
                .put("actionType", "END_TONIGHT")
                .put("consumedRequestId", reqId)
                .put("nextRegularResumeAt", computeNextRegularResumeAtUnlocked(ns.getString("nightKey")))
        }
    }

    fun relockEarly(nowMs: Long = System.currentTimeMillis()): JSONObject = synchronized(lock) {
        evaluate(nowMs)
        val trial = state.optJSONObject("trialSession")
        val ns = state.getJSONObject("nightSession")
        if (trial != null && !trial.isNull("tempAllow")) {
            trial.put("tempAllow", JSONObject.NULL)
        } else if (ns.getString("status") == "TEMP_ALLOW") {
            ns.put("tempAllow", JSONObject.NULL)
            ns.put("status", "LOCKED")
        } else if (ns.getString("status") == "ENDED_EARLY" && nowMs < ns.getLong("endAt")) {
            ns.put("status", "LOCKED")
            ns.put("endedEarlyAt", JSONObject.NULL)
            ensureActiveRequestUnlocked(ns.getString("sessionId"), ns.getLong("endAt"), "TEMP_ALLOW_15M", null, nowMs)
        }
        logEventUnlocked("RELOCK_MANUAL", "已手动恢复夜间拦截。", nowMs)
        saveUnlocked()
        return JSONObject().put("ok", true)
    }

    // ---------------- 状态视图构建（对齐手机前端与 Windows 心跳同步） ----------------

    fun buildLiveSnapshot(permissions: JSONObject, nowMs: Long = System.currentTimeMillis()): JSONObject = synchronized(lock) {
        evaluate(nowMs)
        val ns = state.getJSONObject("nightSession")
        val trial = state.optJSONObject("trialSession")
        val go = state.getJSONObject("guardOptions")
        val permsOk = permissions.optBoolean("usageStats") &&
            permissions.optBoolean("overlay") &&
            permissions.optBoolean("exactAlarm")

        val effStatus = when {
            !permsOk && (trial != null || ns.getString("status") in setOf("LOCKED", "TEMP_ALLOW")) -> "PROTECTION_INTERRUPTED"
            trial != null -> if (!trial.isNull("tempAllow")) "TEMP_ALLOW" else "TRIAL_LOCKED"
            else -> ns.getString("status")
        }

        val installedApps = InstalledAppScanner.scanInstalledLaunchableApps(appContext)
        val appLabels = InstalledAppScanner.buildAppLabelMap(appContext, installedApps)
        val exemptSet = toStringList(ns.getJSONArray("effectiveExemptAppIds")).toSet()
        val restrictionMode = go.optString("restrictionMode", MODE_WHITELIST_ALL)

        // 严格白名单模式下，把所有真实已装且未豁免的应用作为可放行/受限目标列表传给两端
        val effRestrictedForSync = if (restrictionMode == MODE_WHITELIST_ALL) {
            val allNonExempt = JSONArray()
            val curTarget = state.getJSONObject("emergency").optJSONObject("activeRequest")?.optString("targetAppId", "")
            val added = HashSet<String>()
            if (!curTarget.isNullOrBlank() && curTarget != "null") {
                allNonExempt.put(curTarget)
                added.add(curTarget)
            }
            for (i in 0 until installedApps.length()) {
                val id = installedApps.getJSONObject(i).getString("id")
                if (id !in exemptSet && added.add(id)) {
                    allNonExempt.put(id)
                }
            }
            allNonExempt
        } else {
            ns.getJSONArray("effectiveRestrictedAppIds")
        }

        val em = state.getJSONObject("emergency")
        val consumed = em.getJSONArray("consumedRequests")
        val recentConsumed = JSONArray()
        for (i in 0 until minOf(consumed.length(), 10)) recentConsumed.put(consumed.getJSONObject(i))

        return JSONObject().apply {
            put("syncedAt", nowMs)
            put("activeMode", if (trial != null) "TRIAL" else "NIGHT")
            put("sessionId", trial?.getString("sessionId") ?: ns.getString("sessionId"))
            put("nightKey", ns.getString("nightKey"))
            put("status", effStatus)
            put("rawNightStatus", ns.getString("status"))
            put("permissionsOk", permsOk)
            put("permissions", permissions)
            put("restrictionMode", restrictionMode)
            put("blockSettingsDuringLock", go.optBoolean("blockSettingsDuringLock", true))
            put("startAt", trial?.getLong("startedAt") ?: ns.getLong("startAt"))
            put("endAt", trial?.getLong("endAt") ?: ns.getLong("endAt"))
            put("baselineStartAt", ns.getLong("baselineStartAt"))
            put("freezeCutoffAt", ns.getLong("freezeCutoffAt"))
            put("isFrozen", isFrozenUnlocked(nowMs))
            put("tempAllow", trial?.opt("tempAllow") ?: ns.opt("tempAllow"))
            put("tonightOverride", state.opt("tonightOverride"))
            put("nextRegularResumeAt", computeNextRegularResumeAtUnlocked(ns.getString("nightKey")))
            put("effectiveRestrictedAppIds", effRestrictedForSync)
            put("effectiveExemptAppIds", ns.getJSONArray("effectiveExemptAppIds"))
            put("appLabels", appLabels)
            put("activeRequest", em.opt("activeRequest"))
            put("wrongAttempts", em.optInt("wrongAttempts", 0))
            put("cooldownUntil", em.opt("cooldownUntil"))
            put("consumedCount", consumed.length())
            put("recentConsumed", recentConsumed)
            put("events", state.getJSONArray("events"))
        }
    }

    fun buildWebViewStatePayload(
        permissions: JSONObject,
        lanConnected: Boolean,
        blockedPkg: String?,
        nowMs: Long = System.currentTimeMillis(),
    ): JSONObject = synchronized(lock) {
        val installedApps = InstalledAppScanner.scanInstalledLaunchableApps(appContext)
        val live = buildLiveSnapshot(permissions, nowMs)
        val em = state.getJSONObject("emergency")
        val pairing = state.getJSONObject("pairing")
        val showOverlay = blockedPkg != null && shouldBlockPackage(blockedPkg, nowMs) && live.getBoolean("permissionsOk")

        val mobileView = JSONObject().apply {
            put("nowMs", nowMs)
            put("live", live)
            put("guardOptions", JSONObject(state.getJSONObject("guardOptions").toString()))
            put("installedApps", installedApps)
            put("schedule", state.getJSONObject("schedule"))
            put("apps", state.getJSONObject("apps"))
            put("pendingNextNight", state.getJSONObject("pendingNextNight"))
            put("onboarding", state.getJSONObject("onboarding"))
            put("permissions", permissions)
            put("foregroundAppId", blockedPkg ?: JSONObject.NULL)
            put("shouldShowOverlay", showOverlay)
            put("lanConnected", lanConnected)
            put("pairing", JSONObject().apply {
                put("status", pairing.getString("status"))
                put("pairId", pairing.opt("pairId"))
                put("desktopName", pairing.getString("desktopName"))
                put("pairedAt", pairing.opt("pairedAt"))
                put("lostPcUnbindRequestedAt", pairing.opt("lostPcUnbindRequestedAt"))
                put("lostPcUnbindEffectiveAt", pairing.opt("lostPcUnbindEffectiveAt"))
            })
            put("consumedRequests", live.getJSONArray("recentConsumed"))
            put("invalidatedCount", em.getJSONArray("invalidatedRequests").length())
        }

        return JSONObject()
            .put("nowMs", nowMs)
            .put("sim", JSONObject().put("timeOffsetMs", 0).put("lanConnected", lanConnected).put("pcPoweredOn", lanConnected).put("mobileRebootCount", 0))
            .put("mobile", mobileView)
    }

    // ---------------- 内部辅助 ----------------

    private fun ensureActiveRequestUnlocked(sessionId: String, expiresAt: Long, actionType: String, targetApp: String?, nowMs: Long): JSONObject {
        val em = state.getJSONObject("emergency")
        val cur = em.optJSONObject("activeRequest")
        if (cur != null && cur.getString("sessionId") == sessionId) return cur
        val target = if (actionType == "END_TONIGHT") null else (targetApp ?: firstRestrictedAppUnlocked())
        return rotateActiveRequestUnlocked(sessionId, expiresAt, actionType, target, nowMs)
    }

    private fun rotateActiveRequestUnlocked(sessionId: String, expiresAt: Long, actionType: String, targetApp: String?, nowMs: Long): JSONObject {
        val req = JSONObject()
            .put("requestId", DormSleepCrypto.generateRequestId())
            .put("sessionId", sessionId)
            .put("actionType", actionType)
            .put("targetAppId", targetApp ?: JSONObject.NULL)
            .put("createdAt", nowMs)
            .put("expiresAt", expiresAt)
        state.getJSONObject("emergency").put("activeRequest", req)
        return req
    }

    private fun invalidateActiveRequestUnlocked(reason: String, nowMs: Long) {
        val em = state.getJSONObject("emergency")
        val cur = em.optJSONObject("activeRequest") ?: return
        cur.put("invalidatedAt", nowMs).put("reason", reason)
        em.getJSONArray("invalidatedRequests").put(cur)
        em.put("activeRequest", JSONObject.NULL)
    }

    private fun firstRestrictedAppUnlocked(): String {
        val arr = state.getJSONObject("nightSession").getJSONArray("effectiveRestrictedAppIds")
        if (arr.length() > 0) return arr.getString(0)
        val installedDefaults = InstalledAppScanner.getDefaultInstalledRestricted(appContext)
        if (installedDefaults.isNotEmpty()) return installedDefaults.first()
        val exemptSet = toStringList(state.getJSONObject("nightSession").getJSONArray("effectiveExemptAppIds")).toSet()
        val all = InstalledAppScanner.scanInstalledLaunchableApps(appContext)
        for (i in 0 until all.length()) {
            val id = all.getJSONObject(i).getString("id")
            if (id !in exemptSet) return id
        }
        return "tv.danmaku.bili"
    }

    private fun classifyFailureUnlocked(code: String, codeSha: String, secret: String, pairId: String): String {
        val em = state.getJSONObject("emergency")
        val consumed = em.getJSONArray("consumedRequests")
        for (i in 0 until consumed.length()) {
            val item = consumed.getJSONObject(i)
            if (codeSha.isNotEmpty() && item.optString("codeSha") == codeSha) return "CODE_ALREADY_USED"
            if (code.length == 6) {
                val old = DormSleepCrypto.deriveOfflineEmergencyCode(
                    secret, pairId, item.getString("sessionId"), item.getString("requestId"),
                    item.getString("actionType"), if (item.isNull("targetAppId")) null else item.getString("targetAppId")
                )
                if (DormSleepCrypto.constantTimeEquals(code, old)) return "CODE_ALREADY_USED"
            }
        }
        val inv = em.getJSONArray("invalidatedRequests")
        for (i in 0 until inv.length()) {
            val item = inv.getJSONObject(i)
            if (code.length == 6) {
                val old = DormSleepCrypto.deriveOfflineEmergencyCode(
                    secret, pairId, item.getString("sessionId"), item.getString("requestId"),
                    item.getString("actionType"), if (item.isNull("targetAppId")) null else item.getString("targetAppId")
                )
                if (DormSleepCrypto.constantTimeEquals(code, old)) return "REQUEST_INVALIDATED"
            }
        }
        return "CODE_INVALID"
    }
}
