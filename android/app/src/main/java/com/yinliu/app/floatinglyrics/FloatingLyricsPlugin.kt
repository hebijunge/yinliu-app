package com.yinliu.app.floatinglyrics

import android.Manifest
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

/**
 * Capacitor 插件：Android 桌面悬浮歌词
 * 暴露给 JS 的三个桥接方法：show / update / hide
 * 底层通过 FloatingLyricsService（前台服务）保活并绘制悬浮窗
 */
@CapacitorPlugin(
    name = "FloatingLyrics",
    permissions = [
        Permission(
            strings = [Manifest.permission.SYSTEM_ALERT_WINDOW],
            alias = "overlay"
        )
    ]
)
class FloatingLyricsPlugin : Plugin() {

    companion object {
        private const val TAG = "FloatingLyricsPlugin"
        private const val REQ_OVERLAY = 9001
    }

    private var serviceIntent: Intent? = null

    @PluginMethod
    fun show(call: PluginCall) {
        val ctx = context ?: run {
            call.reject("Context is null")
            return
        }

        if (!Settings.canDrawOverlays(ctx)) {
            // 引导用户去设置页授权
            call.reject(
                "SYSTEM_ALERT_WINDOW permission not granted",
                "PERMISSION_DENIED",
                JSObject().apply {
                    put("action", "request_overlay")
                }
            )
            return
        }

        val text = call.getString("text", "")
        val title = call.getString("title", "")
        val artist = call.getString("artist", "")
        val draggable = call.getBoolean("draggable", true)
        val initialX = call.getFloat("initialX", 0.1f)
        val initialY = call.getFloat("initialY", 0.15f)

        val intent = Intent(ctx, FloatingLyricsService::class.java).apply {
            action = FloatingLyricsService.ACTION_SHOW
            putExtra(FloatingLyricsService.EXTRA_TEXT, text)
            putExtra(FloatingLyricsService.EXTRA_TITLE, title)
            putExtra(FloatingLyricsService.EXTRA_ARTIST, artist)
            putExtra(FloatingLyricsService.EXTRA_DRAGGABLE, draggable)
            putExtra(FloatingLyricsService.EXTRA_INITIAL_X, initialX)
            putExtra(FloatingLyricsService.EXTRA_INITIAL_Y, initialY)
        }
        serviceIntent = intent

        try {
            ContextCompat.startForegroundService(ctx, intent)
            call.resolve()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start service", e)
            call.reject("Failed to start floating lyrics: ${e.message}")
        }
    }

    @PluginMethod
    fun update(call: PluginCall) {
        val ctx = context ?: run {
            call.reject("Context is null")
            return
        }

        val text = call.getString("text", "")
        val title = call.getString("title", "")
        val artist = call.getString("artist", "")

        val intent = Intent(ctx, FloatingLyricsService::class.java).apply {
            action = FloatingLyricsService.ACTION_UPDATE
            putExtra(FloatingLyricsService.EXTRA_TEXT, text)
            putExtra(FloatingLyricsService.EXTRA_TITLE, title)
            putExtra(FloatingLyricsService.EXTRA_ARTIST, artist)
        }

        try {
            ctx.startService(intent)
            call.resolve()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to update lyrics", e)
            call.reject("Failed to update floating lyrics: ${e.message}")
        }
    }

    @PluginMethod
    fun hide(call: PluginCall) {
        val ctx = context ?: run {
            call.reject("Context is null")
            return
        }

        val intent = Intent(ctx, FloatingLyricsService::class.java).apply {
            action = FloatingLyricsService.ACTION_HIDE
        }

        try {
            ctx.stopService(intent)
            serviceIntent = null
            call.resolve()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to stop service", e)
            call.reject("Failed to hide floating lyrics: ${e.message}")
        }
    }

    @PluginMethod
    fun isShowing(call: PluginCall) {
        val showing = FloatingLyricsService.isRunning
        call.resolve(JSObject().apply {
            put("showing", showing)
        })
    }
}
