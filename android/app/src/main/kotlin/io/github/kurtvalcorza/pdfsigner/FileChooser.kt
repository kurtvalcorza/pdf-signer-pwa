package io.github.kurtvalcorza.pdfsigner

import android.net.Uri
import android.util.Log
import android.webkit.ValueCallback
import android.webkit.WebChromeClient.FileChooserParams
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts

/**
 * `onShowFileChooser` through the system picker (contract shell-bridge §4, R8). Single selection,
 * no runtime permission (FR-010), and the WebView callback is called exactly once on every path:
 * a result, a cancel, a refusal or an error (null).
 *
 * Must be constructed while the activity is being created (it registers an ActivityResult launcher).
 */
class FileChooser(activity: ComponentActivity) {
  private var pending: ValueCallback<Array<Uri>>? = null

  private val openDocument = activity.registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
    deliver(uri?.let { arrayOf(it) })
  }

  fun show(callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
    // A chooser still open from before is answered (null) before the new one replaces it.
    deliver(null)
    pending = callback
    try {
      if (params.isCaptureEnabled) {
        // The camera branch lands with US4 (T037). Until then a capture request is refused.
        Log.i(LOG_TAG, "CHOOSER capture refused (not implemented)")
        deliver(null)
        return true
      }
      val mimes = AcceptRules.mimeTypes(params.acceptTypes)
      if (mimes == null) {
        Log.w(LOG_TAG, "CHOOSER refused accept=${params.acceptTypes.joinToString()}")
        deliver(null)
        return true
      }
      openDocument.launch(mimes)
    } catch (e: Exception) {
      Log.e(LOG_TAG, "CHOOSER failed", e)
      deliver(null)
    }
    return true
  }

  private fun deliver(uris: Array<Uri>?) {
    val cb = pending ?: return
    pending = null
    cb.onReceiveValue(uris)
  }
}
