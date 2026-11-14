package io.github.kurtvalcorza.pdfsigner

import java.io.ByteArrayOutputStream
import java.util.Base64

/**
 * Pure rules for a save request (data-model "Save request", contract shell-bridge §3). No Android
 * imports, so the JVM unit tests run without a device.
 */
object SaveRules {
  /** "MUST be ≤ 100 MB + 1 MB headroom, or it is refused before the save dialog opens". */
  const val MAX_BYTES: Long = 101L * 1024 * 1024
  const val MAX_CHUNK_BYTES: Int = 1024 * 1024
  /**
   * A document picked for a save that no longer exists (process death with the dialog open) is
   * deleted only when its size is known to be exactly 0: it may be an existing file the user chose
   * to overwrite. Unknown size (null) keeps it.
   */
  fun shouldDeleteOrphan(sizeBytes: Long?): Boolean = sizeBytes == 0L

  /** Reason shown when the page could not read or send the bytes (`save-failed`). */
  const val UNREADABLE = "the file could not be read"
  private const val MAX_NAME_CHARS = 120

  val ALLOWED_MIME = setOf(
    "application/pdf",
    "application/x-pkcs12",
    "application/x-x509-ca-cert",
    "application/x-pem-file",
  )

  private val unsafe = Regex("[\\\\/:*?\"<>|\\p{Cntrl}]")

  /** Strips path separators and control characters, and keeps the extension. */
  fun sanitizeName(raw: String): String {
    var name = raw.replace(unsafe, "_").trim()
    if (name.isEmpty() || name.all { it == '.' || it == '_' }) name = "document"
    if (name.length > MAX_NAME_CHARS) {
      val ext = name.substringAfterLast('.', "").take(10)
      name = if (ext.isEmpty()) name.take(MAX_NAME_CHARS) else name.take(MAX_NAME_CHARS - ext.length - 1) + "." + ext
    }
    return name
  }

  /** One of the allowed types, else application/octet-stream. */
  fun normalizeMime(raw: String?): String {
    val m = raw?.substringBefore(';')?.trim()?.lowercase().orEmpty()
    return if (m in ALLOWED_MIME) m else "application/octet-stream"
  }
}

enum class SaveState {
  RECEIVING, AWAITING_LOCATION, WRITING, SAVED, CANCELLED, FAILED;

  val terminal: Boolean get() = this == SAVED || this == CANCELLED || this == FAILED
}

class Transfer(val id: Int, val name: String, val mime: String, val size: Long) {
  var state: SaveState = SaveState.RECEIVING
    internal set
  internal var bytes: ByteArray? = null
  internal var chunks: ByteArrayOutputStream? = null
  internal var nextSeq = 0
}

sealed interface SaveStep {
  /** Nothing to do yet (more chunks expected). */
  data class Receiving(val transfer: Transfer) : SaveStep
  /** All bytes arrived; open the save dialog. */
  data class AskLocation(val transfer: Transfer) : SaveStep
  /** The user picked a location; write these bytes. */
  class Write(val transfer: Transfer, val bytes: ByteArray) : SaveStep
  /** Terminal: SAVED, CANCELLED or FAILED. Bytes are already dropped. */
  data class Done(val transfer: Transfer, val reason: String? = null) : SaveStep
  /** The message was refused and no transfer changed state. */
  data class Refused(val reason: String) : SaveStep
}

/**
 * The single active transfer and its state machine:
 * RECEIVING → AWAITING_LOCATION → WRITING → SAVED, with CANCELLED and FAILED terminal.
 */
class SaveSession {
  var active: Transfer? = null
    private set

  fun begin(id: Int?, name: String?, mime: String?, size: Long?): SaveStep {
    if (active != null) return SaveStep.Refused("a save is already in progress")
    if (id == null || name == null || size == null) return SaveStep.Refused("malformed save-begin")
    if (size < 0) return SaveStep.Refused("malformed save-begin")
    if (size > SaveRules.MAX_BYTES) return SaveStep.Refused("the file is larger than the save limit")
    val t = Transfer(id, SaveRules.sanitizeName(name), SaveRules.normalizeMime(mime), size)
    active = t
    return SaveStep.Receiving(t)
  }

