package com.leadingthink.miniq;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.leadingthink.miniq.push.MiniqPushPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MiniqPushPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
