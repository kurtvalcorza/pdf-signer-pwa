package io.github.kurtvalcorza.pdfsigner

import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
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
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.widget.FrameLayout
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.activity.ComponentActivity
import androidx.webkit.ServiceWorkerClientCompat
import androidx.webkit.ServiceWorkerControllerCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** The shared app's repository link: the one URL that may leave the app, to the system browser. */
private const val REPO_URL = "https://github.com/kurtvalcorza/pdf-signer-pwa"
private const val KEY_RENDERER_GONE = "rendererGone"

/**
 * Hosts the unchanged web build (contract shell-bridge §6). Owns nothing the web app reads.
 */
class MainActivity : ComponentActivity() {
  private var webView: WebView? = null
  private lateinit var assetHandler: AppAssetHandler
  private lateinit var about: AboutInfo.Inputs
  private val fileChooser = FileChooser(this)
  private val saveBridge = SaveBridge(this) { type -> if (type == "about-request") aboutMessage() else null }
  private var rendererGone = false

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // R9, FR-023: before any content exists.
    window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
    if (Build.VERSION.SDK_INT >= 33) setRecentsScreenshotEnabled(false)
    // Data model "Capture file": cleared on every launch.
    File(cacheDir, "capture").deleteRecursively()

    // R11: read the engine BEFORE creating a WebView. Below the hard minimum, or with no or a
    // disabled provider, the web app is never loaded.
    val pkg = try {
      WebViewCompat.getCurrentWebViewPackage(this)
    } catch (e: Exception) {
      Log.w(LOG_TAG, "WEBVIEW package unreadable", e)
      null
    }
    val engine = EngineCheck.evaluate(
      pkg?.versionName,
      pkg?.let { providerEnabled(it.packageName, it.applicationInfo?.enabled ?: false) } ?: false,
      BuildConfig.WEBVIEW_HARD_MIN,
      BuildConfig.WEBVIEW_VALIDATED_FLOOR,
    )
    Log.i(LOG_TAG, "WEBVIEW package=${pkg?.packageName} version=${pkg?.versionName} engine=${engine.state} reason=${engine.reason}")
    about = AboutInfo.Inputs(
      BuildConfig.VERSION_NAME,
      BuildConfig.SOURCE_COMMIT,
      pkg?.versionName,
      BuildConfig.WEBVIEW_VALIDATED_FLOOR,
      engine.state,
    )
    if (engine.state == EngineCheck.State.REFUSED) {
      showRefused(engine, pkg?.versionName)
      return
    }

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

    val view = WebView(this)
    webView = view
    // targetSdk 36 forces edge-to-edge: without insets the page draws under the status and
    // navigation bars, and taps near the top land on the system bar. Inset it like a browser
    // would (and for the keyboard, which adjustResize no longer handles edge-to-edge).
    val container = FrameLayout(this)
    container.addView(view, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
    ViewCompat.setOnApplyWindowInsetsListener(container) { v, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime(),
      )
      v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
    setContentView(container)
    view.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true
      allowFileAccess = false
      allowContentAccess = false
      setSupportMultipleWindows(false)
      safeBrowsingEnabled = false
    }
    // Saving goes through shell.js and the save dialog; the WebView's own download path is unused.
    view.setDownloadListener { _, _, _, _, _ -> Log.w(LOG_TAG, "DOWNLOAD ignored") }

    view.webViewClient = object : WebViewClient() {
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
        webView = null
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

    view.webChromeClient = object : WebChromeClient() {
      override fun onShowFileChooser(
        view: WebView,
        callback: ValueCallback<Array<Uri>>,
        params: FileChooserParams,
      ): Boolean = fileChooser.show(callback, params)
    }

    // R7: the injected script (save interception + the shell's About panel), app origin only,
    // and its origin-restricted channel.
    if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
      val script = assets.open("shell/shell.js").bufferedReader().use { it.readText() }
      WebViewCompat.addDocumentStartJavaScript(view, script, setOf(APP_ORIGIN))
    } else {
      Log.w(LOG_TAG, "DOCUMENT_START_SCRIPT unsupported: saving is unavailable")
    }
    if (!saveBridge.attach(view)) Log.w(LOG_TAG, "WEB_MESSAGE_LISTENER unsupported: saving is unavailable")

    if (savedInstanceState?.getBoolean(KEY_RENDERER_GONE) == true) {
      AlertDialog.Builder(this)
        .setTitle(R.string.renderer_gone_title)
        .setMessage(R.string.renderer_gone_message)
        .setPositiveButton(android.R.string.ok, null)
        .show()
    } else if (savedInstanceState != null) {
      view.restoreState(savedInstanceState)
    }
    if (view.url == null) view.loadUrl("$APP_ORIGIN/")
  }

  /**
   * The provider's live enabled setting. `getCurrentWebViewPackage()` returns the package already
   * loaded, which still reads as enabled after `pm disable-user` (Q7, 2026-11-08). If the setting
   * can't be read (package visibility), fall back to that value rather than refuse wrongly.
   */
  private fun providerEnabled(packageName: String, fallback: Boolean): Boolean = try {
    val setting = packageManager.getApplicationEnabledSetting(packageName)
    Log.i(LOG_TAG, "WEBVIEW enabledSetting=$setting")
    when (setting) {
      PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
      PackageManager.COMPONENT_ENABLED_STATE_DISABLED_USER,
      PackageManager.COMPONENT_ENABLED_STATE_DISABLED_UNTIL_USED,
      -> false
      else -> fallback
    }
  } catch (e: IllegalArgumentException) {
    Log.w(LOG_TAG, "WEBVIEW enabled setting unreadable; using the loaded package's flag")
    fallback
  }

  /** The reply to shell.js's `about-request` (contract shell-bridge §5). */
  private fun aboutMessage(): JSONObject = JSONObject()
    .put("type", "about")
    .put("title", AboutInfo.title(about))
    .put("lines", JSONArray(AboutInfo.lines(about)))
    .put("banner", AboutInfo.banner(about) ?: JSONObject.NULL)

  /** R11 REFUSED: a native screen; no WebView is created and the web app never loads. */
  private fun showRefused(engine: EngineCheck.Result, versionName: String?) {
    setContentView(R.layout.refused)
    val reason = when (engine.reason) {
      EngineCheck.Reason.TOO_OLD ->
        getString(R.string.refused_too_old, engine.major ?: 0, BuildConfig.WEBVIEW_HARD_MIN)
      EngineCheck.Reason.DISABLED -> getString(R.string.refused_disabled)
      EngineCheck.Reason.UNREADABLE_VERSION -> getString(R.string.refused_unreadable, versionName ?: "")
      EngineCheck.Reason.NO_PROVIDER, null -> getString(R.string.refused_no_provider)
    }
    findViewById<TextView>(R.id.refused_reason).text = reason
  }

  override fun onSaveInstanceState(outState: Bundle) {
    super.onSaveInstanceState(outState)
    if (rendererGone) outState.putBoolean(KEY_RENDERER_GONE, true) else webView?.saveState(outState)
  }

  @Deprecated("Back navigation stays inside the app")
  override fun onBackPressed() {
    val view = webView
    if (view != null && view.canGoBack()) view.goBack() else super.onBackPressed()
  }

  override fun onDestroy() {
    webView?.destroy()
    webView = null
    super.onDestroy()
  }
}
