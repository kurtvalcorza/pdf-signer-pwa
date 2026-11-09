package io.github.kurtvalcorza.pdfsigner

import android.content.ActivityNotFoundException
import android.net.Uri
import android.util.Log
import android.webkit.ValueCallback
import android.webkit.WebChromeClient.FileChooserParams
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import java.io.File
import java.util.UUID

/**
 * `onShowFileChooser` through the system picker or a camera app (contract shell-bridge §4, R8).
 * Single selection, no runtime permission (FR-010, FR-011: the manifest declares no CAMERA), and
 * the WebView callback is called exactly once on every path: a result, a cancel, a refusal, a
 * missing camera app or an error (null).
 *
 * Must be constructed while the activity is being created (it registers ActivityResult launchers).
 */
class FileChooser(private val activity: ComponentActivity) {
  private var pending: ValueCallback<Array<Uri>>? = null

  /**
   * The capture file (data model "Capture file"). WebView reads a chooser URI lazily, when the
   * page reads the File, so it is not deleted the moment it's handed over: it goes at the next
   * chooser, when the activity is destroyed, and with all of cache/capture/ on every launch.
   */
  private var capture: File? = null

  private val openDocument = activity.registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
    deliver(uri?.let { arrayOf(it) })
  }

  private val takePicture = activity.registerForActivityResult(ActivityResultContracts.TakePicture()) { saved ->
    val file = capture
    if (saved && file != null && file.length() > 0) {
      Log.i(LOG_TAG, "CHOOSER capture bytes=${file.length()}")
      deliver(arrayOf(uriFor(file)))
    } else {
      Log.i(LOG_TAG, "CHOOSER capture cancelled")
      discardCapture()
      deliver(null)
    }
  }

  fun show(callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
    // A chooser still open from before is answered (null) before the new one replaces it.
    deliver(null)
    discardCapture()
    pending = callback
    try {
      if (params.isCaptureEnabled) {
        if (!AcceptRules.captureAllowed(params.acceptTypes)) {
          Log.w(LOG_TAG, "CHOOSER capture refused accept=${params.acceptTypes.joinToString()}")
          deliver(null)
        } else {
          startCapture()
        }
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
      discardCapture()
      deliver(null)
    }
    return true
  }

  /** Deletes the current capture file, if any. Called by the activity when it is destroyed. */
  fun discardCapture() {
    capture?.let { if (!it.delete() && it.exists()) Log.w(LOG_TAG, "CHOOSER capture not deleted") }
    capture = null
  }

  private fun startCapture() {
    val dir = File(activity.cacheDir, "capture").apply { mkdirs() }
    val file = File(dir, "${UUID.randomUUID()}.jpg")
    capture = file
    try {
      takePicture.launch(uriFor(file))
      Log.i(LOG_TAG, "CHOOSER capture started")
    } catch (e: ActivityNotFoundException) {
      Log.i(LOG_TAG, "CHOOSER capture: no camera app")
      discardCapture()
      deliver(null)
    }
  }

  private fun uriFor(file: File): Uri =
    FileProvider.getUriForFile(activity, "${activity.packageName}.capture", file)

  private fun deliver(uris: Array<Uri>?) {
    val cb = pending ?: return
    pending = null
    cb.onReceiveValue(uris)
  }
}
