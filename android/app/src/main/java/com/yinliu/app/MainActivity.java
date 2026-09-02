package com.yinliu.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.yinliu.app.floatinglyrics.FloatingLyricsPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(FloatingLyricsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
