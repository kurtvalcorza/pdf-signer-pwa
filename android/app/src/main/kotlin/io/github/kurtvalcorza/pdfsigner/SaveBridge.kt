package io.github.kurtvalcorza.pdfsigner

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.DocumentsContract
import android.util.Log
import android.webkit.WebView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContract
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.Executors

const val SHELL_CHANNEL = "pdfSignerShell"
private const val RECEIVE_TIMEOUT_MS = 60_000L

/** ACTION_CREATE_DOCUMENT with a MIME type chosen per call. */
private class CreateDocument : ActivityResultContract<Pair<String, String>, Uri?>() {
  override fun createIntent(context: Context, input: Pair<String, String>): Intent =
    Intent(Intent.ACTION_CREATE_DOCUMENT)
      .addCategory(Intent.CATEGORY_OPENABLE)
      .setType(input.second)
      .putExtra(Intent.EXTRA_TITLE, input.first)

  override fun parseResult(resultCode: Int, intent: Intent?): Uri? =
    if (resultCode == android.app.Activity.RESULT_OK) intent?.data else null
}

/**
 * The save side of the shell bridge (contract shell-bridge §3, R7). Receives a finished `blob:`
 * download from `shell.js`, asks where to save it, and writes it there. Bytes live in memory only
 * and are dropped on every terminal state; nothing is written to app storage.
 *
 * Must be constructed while the activity is being created (it registers an ActivityResult launcher).
 */
class SaveBridge(
  private val activity: ComponentActivity,
  /** Answers the channel's non-save messages (the About panel's `about-request`); null = unknown. */
  private val onOtherMessage: (type: String) -> JSONObject? = { null },
) {
  private val session = SaveSession()
  private val main = Handler(Looper.getMainLooper())
  private val io = Executors.newSingleThreadExecutor()
  private var reply: JavaScriptReplyProxy? = null

  private val createDocument = activity.registerForActivityResult(CreateDocument()) { uri -> onLocation(uri) }

  /** Returns false when the WebView lacks the message-listener feature. */
  fun attach(webView: WebView): Boolean {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return false
    WebViewCompat.addWebMessageListener(webView, SHELL_CHANNEL, setOf(APP_ORIGIN)) { _, message, origin, isMainFrame, proxy ->
      if (origin.toString().trimEnd('/') != APP_ORIGIN || !isMainFrame) {
        Log.w(LOG_TAG, "MSG dropped origin=$origin main=$isMainFrame")
      } else {
        reply = proxy
        onMessage(message)
      }
    }
    return true
  }

  private fun onMessage(message: WebMessageCompat) {
    if (message.type == WebMessageCompat.TYPE_ARRAY_BUFFER) {
      handle(session.buffer(message.arrayBuffer))
      return
    }
    val json = try {
      JSONObject(message.data ?: return)
    } catch (_: Exception) {
      Log.w(LOG_TAG, "MSG malformed")
      return
    }
    val id = if (json.has("id")) json.optInt("id") else null
    when (json.optString("type")) {
      "save-begin" -> {
        val step = session.begin(
          id,
          if (json.has("name")) json.optString("name") else null,
          json.optString("mime", ""),
          if (json.has("size")) json.optLong("size", -1) else null,
        )
        if (step is SaveStep.Refused) {
          Log.w(LOG_TAG, "SAVE refused: ${step.reason}")
          toast("Couldn't save: ${step.reason}")
          post(id, "failed", step.reason)
          return
        }
        if (step is SaveStep.Receiving) {
          val tid = step.transfer.id
          main.postDelayed({ handle(session.timeout(tid)) }, RECEIVE_TIMEOUT_MS)
          Log.i(LOG_TAG, "SAVE begin id=$tid mime=${step.transfer.mime} size=${step.transfer.size}")
        }
      }
      "save-chunk" -> handle(session.chunk(id, if (json.has("seq")) json.optInt("seq") else null, json.optString("data", null)))
      "save-end" -> handle(session.end(id))
      else -> {
        val answer = onOtherMessage(json.optString("type"))
        if (answer == null) {
          Log.w(LOG_TAG, "MSG unknown type")
        } else {
          try {
            reply?.postMessage(answer.toString())
          } catch (e: Exception) {
            Log.w(LOG_TAG, "MSG reply failed", e)
          }
        }
      }
    }
  }

  private fun handle(step: SaveStep) {
    when (step) {
      is SaveStep.Receiving -> Unit
      is SaveStep.Refused -> Log.w(LOG_TAG, "SAVE ignored: ${step.reason}")
      is SaveStep.AskLocation -> {
        Log.i(LOG_TAG, "SAVE received id=${step.transfer.id} bytes=${step.transfer.size}")
        try {
          createDocument.launch(step.transfer.name to step.transfer.mime)
        } catch (e: Exception) {
          Log.e(LOG_TAG, "SAVE no document UI", e)
          handle(session.locationChosen(false))
        }
      }
      is SaveStep.Write -> Unit // handled in onLocation, which owns the URI
      is SaveStep.Done -> finish(step)
    }
  }

  private fun onLocation(uri: Uri?) {
    val step = session.locationChosen(uri != null)
    if (step !is SaveStep.Write || uri == null) {
      handle(step)
      return
    }
    val bytes = step.bytes
    io.execute {
      val error: String? = try {
        val out = activity.contentResolver.openOutputStream(uri, "wt") ?: throw IOException("no output stream")
        out.use { it.write(bytes) }
        null
      } catch (e: Exception) {
        Log.e(LOG_TAG, "SAVE write failed", e)
        try {
          DocumentsContract.deleteDocument(activity.contentResolver, uri)
        } catch (_: Exception) {
        }
        e.message ?: e.javaClass.simpleName
      }
      main.post { handle(session.written(error == null, error)) }
    }
  }

  private fun finish(done: SaveStep.Done) {
    val t = done.transfer
    when (t.state) {
      SaveState.SAVED -> {
        Log.i(LOG_TAG, "SAVE saved id=${t.id} bytes=${t.size}")
        toast("Saved ${t.name}")
        post(t.id, "saved", null)
      }
      SaveState.CANCELLED -> {
        Log.i(LOG_TAG, "SAVE cancelled id=${t.id}")
        post(t.id, "cancelled", null)
      }
      else -> {
        Log.w(LOG_TAG, "SAVE failed id=${t.id} reason=${done.reason}")
        toast("Couldn't save ${t.name}: ${done.reason}")
        post(t.id, "failed", done.reason)
      }
    }
  }

  private fun post(id: Int?, status: String, reason: String?) {
    val msg = JSONObject().put("type", "save-result").put("status", status)
    if (id != null) msg.put("id", id)
    if (reason != null) msg.put("reason", reason)
    try {
      reply?.postMessage(msg.toString())
    } catch (e: Exception) {
      Log.w(LOG_TAG, "SAVE reply failed", e)
    }
  }

  private fun toast(text: String) = Toast.makeText(activity, text, Toast.LENGTH_LONG).show()
}