  /** The whole payload as one ArrayBuffer. */
  fun buffer(bytes: ByteArray): SaveStep {
    val t = receiving() ?: return SaveStep.Refused("no save in progress")
    if (t.chunks != null) return fail(t, "mixed payload")
    if (bytes.size.toLong() != t.size) return fail(t, "size mismatch")
    t.bytes = bytes
    t.state = SaveState.AWAITING_LOCATION
    return SaveStep.AskLocation(t)
  }

  fun chunk(id: Int?, seq: Int?, base64: String?): SaveStep {
    val t = receiving() ?: return SaveStep.Refused("no save in progress")
    if (id != t.id || seq == null || base64 == null) return fail(t, "malformed save-chunk")
    if (seq != t.nextSeq) return fail(t, "chunk out of order")
    val decoded = try {
      Base64.getMimeDecoder().decode(base64)
    } catch (_: IllegalArgumentException) {
      return fail(t, "malformed save-chunk")
    }
    if (decoded.size > SaveRules.MAX_CHUNK_BYTES) return fail(t, "chunk too large")
    val out = t.chunks ?: ByteArrayOutputStream().also { t.chunks = it }
    if (out.size().toLong() + decoded.size > t.size) return fail(t, "size mismatch")
    out.write(decoded)
    t.nextSeq++
    return SaveStep.Receiving(t)
  }

  fun end(id: Int?): SaveStep {
    val t = receiving() ?: return SaveStep.Refused("no save in progress")
    if (id != t.id) return fail(t, "malformed save-end")
    val bytes = t.chunks?.toByteArray() ?: ByteArray(0)
    t.chunks = null
    if (bytes.size.toLong() != t.size) return fail(t, "size mismatch")
    t.bytes = bytes
    t.state = SaveState.AWAITING_LOCATION
    return SaveStep.AskLocation(t)
  }

  /** Result of the save dialog: picked → WRITING, otherwise CANCELLED. */
  fun locationChosen(picked: Boolean): SaveStep {
    val t = active ?: return SaveStep.Refused("no save in progress")
    if (t.state != SaveState.AWAITING_LOCATION) return SaveStep.Refused("not awaiting a location")
    if (!picked) return finish(t, SaveState.CANCELLED, null)
    t.state = SaveState.WRITING
    return SaveStep.Write(t, t.bytes!!)
  }

  fun written(ok: Boolean, reason: String? = null): SaveStep {
    val t = active ?: return SaveStep.Refused("no save in progress")
    if (t.state != SaveState.WRITING) return SaveStep.Refused("not writing")
    return if (ok) finish(t, SaveState.SAVED, null) else finish(t, SaveState.FAILED, reason ?: "write failed")
  }

  /** The web side could not read or send the bytes (`save-failed`); fails a transfer still receiving. */
  fun aborted(id: Int?): SaveStep {
    val t = active ?: return SaveStep.Refused("no save in progress")
    if (t.id != id || t.state != SaveState.RECEIVING) return SaveStep.Refused("not receiving")
    return fail(t, SaveRules.UNREADABLE)
  }

  /** A transfer that stays in RECEIVING too long fails. */
  fun timeout(id: Int): SaveStep {
    val t = active ?: return SaveStep.Refused("no save in progress")
    if (t.id != id || t.state != SaveState.RECEIVING) return SaveStep.Refused("not receiving")
    return fail(t, "timed out")
  }

  private fun receiving(): Transfer? = active?.takeIf { it.state == SaveState.RECEIVING }

  private fun fail(t: Transfer, reason: String) = finish(t, SaveState.FAILED, reason)

  private fun finish(t: Transfer, state: SaveState, reason: String?): SaveStep {
    t.state = state
    t.bytes = null
    t.chunks = null
    active = null
    return SaveStep.Done(t, reason)
  }
}
