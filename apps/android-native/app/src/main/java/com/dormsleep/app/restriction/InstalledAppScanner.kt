package com.dormsleep.app.restriction

import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.provider.Telephony
import android.telecom.TelecomManager
import android.view.inputmethod.InputMethodManager
import org.json.JSONArray
import org.json.JSONObject

/**
 * 扫描 Android / HarmonyOS 手机上真实已安装的用户应用，并动态识别系统桌面、输入法、电话/短信/闹钟等必要包名。
 * 彻底替代写死的演示假名单（例如未安装《王者荣耀》时绝不出现在受限列表中）。
 */
object InstalledAppScanner {

    // 常见已知娱乐包名（仅在手机确实已安装时作为初始建议预选）
    private val KNOWN_ENTERTAINMENT_PKGS = setOf(
        "tv.danmaku.bili",
        "com.ss.android.ugc.aweme",
        "com.ss.android.ugc.aweme.lite",
        "com.smile.gifmaker",
        "com.kuaishou.nebula",
        "com.xingin.xhs",
        "com.sina.weibo",
        "com.zhihu.android",
        "com.baidu.tieba",
        "com.tencent.qqlive",
        "com.qiyi.video",
        "com.youku.phone",
        "com.tencent.tmgp.sgame",
        "com.tencent.tmgp.pubgmhd",
        "com.miHoYo.Yuanshen",
        "com.miHoYo.hkrpg",
        "com.netease.cloudmusic",
        "com.tencent.qqmusic",
        "com.taobao.taobao",
        "com.xunmeng.pinduoduo",
        "com.jingdong.app.mall",
    )

    // 常见校园刚需与认证包名
    private val KNOWN_ESSENTIAL_PKGS = setOf(
        "edu.campus.card",
        "com.auth.campus",
        "com.chaoxing.mobile",
        "com.supwisdom.superapp",
        "com.newcapec.mobile.ncp",
        "com.microsoft.azureauthenticator",
        "com.google.android.apps.authenticator2",
    )

    // 混合应用（含校园门禁/付款小程序，勾选豁免需提示整应用放行）
    private val HYBRID_CAMPUS_WARNINGS = mapOf(
        "com.tencent.mm" to "Android 普通应用无法只放行单个微信小程序而单独拦截朋友圈或视频号。若保留微信用于刷校园码，将放行整个微信应用。",
        "com.eg.android.AlipayGphone" to "Android 普通应用无法仅放行支付宝内的校园码小程序而屏蔽其他页面。开启豁免将放行整个支付宝应用。",
    )

    // 荣耀 / 华为 HarmonyOS 与原生 Android 常见系统必用包名（电话、短信、闹钟、系统 UI）
    private val STATIC_MANDATORY_PKGS = setOf(
        "com.android.dialer",
        "com.android.incallui",
        "com.android.server.telecom",
        "com.android.contacts",
        "com.huawei.contacts",
        "com.hihonor.contacts",
        "com.android.mms",
        "com.huawei.mms",
        "com.hihonor.mms",
        "com.google.android.apps.messaging",
        "com.android.deskclock",
        "com.huawei.deskclock",
        "com.hihonor.deskclock",
        "com.google.android.deskclock",
        "com.android.systemui",
        "com.huawei.android.launcher",
        "com.hihonor.android.launcher",
        "android",
    )

    // 锁机期防绕过保护目标（系统设置、荣耀/华为手机管家、应用卸载/安装器）
    val GUARDED_SETTINGS_PKGS = setOf(
        "com.android.settings",
        "com.huawei.systemmanager",
        "com.hihonor.systemmanager",
        "com.android.packageinstaller",
        "com.google.android.packageinstaller",
    )

    fun getLauncherPackages(context: Context): Set<String> {
        val launchers = HashSet<String>()
        launchers.add("com.huawei.android.launcher")
        launchers.add("com.hihonor.android.launcher")
        val pm = context.packageManager
        val homeIntent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
        runCatching {
            pm.queryIntentActivities(homeIntent, PackageManager.MATCH_DEFAULT_ONLY).forEach {
                it.activityInfo?.packageName?.let { pkg -> launchers.add(pkg) }
            }
        }
        return launchers
    }

    fun getTransientSystemIgnorePackages(context: Context): Set<String> {
        val ignored = HashSet<String>()
        ignored.add("com.android.systemui")
        ignored.add("android")
        runCatching {
            val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
            imm?.enabledInputMethodList?.forEach { ignored.add(it.packageName) }
        }
        return ignored
    }

    fun getAlwaysSafeSystemPackages(context: Context): Set<String> {
        val safe = HashSet<String>(STATIC_MANDATORY_PKGS)
        safe.add(context.packageName)

        // 1) 所有系统桌面（Launcher）始终放行，保证可以随时退回桌面
        safe.addAll(getLauncherPackages(context))

        // 2) 系统默认拨号应用与默认短信应用
        runCatching {
            val tm = context.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager
            tm?.defaultDialerPackage?.let { safe.add(it) }
        }
        runCatching {
            Telephony.Sms.getDefaultSmsPackage(context)?.let { safe.add(it) }
        }

        // 3) 所有已启用输入法（保证应急码与密码框正常输入）
        runCatching {
            val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
            imm?.enabledInputMethodList?.forEach { safe.add(it.packageName) }
        }

        return safe
    }

