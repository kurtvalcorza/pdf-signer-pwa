package io.github.kurtvalcorza.pdfsigner

import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.webkit.ServiceWorkerClientCompat
import androidx.webkit.ServiceWorkerControllerCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.File

/** The shared app's repository link: the one URL that may leave the app, to the system browser. */
private const val REPO_URL = "https://github.com/kurtvalcorza/pdf-signer-pwa"
private const val KEY_RENDERER_GONE = "rendererGone"

/**
 * Hosts the unchanged web build (contract shell-bridge §6). Owns nothing the web app reads.
 */
class MainActivity : ComponentActivity() {
  private lateinit var webView: WebView
  private lateinit var assetHandler: AppAssetHandler
  private val fileChooser = FileChooser(this)
  private val saveBridge = SaveBridge(this)
  private var rendererGone = false

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // R9, FR-023: before any content exists.
    window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
    if (Build.VERSION.SDK_INT >= 33) setRecentsScreenshotEnabled(false)
    // Data model "Capture file": cleared on every launch.
    File(cacheDir, "capture").deleteRecursively()

    val pkg = WebViewCompat.getCurrentWebViewPackage(this)
    Log.i(LOG_TAG, "WEBVIEW package=${pkg?.packageName} version=${pkg?.versionName}")

    val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
    WebView.setWebContentsDebuggingEnabled(debuggable)

    assetHandler = AppAssetHandler(this)

    // R4: service-worker requests go through the same handler, so they can't reach the network.
    if (WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_BASIC_USAGE) &&
      WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_SHOULD_INTERCEPT_REQUEST)
    ) {
      ServiceWorkerControllerCompat.getInstance().setServiceWorkerClient(object : ServiceWorkerClientCompat() {
        override fun shouldInterceptRequest(request: WebResourceRequest): WebResourceResponse =
          assetHandler.intercept(request, "SW")
      })
    }

    webView = WebView(this)
    setContentView(webView)
    webView.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true
      allowFileAccess = false
      allowContentAccess = false
      setSupportMultipleWindows(false)
      safeBrowsingEnabled = false
    }
    // Saving goes through shell.js and the save dialog; the WebView's own download path is unused.
    webView.setDownloadListener { _, _, _, _, _ -> Log.w(LOG_TAG, "DOWNLOAD ignored") }

    webView.webViewClient = object : WebViewClient() {
      override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse =
        assetHandler.intercept(request, "PAGE")

      // Spec edge case "Very large inputs": a phone that runs out of memory must fail with a
      // message, not a crash. When the renderer dies, the WebView is unusable: drop it, rebuild
      // the activity, and say what happened. Nothing was saved (saving runs after signing).
      override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        Log.w(LOG_TAG, "RENDERER gone crashed=${detail.didCrash()}")
        rendererGone = true
        (view.parent as? ViewGroup)?.removeView(view)
        view.destroy()
        recreate()
        return true
      }

      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val url = request.url
        if (url.scheme == "https" && url.host == APP_HOST && url.port == -1) return false
        if (url.toString().trimEnd('/') == REPO_URL) {
          try {
            startActivity(Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE))
          } catch (_: ActivityNotFoundException) {
          }
        } else {
          Log.w(LOG_TAG, "NAV blocked")
        }
        return true
      }
    }

    webView.webChromeClient = object : WebChromeClient() {
      override fun onShowFileChooser(
        view: WebView,
        callback: ValueCallback<Array<Uri>>,
        params: FileChooserParams,
      ): Boolean = fileChooser.show(callback, params)
    }

    // R7: the injected save interception, app origin only, and its origin-restricted channel.
    if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
      val script = assets.open("shell/shell.js").bufferedReader().use { it.readText() }
      WebViewCompat.addDocumentStartJavaScript(webView, script, setOf(APP_ORIGIN))
    } else {
      Log.w(LOG_TAG, "DOCUMENT_START_SCRIPT unsupported: saving is unavailable")
    }
    if (!saveBridge.attach(webView)) Log.w(LOG_TAG, "WEB_MESSAGE_LISTENER unsupported: saving is unavailable")

    if (savedInstanceState?.getBoolean(KEY_RENDERER_GONE) == true) {
      AlertDialog.Builder(this)
        .setTitle(R.string.renderer_gone_title)
        .setMessage(R.string.renderer_gone_message)
        .setPositiveButton(android.R.string.ok, null)
        .show()
    } else if (savedInstanceState != null) {
      webView.restoreState(savedInstanceState)
    }
    if (webView.url == null) webView.loadUrl("$APP_ORIGIN/")
  }

  override fun onSaveInstanceState(outState: Bundle) {
    super.onSaveInstanceState(outState)
    if (rendererGone) outState.putBoolean(KEY_RENDERER_GONE, true) else webView.saveState(outState)
  }

  @Deprecated("Back navigation stays inside the app")
  override fun onBackPressed() {
    if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
  }

  override fun onDestroy() {
    if (!rendererGone) webView.destroy()
    super.onDestroy()
  }
}
