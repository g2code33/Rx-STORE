package com.calcitonin.rxstore;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AppInstallerPlugin.class);
        registerPlugin(SecureStorePlugin.class);
        registerPlugin(RxDeepLinkPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