    /**
     * 扫描手机上真实已安装且有桌面启动入口的应用，供前端展示与精准限制。
     */
    fun scanInstalledLaunchableApps(context: Context): JSONArray {
        val pm = context.packageManager
        val safeSystem = getAlwaysSafeSystemPackages(context)
        val launcherIntent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val resolved = runCatching {
            pm.queryIntentActivities(launcherIntent, 0)
        }.getOrDefault(emptyList())

        val seen = LinkedHashMap<String, JSONObject>()
        for (ri in resolved) {
            val ai = ri.activityInfo ?: continue
            val pkg = ai.packageName ?: continue
            if (pkg in seen) continue
            if (pkg == context.packageName) continue
            if (pkg in safeSystem) continue
            if (pkg in GUARDED_SETTINGS_PKGS) continue

            val appInfo = runCatching { pm.getApplicationInfo(pkg, 0) }.getOrNull() ?: continue
            val isSystem = (appInfo.flags and ApplicationInfo.FLAG_SYSTEM) != 0 &&
                (appInfo.flags and ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) == 0

            val label = runCatching { pm.getApplicationLabel(appInfo).toString().trim() }
                .getOrNull()
                ?.takeIf { it.isNotEmpty() }
                ?: pkg

            val category = when {
                pkg in HYBRID_CAMPUS_WARNINGS -> "HYBRID"
                pkg in KNOWN_ESSENTIAL_PKGS -> "ESSENTIAL"
                pkg in KNOWN_ENTERTAINMENT_PKGS -> "ENTERTAINMENT"
                !isSystem -> "ENTERTAINMENT"
                else -> "SYSTEM_TOOL"
            }

            // 隐藏无意义的纯系统底层工具，保留用户安装/更新的应用以及浏览器/相机等常见应用
            if (category == "SYSTEM_TOOL" && isSystem) {
                val lower = pkg.lowercase()
                val keepUsefulSystem = lower.contains("browser") || lower.contains("video") || lower.contains("music") || lower.contains("game")
                if (!keepUsefulSystem) continue
            }

            val obj = JSONObject()
                .put("id", pkg)
                .put("name", label)
                .put("category", if (category == "SYSTEM_TOOL") "ENTERTAINMENT" else category)
                .put("isSystem", isSystem)
                .put("description", if (pkg in HYBRID_CAMPUS_WARNINGS) "含校园门禁/付款小程序，豁免将整应用放行" else pkg)
                .put("campusCodeWarning", pkg in HYBRID_CAMPUS_WARNINGS)
            HYBRID_CAMPUS_WARNINGS[pkg]?.let { obj.put("campusWarningText", it) }

            seen[pkg] = obj
        }

        val sorted = seen.values.sortedWith(
            compareBy<JSONObject>(
                {
                    when (it.optString("category")) {
                        "ESSENTIAL" -> 0
                        "HYBRID" -> 1
                        else -> if (it.optString("id") in KNOWN_ENTERTAINMENT_PKGS) 2 else 3
                    }
                },
                { it.optString("name") }
            )
        )

        val arr = JSONArray()
        sorted.forEach { arr.put(it) }
        return arr
    }

    fun getInstalledPackageSet(context: Context): Set<String> {
        val list = scanInstalledLaunchableApps(context)
        val set = LinkedHashSet<String>(list.length())
        for (i in 0 until list.length()) {
            set.add(list.getJSONObject(i).getString("id"))
        }
        return set
    }

    fun getDefaultInstalledRestricted(context: Context): List<String> {
        val installed = scanInstalledLaunchableApps(context)
        val known = mutableListOf<String>()
        val fallback = mutableListOf<String>()
        for (i in 0 until installed.length()) {
            val item = installed.getJSONObject(i)
            val id = item.getString("id")
            if (item.optString("category") == "ENTERTAINMENT") {
                if (id in KNOWN_ENTERTAINMENT_PKGS) known.add(id)
                else fallback.add(id)
            }
        }
        return if (known.isNotEmpty()) known else fallback.take(8)
    }

    fun getDefaultInstalledExempt(context: Context): List<String> {
        val installed = scanInstalledLaunchableApps(context)
        val list = mutableListOf<String>()
        for (i in 0 until installed.length()) {
            val item = installed.getJSONObject(i)
            if (item.optString("category") == "ESSENTIAL") {
                list.add(item.getString("id"))
            }
        }
        return list
    }

    fun buildAppLabelMap(context: Context, installedApps: JSONArray? = null): JSONObject {
        val map = JSONObject()
        val list = installedApps ?: scanInstalledLaunchableApps(context)
        for (i in 0 until list.length()) {
            val item = list.getJSONObject(i)
            map.put(item.getString("id"), item.getString("name"))
        }
        map.put("com.android.settings", "系统设置")
        map.put("com.huawei.systemmanager", "手机管家")
        map.put("com.hihonor.systemmanager", "荣耀手机管家")
        map.put("com.android.packageinstaller", "应用卸载与管理")
        map.put("com.google.android.packageinstaller", "应用卸载与管理")
        return map
    }

    fun resolveAppName(context: Context, pkg: String): String {
        if (pkg == "com.android.settings") return "系统设置"
        if (pkg == "com.huawei.systemmanager" || pkg == "com.hihonor.systemmanager") return "手机管家"
        if (pkg.contains("packageinstaller")) return "应用卸载与管理"
        return runCatching {
            val pm = context.packageManager
            val ai = pm.getApplicationInfo(pkg, 0)
            pm.getApplicationLabel(ai).toString().trim().ifEmpty { pkg }
        }.getOrDefault(pkg)
    }
}
