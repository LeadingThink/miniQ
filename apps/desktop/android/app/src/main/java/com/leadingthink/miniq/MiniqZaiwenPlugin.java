package com.leadingthink.miniq;

import android.graphics.Bitmap;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.InputMethodManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.io.InputStreamReader;
import org.json.JSONObject;

/** A plain WebView: never attach the Capacitor bridge or a JS interface. */
@CapacitorPlugin(name = "MiniqZaiwen")
public class MiniqZaiwenPlugin extends Plugin {
    private WebView site;
    private FrameLayout container;
    private boolean visible;
    private boolean loading;
    private String failure;
    private String script;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable loadTimeout = () -> {
        failed();
        if (site != null) site.stopLoading();
    };

    private void started() {
        loading = true; failure = null; applyVisibility();
        handler.removeCallbacks(loadTimeout);
        handler.postDelayed(loadTimeout, 30000);
    }

    private JSObject snapshot() {
        JSObject state = new JSObject();
        state.put("loading", loading);
        state.put("canGoBack", site != null && site.canGoBack());
        state.put("error", failure == null ? JSONObject.NULL : failure);
        return state;
    }

    private void applyVisibility() {
        if (container != null) container.setVisibility(visible && !loading && failure == null ? View.VISIBLE : View.INVISIBLE);
    }

    private String loadScript(String name) throws IOException {
        StringBuilder result = new StringBuilder();
        try (InputStreamReader reader = new InputStreamReader(getContext().getAssets().open("public/" + name + ".js"), java.nio.charset.StandardCharsets.UTF_8)) {
            char[] buffer = new char[4096];
            int count;
            while ((count = reader.read(buffer)) != -1) result.append(buffer, 0, count);
        }
        return result.toString();
    }

    private void createSite() throws IOException {
        script = "window.__MINIQ_MOBILE_SITE__ = true;\n" + loadScript("zaiwen_site") + "\n" + loadScript("zaiwen_mobile");
        site = new WebView(getActivity());
        WebSettings settings = site.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        // target=_blank stays in this isolated view instead of creating a popup.
        settings.setSupportMultipleWindows(false);
        site.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String target = request.getUrl().toString();
                if (ZaiwenNavigation.requestsMenu(target, view.getUrl(), request.isForMainFrame())
                    || ZaiwenNavigation.requestsPlatformSwitch(target, view.getUrl(), request.isForMainFrame())) {
                    visible = false; applyVisibility();
                    JSObject data = new JSObject();
                    if (ZaiwenNavigation.requestsPlatformSwitch(target, view.getUrl(), request.isForMainFrame())) data.put("platform", "miniq");
                    notifyListeners("platformMenuRequested", data);
                    return true;
                }
                return !ZaiwenNavigation.allows(request.getUrl().toString());
            }
            @Override public void onPageStarted(WebView view, String url, Bitmap favicon) {
                started();
            }
            @Override public void onPageFinished(WebView view, String url) {
                // The shared script itself restricts execution to the exact site origin.
                view.evaluateJavascript(script, null);
                handler.removeCallbacks(loadTimeout);
                loading = false; applyVisibility();
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) failed();
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame()) failed();
            }
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                failed(); destroySite(); return true;
            }
        });
        site.setWebChromeClient(new WebChromeClient());
        container = new FrameLayout(getActivity());
        container.addView(site, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        ViewGroup parent = (ViewGroup) bridge.getWebView().getParent();
        parent.addView(container, new ViewGroup.LayoutParams(1, 1));
        started();
        site.loadUrl(ZaiwenNavigation.HOME);
    }

    @PluginMethod public void update(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!Boolean.TRUE.equals(call.getBoolean("visible"))) {
                visible = false;
                if (site != null) {
                    site.clearFocus();
                    InputMethodManager input = getContext().getSystemService(InputMethodManager.class);
                    if (input != null) input.hideSoftInputFromWindow(site.getWindowToken(), 0);
                }
                applyVisibility(); call.resolve(snapshot()); return;
            }
            Double x = call.getDouble("x"), y = call.getDouble("y"), width = call.getDouble("width"), height = call.getDouble("height"), viewport = call.getDouble("viewportWidth");
            if (!finite(x) || !finite(y) || !finite(width) || !finite(height) || !finite(viewport)
                || x < 0 || y < 0 || width <= 0 || height <= 0 || viewport <= 0) {
                call.reject("在问页面区域无效。"); return;
            }
            WebView primary = bridge.getWebView();
            double scale = primary.getWidth() / viewport;
            int left = (int) Math.round(x * scale), top = (int) Math.round(y * scale);
            int w = Math.min((int) Math.round(width * scale), primary.getWidth() - left);
            int h = Math.min((int) Math.round(height * scale), primary.getHeight() - top);
            if (w <= 0 || h <= 0) { call.reject("在问页面区域无效。"); return; }
            try { if (site == null) createSite(); }
            catch (IOException error) { call.reject("主站资源未就绪，请重新构建手机版。"); return; }
            container.getLayoutParams().width = w;
            container.getLayoutParams().height = h;
            container.setX(primary.getX() + left);
            container.setY(primary.getY() + top);
            container.requestLayout();
            visible = true; applyVisibility(); call.resolve(snapshot());
        });
    }

    private static boolean finite(Double value) { return value != null && !value.isNaN() && !value.isInfinite(); }

    @PluginMethod public void getState(PluginCall call) {
        getActivity().runOnUiThread(() -> call.resolve(snapshot()));
    }

    @PluginMethod public void reload(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try { if (site == null) createSite(); }
            catch (IOException error) { call.reject("主站资源未就绪，请重新构建手机版。"); return; }
            started();
            if (ZaiwenNavigation.allows(site.getUrl())) site.reload();
            else site.loadUrl(ZaiwenNavigation.HOME);
            call.resolve(snapshot());
        });
    }

    @PluginMethod public void goBack(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            boolean navigated = site != null && site.canGoBack();
            if (navigated) { failure = null; site.goBack(); }
            JSObject result = new JSObject(); result.put("navigated", navigated); call.resolve(result);
        });
    }

    private void failed() {
        handler.removeCallbacks(loadTimeout);
        loading = false; failure = "无法连接在问主站，请检查网络后重试。"; applyVisibility();
    }

    private void destroySite() {
        handler.removeCallbacks(loadTimeout);
        if (container != null) {
            if (container.getParent() instanceof ViewGroup) ((ViewGroup) container.getParent()).removeView(container);
            container.removeAllViews(); container = null;
        }
        if (site != null) { site.stopLoading(); site.destroy(); site = null; }
    }

    @Override protected void handleOnDestroy() { getActivity().runOnUiThread(this::destroySite); }
}
