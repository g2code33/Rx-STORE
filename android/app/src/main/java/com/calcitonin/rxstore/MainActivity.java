package com.calcitonin.rxstore;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AppInstallerPlugin.class);
        registerPlugin(SecureStorePlugin.class);
        registerPlugin(RxDeepLinkPlugin.class);
        super.onCreate(savedInstanceState);
        routeExternalLinksToTheBrowser();
    }

    /**
     * WEB LINKS BELONG TO THE BROWSER.
     *
     * The RX Store shell is the app:// (https://localhost) WebView. Opening a
     * third-party site inside it is a dead end (no address bar, no tabs, logins
     * and OAuth callbacks break, hardware back is confusing). Every link to the
     * public web is handed to the user's default browser instead; in-app
     * navigation (same origin + window.open to the app itself) stays inside.
     */
    private void routeExternalLinksToTheBrowser() {
        final WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView == null) return;
        webView.setWebViewClient(new BridgeWebViewClient(getBridge()) {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request != null ? request.getUrl() : null;
                if (uri != null && isExternalWebUrl(uri)) {
                    openInBrowser(uri);
                    return true;
                }
                return super.shouldOverrideUrlLoading(view, request);
            }
        });
    }

    /** http(s) on another origin, or any non-app scheme we do not handle. */
    private boolean isExternalWebUrl(Uri uri) {
        String scheme = uri.getScheme() != null ? uri.getScheme().toLowerCase() : "";
        String host = uri.getHost() != null ? uri.getHost().toLowerCase() : "";
        boolean appOrigin = host.equals("localhost") || host.equals("127.0.0.1") || host.startsWith("app");
        if (scheme.equals("http") || scheme.equals("https")) return !appOrigin;
        // mailto:, tel:, market:, rxstore:, etc. — let the OS pick an app.
        return !appOrigin;
    }

    private void openInBrowser(Uri uri) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (Exception ignored) {
            // No handler installed — nothing safe to do; keep the WebView put.
        }
    }
}
