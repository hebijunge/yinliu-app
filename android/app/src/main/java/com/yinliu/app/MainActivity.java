package com.yinliu.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.yinliu.app.floatinglyrics.FloatingLyricsPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(FloatingLyricsPlugin.class);
        registerPlugin(AudioFocusManagerPlugin.class);
        super.onCreate(savedInstanceState);

        // C9：启动时不再强弹 POST_NOTIFICATIONS 运行时权限申请（原 v20 首启申请一次已移除）。
        // 通知授权统一收敛到设置页「开启下载通知」用户手势，由 @capacitor/local-notifications 触发。
    }
}
