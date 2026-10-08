package dev.sshdeck.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.util.AttributeSet;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputMethodManager;
import android.webkit.ConsoleMessage;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;

/** Tek ekran: arayüz WebView'da (assets/www), SSH işleri App/SshCore'da. */
public class MainActivity extends Activity {
    static final String ORIGIN = "https://appassets.androidplatform.net/";
    static final int REQ_PICK = 10, REQ_PICK_MULTI = 11, REQ_NOTIF = 12;

    FrameLayout root;
    TermWebView web;
    Bridge bridge;
    BlockingQueue<List<Uri>> pickResult;

    /** Terminal odaktayken klavyeyi "görünür parola" kipine al: öneri/otomatik düzeltme yok, tuşlar tek tek gelir. */
    public static class TermWebView extends WebView {
        boolean termMode;

        public TermWebView(Context c) { super(c); }
        public TermWebView(Context c, AttributeSet a) { super(c, a); }

        @Override public InputConnection onCreateInputConnection(EditorInfo out) {
            InputConnection ic = super.onCreateInputConnection(out);
            if (termMode && ic != null) {
                out.inputType = InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS;
                out.imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI | EditorInfo.IME_FLAG_NO_FULLSCREEN
                        | EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING | EditorInfo.IME_ACTION_NONE;
            }
            return ic;
        }
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        else getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0f1115"));
        web = new TermWebView(this);
        web.setBackgroundColor(Color.parseColor("#0f1115"));
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);

