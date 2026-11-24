package com.dormsleep.app.scheduler

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import com.dormsleep.app.data.LocalStateEngine
import com.dormsleep.app.restriction.AppMonitorService

/**
 * 精确时间调度器（AlarmManager + SCHEDULE_EXACT_ALARM）、锁机防杀拉活与开机自启恢复。
 */
object SleepAlarmScheduler {
    private const val REQ_CODE_BASE = 2000
    private const val SLOT_WATCHDOG = 9

    fun scheduleExactTrigger(context: Context, triggerAtMs: Long, reason: String, slot: Int) {
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val intent = Intent(context, SleepAlarmReceiver::class.java).putExtra("reason", reason)
        val pi = PendingIntent.getBroadcast(
            context,
            REQ_CODE_BASE + slot,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !am.canScheduleExactAlarms()) {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMs, pi)
            return
        }
        am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMs, pi)
    }

    /**
     * 锁机期间定时拉活巡检（防止多任务划掉卡片或省电机制杀死前台监控服务）。
     */
    fun scheduleGuardWatchdog(context: Context, delayMs: Long = 60_000L) {
        scheduleExactTrigger(context, System.currentTimeMillis() + delayMs, "GUARD_WATCHDOG", SLOT_WATCHDOG)
    }

    fun rescheduleFromState(context: Context) {
        val engine = LocalStateEngine.getInstance(context)
        val state = engine.evaluate(System.currentTimeMillis())
        val now = System.currentTimeMillis()
        val ns = state.getJSONObject("nightSession")
        val trial = state.optJSONObject("trialSession")
        val preMins = state.getJSONObject("schedule").optInt("preReminderMinutes", 10)
        val startAt = ns.optLong("startAt", 0L)
        val endAt = ns.optLong("endAt", 0L)

        if (ns.optBoolean("enabled", true) && startAt > now) {
            val preAt = startAt - preMins * 60 * 1000L
            if (preAt > now) scheduleExactTrigger(context, preAt, "PRE_REMINDER", 1)
            scheduleExactTrigger(context, startAt, "LOCK_START", 2)
        }
        val ta = trial?.optJSONObject("tempAllow") ?: ns.optJSONObject("tempAllow")
        if (ta != null && ta.optLong("expiresAt", 0L) > now) {
            scheduleExactTrigger(context, ta.optLong("expiresAt"), "TEMP_ALLOW_END", 3)
        }
        val activeEnd = trial?.optLong("endAt", 0L) ?: endAt
        if (activeEnd > now) {
            scheduleExactTrigger(context, activeEnd, "NATURAL_END", 4)
        }
        if (engine.isActivelyGuarding(now)) {
            scheduleGuardWatchdog(context, 60_000L)
        }
    }
}

class SleepAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val engine = LocalStateEngine.getInstance(context)
        engine.evaluate(System.currentTimeMillis())
        val svcIntent = Intent(context, AppMonitorService::class.java)
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(svcIntent)
            } else {
                context.startService(svcIntent)
            }
        }
        SleepAlarmScheduler.rescheduleFromState(context)
    }
}

class BootCompletedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_LOCKED_BOOT_COMPLETED) {
            return
        }
        val engine = LocalStateEngine.getInstance(context)
        val state = engine.evaluate(System.currentTimeMillis())
        val st = state.getJSONObject("nightSession").optString("status", "IDLE")
        val inTrial = !state.isNull("trialSession")
        if (inTrial || st == "LOCKED" || st == "TEMP_ALLOW" || st == "PRE_LOCK_REMINDER") {
            val svcIntent = Intent(context, AppMonitorService::class.java)
            runCatching {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(svcIntent)
                } else {
                    context.startService(svcIntent)
                }
            }
        }
        SleepAlarmScheduler.rescheduleFromState(context)
    }
}
