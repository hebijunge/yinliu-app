package com.yinliu.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * v20 音频焦点 / 耳机拔出系统层管理
 *
 * @jofr/capacitor-media-session 提供通知栏媒体卡片、锁屏控制与前台服务保活，
 * 但不处理音频焦点与 ACTION_AUDIO_BECOMING_NOISY。本插件补齐：
 * - requestFocus / abandonFocus：WebView 播放路径无法自动申请音频焦点，由 JS 在开始/停止播放时调用
 * - focusChange 事件：其他 App 抢焦点（来电、其他播放器）时通知 JS 暂停/恢复
 * - becomingNoisy 事件：耳机/蓝牙拔出时通知 JS 立即暂停
 */
@CapacitorPlugin(name = "AudioFocusManager")
public class AudioFocusManagerPlugin extends Plugin {

    private AudioManager audioManager;
    private AudioFocusRequest focusRequest;
    // v29-A4: 移除死字段 focusHeld —— 仅被写入从未被读取，焦点持有状态由 JS 侧
    // nativeFocusHeld 统一管理

    private final BroadcastReceiver noisyReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction())) {
                notifyListeners("becomingNoisy", new JSObject());
            }
        }
    };

    private final AudioManager.OnAudioFocusChangeListener focusListener =
            new AudioManager.OnAudioFocusChangeListener() {
                @Override
                public void onAudioFocusChange(int change) {
                    JSObject data = new JSObject();
                    data.put("change", change);
                    notifyListeners("focusChange", data);
                }
            };

    @Override
    public void load() {
        audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        // ACTION_AUDIO_BECOMING_NOISY 是受保护的系统广播，无需 RECEIVER_EXPORTED 标志
        IntentFilter filter = new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
        getContext().registerReceiver(noisyReceiver, filter);
    }

    @PluginMethod
    public void requestFocus(PluginCall call) {
        if (audioManager == null) {
            JSObject r = new JSObject();
            r.put("granted", false);
            call.resolve(r);
            return;
        }
        int result;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (focusRequest == null) {
                focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                        .setAudioAttributes(new AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_MEDIA)
                                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                                .build())
                        .setOnAudioFocusChangeListener(focusListener)
                        .build();
            }
            result = audioManager.requestAudioFocus(focusRequest);
        } else {
            result = audioManager.requestAudioFocus(
                    focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
        }
        boolean granted = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        JSObject ret = new JSObject();
        ret.put("granted", granted);
        call.resolve(ret);
    }

    @PluginMethod
    public void abandonFocus(PluginCall call) {
        if (audioManager != null) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                if (focusRequest != null) {
                    audioManager.abandonAudioFocusRequest(focusRequest);
                }
            } else {
                audioManager.abandonAudioFocus(focusListener);
            }
        }
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        // v29-A4: 销毁时释放音频焦点 —— 旧实现只注销广播接收器，App 退出后
        // 仍持有焦点，其他应用无法正常获取（Android 焦点泄漏）
        try {
            if (audioManager != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    if (focusRequest != null) {
                        audioManager.abandonAudioFocusRequest(focusRequest);
                    }
                } else {
                    audioManager.abandonAudioFocus(focusListener);
                }
            }
        } catch (Exception ignored) {
            // 释放失败不阻断销毁
        }
        try {
            getContext().unregisterReceiver(noisyReceiver);
        } catch (IllegalArgumentException ignored) {
            // 未注册时忽略
        }
        super.handleOnDestroy();
    }
}
