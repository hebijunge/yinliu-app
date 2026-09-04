package com.yinliu.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import androidx.core.app.ActivityCompat;
import com.getcapacitor.BridgeActivity;
import com.yinliu.app.floatinglyrics.FloatingLyricsPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(FloatingLyricsPlugin.class);
        registerPlugin(AudioFocusManagerPlugin.class);
        super.onCreate(savedInstanceState);

        // v20：Android 13+ 通知栏媒体卡片需要运行时通知权限（首次启动申请一次）
        if (Build.VERSION.SDK_INT >= 33
                && ActivityCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(
                    this, new String[] { Manifest.permission.POST_NOTIFICATIONS }, 2001);
        }
    }
}
