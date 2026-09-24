package com.calcitonin.rxstore;

import android.content.Intent;
import android.net.Uri;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * RX Store deep-link intake (rxstore://app/{slug}).
 *
 * SECURITY: this plugin only ever hands the raw URI string to the WebView —
 * it never parses paths, executes data, or follows embedded instructions.
 * The React layer (src/platform/deepLinkProtocol.ts) validates the link
 * against a strict allowlist (exactly app/{kebab-slug}) before navigating.
 *
 * Cold start: Android launches MainActivity with the VIEW intent; the plugin
 * exposes getLaunchLink() so the web app can read (and consume) it once.
 * Warm start: BridgeActivity forwards onNewIntent to plugins; we emit a
 * 'deepLink' event to the WebView with the new URI.
 */
@CapacitorPlugin(name = "RxDeepLink")
public class RxDeepLinkPlugin extends Plugin {
    private static final String SCHEME = "rxstore";
    private String launchLink;   // cold-start link, consumed once by the web app
    private boolean consumed = false;

    @Override
    public void load() {
        super.load();
        try {
            Intent intent = getActivity() != null ? getActivity().getIntent() : null;
            Uri data = intent != null ? intent.getData() : null;
            if (data != null && SCHEME.equals(data.getScheme())) {
                launchLink = data.toString();
            }
        } catch (Exception ignored) { /* never crash app startup over a link */ }
    }

    /** Get (once) the URI the app was LAUNCHED with, if it was a rxstore:// link. */
    @PluginMethod
    public void getLaunchLink(PluginCall call) {
        JSObject ret = new JSObject();
        if (!consumed && launchLink != null) {
            ret.put("url", launchLink);
            consumed = true;
        }
        call.resolve(ret);
    }

    /** Warm-start deep link: forward the new intent's URI to the WebView. */
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        try {
            Uri data = intent != null ? intent.getData() : null;
            if (data != null && SCHEME.equals(data.getScheme())) {
                JSObject payload = new JSObject();
                payload.put("url", data.toString());
                notifyListeners("deepLink", payload);
            }
        } catch (Exception ignored) { /* never crash on a malformed link */ }
    }
}
