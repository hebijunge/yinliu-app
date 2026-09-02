package com.yinliu.app.floatinglyrics

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.os.Build
import android.os.IBinder
import android.util.Log
import android.view.Gravity
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.TextView
import androidx.core.app.NotificationCompat
import com.yinliu.app.R

/**
 * 前台服务：保活 + 绘制桌面悬浮歌词窗
 * 通过 WindowManager.TYPE_APPLICATION_OVERLAY 在桌面层级绘制
 */
class FloatingLyricsService : Service() {

    companion object {
        private const val TAG = "FloatingLyricsSvc"
        private const val NOTIF_CHANNEL_ID = "yinliu_floating_lyrics"
        private const val NOTIF_ID = 2001

        const val ACTION_SHOW = "com.yinliu.app.floatinglyrics.SHOW"
        const val ACTION_UPDATE = "com.yinliu.app.floatinglyrics.UPDATE"
        const val ACTION_HIDE = "com.yinliu.app.floatinglyrics.HIDE"

        const val EXTRA_TEXT = "text"
        const val EXTRA_TITLE = "title"
        const val EXTRA_ARTIST = "artist"
        const val EXTRA_DRAGGABLE = "draggable"
        const val EXTRA_INITIAL_X = "initialX"
        const val EXTRA_INITIAL_Y = "initialY"

        @JvmStatic
        var isRunning = false
            private set
    }

    private var windowManager: WindowManager? = null
    private var floatingView: View? = null
    private var params: WindowManager.LayoutParams? = null
    private var lyricsTextView: TextView? = null

    private var initialX = 0f
    private var initialY = 0f
    private var touchX = 0f
    private var touchY = 0f
    private var isDragging = false

    override fun onCreate() {
        super.onCreate()
        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_SHOW -> handleShow(intent)
            ACTION_UPDATE -> handleUpdate(intent)
            ACTION_HIDE -> {
                stopSelf()
                return START_NOT_STICKY
            }
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        removeFloatingView()
        isRunning = false
        super.onDestroy()
    }

    private fun handleShow(intent: Intent) {
        val text = intent.getStringExtra(EXTRA_TEXT) ?: ""
        val title = intent.getStringExtra(EXTRA_TITLE) ?: ""
        val artist = intent.getStringExtra(EXTRA_ARTIST) ?: ""
        val draggable = intent.getBooleanExtra(EXTRA_DRAGGABLE, true)
        val initXRatio = intent.getFloatExtra(EXTRA_INITIAL_X, 0.1f)
        val initYRatio = intent.getFloatExtra(EXTRA_INITIAL_Y, 0.15f)

        if (floatingView == null) {
            createFloatingView(draggable, initXRatio, initYRatio)
        }

        lyricsTextView?.text = text.ifEmpty { "$title - $artist".trim('-', ' ') }
        startForeground(NOTIF_ID, buildNotification(title, artist))
        isRunning = true
    }

    private fun handleUpdate(intent: Intent) {
        val text = intent.getStringExtra(EXTRA_TEXT) ?: ""
        val title = intent.getStringExtra(EXTRA_TITLE) ?: ""
        val artist = intent.getStringExtra(EXTRA_ARTIST) ?: ""

        lyricsTextView?.text = text.ifEmpty { "$title - $artist".trim('-', ' ') }

        // 更新通知
        val notif = buildNotification(title, artist)
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIF_ID, notif)
    }

    private fun createFloatingView(draggable: Boolean, initXRatio: Float, initYRatio: Float) {
        val inflater = LayoutInflater.from(this)
        val view = inflater.inflate(R.layout.floating_lyrics, null)
        floatingView = view
        lyricsTextView = view.findViewById(R.id.lyrics_text)

        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }

        val metrics = resources.displayMetrics
        val screenW = metrics.widthPixels
        val screenH = metrics.heightPixels

        val w = WindowManager.LayoutParams.WRAP_CONTENT
        val h = WindowManager.LayoutParams.WRAP_CONTENT
        val x = (screenW * initXRatio).toInt()
        val y = (screenH * initYRatio).toInt()

        params = WindowManager.LayoutParams(
            w, h, x, y,
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                    or WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
        }

        windowManager?.addView(view, params)

        if (draggable) {
            view.setOnTouchListener { _, event ->
                when (event.action) {
                    MotionEvent.ACTION_DOWN -> {
                        initialX = params!!.x.toFloat()
                        initialY = params!!.y.toFloat()
                        touchX = event.rawX
                        touchY = event.rawY
                        isDragging = false
                        true
                    }
                    MotionEvent.ACTION_MOVE -> {
                        val dx = event.rawX - touchX
                        val dy = event.rawY - touchY
                        if (kotlin.math.abs(dx) > 10 || kotlin.math.abs(dy) > 10) {
                            isDragging = true
                        }
                        params!!.x = (initialX + dx).toInt()
                        params!!.y = (initialY + dy).toInt()
                        windowManager?.updateViewLayout(view, params)
                        true
                    }
                    MotionEvent.ACTION_UP -> {
                        // 点击不消费，避免拦截其他手势
                        !isDragging
                    }
                    else -> false
                }
            }
        }
    }

    private fun removeFloatingView() {
        floatingView?.let {
            try {
                windowManager?.removeView(it)
            } catch (e: Exception) {
                Log.w(TAG, "removeView failed", e)
            }
        }
        floatingView = null
        lyricsTextView = null
        params = null
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                NOTIF_CHANNEL_ID,
                "桌面悬浮歌词",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "保持悬浮歌词窗在前台运行"
                setShowBadge(false)
            }
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(title: String, artist: String): Notification {
        val content = if (title.isNotEmpty()) "$title - $artist" else "音流 · 桌面歌词运行中"

        // 点击通知返回应用主界面
        val pendingIntent = PendingIntent.getActivity(
            this, 0,
            packageManager.getLaunchIntentForPackage(packageName),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        return NotificationCompat.Builder(this, NOTIF_CHANNEL_ID)
            .setContentTitle("音流 · 桌面歌词")
            .setContentText(content)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }
}
