package io.github.kurtvalcorza.pdfsigner

import android.content.Context
import android.util.Log
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream
import java.io.IOException

const val APP_HOST = "appassets.androidplatform.net"
const val APP_ORIGIN = "https://$APP_HOST"
const val LOG_TAG = "PdfSignerShell"

/**
 * Serves `assets/www` at the origin root (contract shell-bridge §1). Never returns null: a
 * null from a path handler falls through to the network, so a miss is an explicit 404 (R2).
 */
class AppAssetHandler(private val context: Context) : WebViewAssetLoader.PathHandler {
  private val loader: WebViewAssetLoader = WebViewAssetLoader.Builder()
    .setDomain(APP_HOST)
    .addPathHandler("/", this)
    .build()

  override fun handle(path: String): WebResourceResponse =
    when (val r = PathRules.resolve(path)) {
      PathRules.NotFound -> {
        Log.w(LOG_TAG, "404 rejected path=$path")
        notFound()
      }
      is PathRules.Asset -> try {
        WebResourceResponse(r.mime, r.encoding, 200, "OK", PathRules.headers(), context.assets.open(r.assetPath))
      } catch (_: IOException) {
        Log.w(LOG_TAG, "404 path=$path")
        notFound()
      }
    }

  /**
   * Used by both the page's WebViewClient and the ServiceWorkerClientCompat (R4). Off-origin
   * requests get a 403 and a log line, never a fall-through.
   */
  fun intercept(request: WebResourceRequest, who: String): WebResourceResponse {
    val url = request.url
    if (url.scheme == "https" && url.host == APP_HOST && url.port == -1) {
      return loader.shouldInterceptRequest(url) ?: notFound()
    }
    Log.w(LOG_TAG, "403 blocked by=$who url=$url")
    return forbidden()
  }

  companion object {
    fun notFound() = empty(404, "Not Found")
    fun forbidden() = empty(403, "Forbidden")
    private fun empty(code: Int, reason: String) =
      WebResourceResponse("text/plain", "utf-8", code, reason, emptyMap(), ByteArrayInputStream(ByteArray(0)))
  }
}