        // Sistem çubukları + klavye kadar iç boşluk: WebView klavye açılınca küçülür
        root.setOnApplyWindowInsetsListener((v, ins) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                Insets sys = ins.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                Insets ime = ins.getInsets(WindowInsets.Type.ime());
                v.setPadding(sys.left, sys.top, sys.right, Math.max(sys.bottom, ime.bottom));
                return WindowInsets.CONSUMED;
            }
            v.setPadding(ins.getSystemWindowInsetLeft(), ins.getSystemWindowInsetTop(),
                    ins.getSystemWindowInsetRight(), ins.getSystemWindowInsetBottom());
            return ins.consumeSystemWindowInsets();
        });

        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setAllowFileAccess(false);
        ws.setAllowContentAccess(false);
        ws.setTextZoom(100);
        ws.setSupportZoom(false);
        ws.setMediaPlaybackRequiresUserGesture(true);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                return asset(req.getUrl());
            }

            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (u.toString().startsWith(ORIGIN)) return false;
                openUrl(u.toString());
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage m) {
                android.util.Log.d("SSHDeck-js", m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
                return true;
            }
        });
        web.setForceDarkAllowed(false);
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0);

        bridge = new Bridge(this);
        web.addJavascriptInterface(bridge, "SSHDeckNative");
        App.I.bridge = bridge;
        // Activity yeniden yaratıldıysa (ör. sistem öldürdü) eski bağlantıların arayüzü kayboldu: kapat
        if (App.I.core.count() > 0) {
            App.I.core.disconnectAll();
            App.I.updateService();
        }
        web.loadUrl(ORIGIN + "index.html");
    }

    WebResourceResponse asset(Uri u) {
        String s = u.toString();
        if (!s.startsWith(ORIGIN)) return null;
        String path = u.getPath();
        if (path == null || path.equals("/")) path = "/index.html";
        String ext = path.substring(path.lastIndexOf('.') + 1);
        String mime;
        switch (ext) {
            case "html": mime = "text/html"; break;
            case "js": case "mjs": mime = "text/javascript"; break;
            case "css": mime = "text/css"; break;
            case "svg": mime = "image/svg+xml"; break;
            case "png": mime = "image/png"; break;
            case "woff2": mime = "font/woff2"; break;
            case "ttf": mime = "font/ttf"; break;
            default: mime = "application/octet-stream";
        }
        try {
            InputStream in = getAssets().open("www" + path);
            WebResourceResponse r = new WebResourceResponse(mime, "UTF-8", in);
            Map<String, String> h = new HashMap<>();
            h.put("Cache-Control", "no-cache");
            r.setResponseHeaders(h);
            return r;
        } catch (Exception e) {
            return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", null, null);
        }
    }

    void js(String code) {
        if (web != null) web.evaluateJavascript(code, null);
    }

    // ------------------------------------------------------------------ UI yardımcıları (ana iş parçacığı)
    void setTermInput(boolean on) {
        if (web.termMode == on) return;
        web.termMode = on;
        InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        imm.restartInput(web);
    }

    void showKeyboard() {
        web.requestFocus();
        InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        imm.showSoftInput(web, InputMethodManager.SHOW_IMPLICIT);
    }

    void hideKeyboard() {
        InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        imm.hideSoftInputFromWindow(web.getWindowToken(), 0);
    }

    void keepScreenOn(boolean on) {
        if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    void barColors(String bg, boolean light) {
        try {
            int c = Color.parseColor(bg);
            root.setBackgroundColor(c);
            web.setBackgroundColor(c);
        } catch (Exception ignored) { }
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController ic = getWindow().getInsetsController();
            if (ic != null) {
                int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                ic.setSystemBarsAppearance(light ? mask : 0, mask);
            }
        } else {
            View d = getWindow().getDecorView();
            int f = d.getSystemUiVisibility();
            f = light ? f | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
                    : f & ~(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
            d.setSystemUiVisibility(f);
        }
    }

    void openUrl(String url) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception ignored) { }
    }

    String clipboardText() throws Exception {
        BlockingQueue<String> q = new ArrayBlockingQueue<>(1);
        runOnUiThread(() -> {
            String t = "";
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData cd = cm.getPrimaryClip();
            if (cd != null && cd.getItemCount() > 0) {
                CharSequence s = cd.getItemAt(0).coerceToText(this);
                if (s != null) t = s.toString();
            }
            q.offer(t);
        });
        return q.take();
    }

    void askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF);
    }

    /** Dosya seçici (SAF). Köprü iş parçacığından çağrılır, sonuç gelene kadar bloklar. */
    List<Uri> pickFiles(boolean multi) throws InterruptedException {
        BlockingQueue<List<Uri>> q = new ArrayBlockingQueue<>(1);
        runOnUiThread(() -> {
            pickResult = q;
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
            if (multi) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            try {
                startActivityForResult(i, multi ? REQ_PICK_MULTI : REQ_PICK);
            } catch (Exception e) {
                pickResult = null;
                q.offer(new ArrayList<>());
            }
        });
        return q.take();
    }

    @Override protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != REQ_PICK && req != REQ_PICK_MULTI) return;
        List<Uri> out = new ArrayList<>();
        if (res == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                ClipData cd = data.getClipData();
                for (int i = 0; i < cd.getItemCount(); i++) out.add(cd.getItemAt(i).getUri());
            } else if (data.getData() != null) out.add(data.getData());
        }
        BlockingQueue<List<Uri>> q = pickResult;
        pickResult = null;
        if (q != null) q.offer(out);
    }

    // ------------------------------------------------------------------ yaşam döngüsü
    @SuppressWarnings("deprecation")
    @Override public void onBackPressed() {
        web.evaluateJavascript("window.__nback?window.__nback():false", (ValueCallback<String>) v -> {
            if ("true".equals(v)) return;
            if (App.I.core.count() > 0) moveTaskToBack(true);
            else finish();
        });
    }

    @Override protected void onPause() {
        super.onPause();
        js("window.__npause&&window.__npause()");
    }

    @Override protected void onResume() {
        super.onResume();
        js("window.__nresume&&window.__nresume()");
    }

    @Override protected void onDestroy() {
        if (App.I.bridge == bridge) App.I.bridge = null;
        App.I.cancelAsks();
        if (isFinishing()) {
            App.I.core.disconnectAll();
            App.I.updateService();
        }
        web.destroy();
        web = null;
        super.onDestroy();
    }
}
