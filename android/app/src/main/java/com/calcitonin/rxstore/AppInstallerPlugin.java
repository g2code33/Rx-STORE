package com.calcitonin.rxstore;

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
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
    public void isInstalled(PluginCall call) {
        String packageId = call.getString("packageId", "");
        boolean installed = false;
        if (!packageId.isEmpty()) {
            try { getContext().getPackageManager().getPackageInfo(packageId, 0); installed = true; }
            catch (Exception ignored) {}
        }
        JSObject result = new JSObject(); result.put("installed", installed); call.resolve(result);
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
        request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        request.setMimeType("application/vnd.android.package-archive");
        request.setDestinationInExternalFilesDir(getContext(), Environment.DIRECTORY_DOWNLOADS, fileName.replaceAll("[^a-zA-Z0-9._-]", "_"));
        long id = manager.enqueue(request);

        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                if (intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1) != id) return;
                Uri apk = manager.getUriForDownloadedFile(id);
                if (apk != null) {
                    Intent install = new Intent(Intent.ACTION_VIEW);
                    install.setDataAndType(apk, "application/vnd.android.package-archive");
                    install.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    context.startActivity(install);
                }
                try { context.unregisterReceiver(this); } catch (Exception ignored) {}
            }
        };
        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= 33) getContext().registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
        else getContext().registerReceiver(receiver, filter);
        JSObject result = new JSObject(); result.put("started", true); result.put("downloadId", id);
        call.resolve(result);
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
