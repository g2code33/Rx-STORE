package com.calcitonin.rxstore;

import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Downloads an APK with Android's DownloadManager, then opens the protected
 * package installer. Android always requires the user to confirm installation. */
@CapacitorPlugin(name = "AppInstaller")
public class AppInstallerPlugin extends Plugin {
    @PluginMethod
    public void getNetworkStatus(PluginCall call) {
        android.net.ConnectivityManager cm = (android.net.ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        boolean metered = cm != null && cm.isActiveNetworkMetered();
        boolean connected = false;
        if (cm != null && cm.getActiveNetwork() != null) {
            android.net.NetworkCapabilities caps = cm.getNetworkCapabilities(cm.getActiveNetwork());
            connected = caps != null && caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET);
        }
        JSObject result = new JSObject(); result.put("connected", connected); result.put("metered", metered); call.resolve(result);
    }

    @PluginMethod
    public void getHostVersion(PluginCall call) {
        String version = "";
        try { version = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0).versionName; } catch (Exception ignored) {}
        JSObject result = new JSObject(); result.put("version", version); call.resolve(result);
    }

    // Real Android package detection by the stable package ID (never display name).
    // Returns a normalized shape so the store frontend can reason about it the
    // same way it does desktop detections.
    @PluginMethod
    public void isInstalled(PluginCall call) {
        String packageId = call.getString("packageId", "");
        boolean installed = false;
        String version = "";
        if (!packageId.isEmpty()) {
            try {
                android.content.pm.PackageInfo info = getContext().getPackageManager().getPackageInfo(packageId, 0);
                installed = true; version = info.versionName == null ? "" : info.versionName;
            } catch (Exception ignored) {}
        }
        JSObject result = new JSObject();
        result.put("installed", installed);
        result.put("version", version);
        result.put("packageId", packageId);
        result.put("platform", "android");
        call.resolve(result);
    }

    @PluginMethod
    public void openInstalled(PluginCall call) {
        String packageId = call.getString("packageId", "");
        Intent intent = getContext().getPackageManager().getLaunchIntentForPackage(packageId);
        if (intent == null) { call.reject("Installed app has no launch activity"); return; }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); getContext().startActivity(intent); call.resolve();
    }

    @PluginMethod
    public void uninstallInstalled(PluginCall call) {
        String packageId = call.getString("packageId", "");
        Intent intent = new Intent(Intent.ACTION_DELETE, Uri.parse("package:" + packageId));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); getContext().startActivity(intent); call.resolve();
    }

    // Poll the DownloadManager and emit live progress to the webview so the app
    // page can show a Play-Store-style progress bar ("downloaded so far").
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable[] progressPoller = { null };

    private void emitProgress(DownloadManager manager, long id) {
        DownloadManager.Query q = new DownloadManager.Query().setFilterById(id);
        try (Cursor c = manager.query(q)) {
            if (c != null && c.moveToFirst()) {
                int status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                long received = 0, total = 0;
                try { received = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)); } catch (Exception ignored) {}
                try { total = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)); } catch (Exception ignored) {}

                if (status == DownloadManager.STATUS_SUCCESSFUL) {
                    JSObject done = new JSObject();
                    done.put("status", "complete");
                    done.put("percent", 100);
                    done.put("receivedBytes", received);
                    done.put("totalBytes", total);
                    try { done.put("fileUri", manager.getUriForDownloadedFile(id).toString()); } catch (Exception ignored) {}
                    notifyListeners("downloadProgress", done, true);
                    openInstaller(manager, id);
                    progressPoller[0] = null;
                    return;
                }
                if (status == DownloadManager.STATUS_FAILED) {
                    JSObject err = new JSObject();
                    err.put("status", "error");
                    try {
                        err.put("error", "Download failed (reason " + c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON)) + ")");
                    } catch (Exception ignored) { err.put("error", "Download failed"); }
                    notifyListeners("downloadProgress", err, true);
                    progressPoller[0] = null;
                    return;
                }

                int percent = total > 0 ? (int) Math.min(99, received * 100 / total) : 0;
                JSObject p = new JSObject();
                p.put("status", "downloading");
                p.put("percent", percent);
                p.put("receivedBytes", received);
                p.put("totalBytes", total);
                notifyListeners("downloadProgress", p, true);
            }
        } catch (Exception ignored) {}
        if (progressPoller[0] != null) handler.postDelayed(progressPoller[0], 500);
    }

    private void startProgressPolling(DownloadManager manager, long id) {
        if (progressPoller[0] != null) handler.removeCallbacks(progressPoller[0]);
        progressPoller[0] = () -> emitProgress(manager, id);
        handler.post(progressPoller[0]);
    }

    private void openInstaller(DownloadManager manager, long id) {
        Uri apk = manager.getUriForDownloadedFile(id);
        if (apk == null) return;
        Intent install = new Intent(Intent.ACTION_VIEW);
        install.setDataAndType(apk, "application/vnd.android.package-archive");
        install.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try { getContext().startActivity(install); } catch (Exception ignored) {}
    }

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String url = call.getString("url");
        String fileName = call.getString("fileName", "application.apk");
        if (url == null || !url.startsWith("https://")) {
            call.reject("A secure APK URL is required"); return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + getContext().getPackageName()));
            settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(settings);
            JSObject result = new JSObject(); result.put("permissionRequired", true);
            call.resolve(result); return;
        }

        DownloadManager manager = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
        DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
        request.setTitle(fileName);
        request.setDescription("Downloading from RX Store");
        // VISIBILITY_VISIBLE (not VISIBILITY_VISIBLE_NOTIFY_COMPLETED) keeps the
        // download indicator lightweight; the in-page progress bar carries the UX.
        request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE);
        request.setMimeType("application/vnd.android.package-archive");
        request.setDestinationInExternalFilesDir(getContext(), Environment.DIRECTORY_DOWNLOADS, fileName.replaceAll("[^a-zA-Z0-9._-]", "_"));
        long id = manager.enqueue(request);

        JSObject result = new JSObject(); result.put("started", true); result.put("downloadId", id);
        call.resolve(result);
        startProgressPolling(manager, id);
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.parse("package:" + getContext().getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }
}
