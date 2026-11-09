package io.github.kurtvalcorza.pdfsigner

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class SaveRulesTest {
  private fun b64(b: ByteArray) = Base64.getEncoder().encodeToString(b)

  @Test fun sanitizeStripsSeparatorsAndControlsAndKeepsExtension() {
    assertEquals(".._x.pdf", SaveRules.sanitizeName("../x.pdf"))
    assertEquals("a_b_c.pdf", SaveRules.sanitizeName("a/b\\c.pdf"))
    assertEquals("evil_name.pdf", SaveRules.sanitizeName("evil\u0000name.pdf"))
    assertEquals("doc-signed.pdf", SaveRules.sanitizeName("doc-signed.pdf"))
    assertFalse(SaveRules.sanitizeName("..\\..\\x.p12").contains('/'))
    assertFalse(SaveRules.sanitizeName("..\\..\\x.p12").contains('\\'))
  }

  @Test fun sanitizeBlankBecomesDocument() {
    assertEquals("document", SaveRules.sanitizeName(""))
    assertEquals("document", SaveRules.sanitizeName("/"))
    assertEquals("document", SaveRules.sanitizeName(".."))
  }

  @Test fun sanitizeLongNameKeepsExtension() {
    val n = SaveRules.sanitizeName("a".repeat(500) + ".pdf")
    assertTrue(n.length <= 120)
    assertTrue(n.endsWith(".pdf"))
  }

  @Test fun mimeAllowListElseOctetStream() {
    assertEquals("application/pdf", SaveRules.normalizeMime("application/pdf"))
    assertEquals("application/x-pkcs12", SaveRules.normalizeMime("application/x-pkcs12"))
    assertEquals("application/x-x509-ca-cert", SaveRules.normalizeMime("application/x-x509-ca-cert"))
    assertEquals("application/x-pem-file", SaveRules.normalizeMime("application/x-pem-file"))
    assertEquals("application/octet-stream", SaveRules.normalizeMime("text/html"))
    assertEquals("application/octet-stream", SaveRules.normalizeMime(null))
    assertEquals("application/octet-stream", SaveRules.normalizeMime(""))
  }

  @Test fun sizeLimitIs101MiB() {
    val s = SaveSession()
    assertTrue(s.begin(1, "x.pdf", "application/pdf", SaveRules.MAX_BYTES) is SaveStep.Receiving)
    val s2 = SaveSession()
    val r = s2.begin(1, "x.pdf", "application/pdf", 101L * 1024 * 1024 + 1)
    assertTrue(r is SaveStep.Refused)
    assertNull(s2.active)
  }

  @Test fun malformedBeginRefused() {
    val s = SaveSession()
    assertTrue(s.begin(null, "x", "application/pdf", 1) is SaveStep.Refused)
    assertTrue(s.begin(1, null, "application/pdf", 1) is SaveStep.Refused)
    assertTrue(s.begin(1, "x", "application/pdf", null) is SaveStep.Refused)
    assertTrue(s.begin(1, "x", "application/pdf", -1) is SaveStep.Refused)
    assertNull(s.active)
  }

  @Test fun secondBeginRefusedWhileActive() {
    val s = SaveSession()
    s.begin(1, "a.pdf", "application/pdf", 3)
    val r = s.begin(2, "b.pdf", "application/pdf", 3)
    assertTrue(r is SaveStep.Refused)
    assertEquals(1, s.active!!.id)
  }

  @Test fun arrayBufferHappyPathToSaved() {
    val s = SaveSession()
    s.begin(7, "a.pdf", "application/pdf", 3)
    val ask = s.buffer(byteArrayOf(1, 2, 3)) as SaveStep.AskLocation
    assertEquals(SaveState.AWAITING_LOCATION, ask.transfer.state)
    val write = s.locationChosen(true) as SaveStep.Write
    assertEquals(SaveState.WRITING, write.transfer.state)
    assertArrayEquals(byteArrayOf(1, 2, 3), write.bytes)
    val done = s.written(true) as SaveStep.Done
    assertEquals(SaveState.SAVED, done.transfer.state)
    assertNull(done.transfer.bytes)
    assertNull(s.active)
  }

  @Test fun bufferSizeMismatchFails() {
    val s = SaveSession()
    s.begin(1, "a.pdf", "application/pdf", 4)
    val done = s.buffer(byteArrayOf(1, 2, 3)) as SaveStep.Done
    assertEquals(SaveState.FAILED, done.transfer.state)
    assertEquals("size mismatch", done.reason)
    assertNull(s.active)
  }

  @Test fun chunkedHappyPath() {
    val s = SaveSession()
    s.begin(2, "a.pdf", "application/pdf", 5)
    assertTrue(s.chunk(2, 0, b64(byteArrayOf(1, 2))) is SaveStep.Receiving)
    assertTrue(s.chunk(2, 1, b64(byteArrayOf(3, 4, 5))) is SaveStep.Receiving)
    assertTrue(s.end(2) is SaveStep.AskLocation)
    val w = s.locationChosen(true) as SaveStep.Write
    assertArrayEquals(byteArrayOf(1, 2, 3, 4, 5), w.bytes)
  }

  @Test fun chunkOverflowAndShortEndFail() {
    val s = SaveSession()
    s.begin(1, "a.pdf", "application/pdf", 2)
    assertEquals(SaveState.FAILED, (s.chunk(1, 0, b64(byteArrayOf(1, 2, 3))) as SaveStep.Done).transfer.state)
    val s2 = SaveSession()
    s2.begin(1, "a.pdf", "application/pdf", 3)
    s2.chunk(1, 0, b64(byteArrayOf(1)))
    assertEquals("size mismatch", (s2.end(1) as SaveStep.Done).reason)
  }

  @Test fun chunkOutOfOrderWrongIdAndBadBase64Fail() {
    val a = SaveSession(); a.begin(1, "a", null, 4)
    assertEquals("chunk out of order", (a.chunk(1, 1, b64(byteArrayOf(1))) as SaveStep.Done).reason)
    val b = SaveSession(); b.begin(1, "a", null, 4)
    assertEquals(SaveState.FAILED, (b.chunk(9, 0, b64(byteArrayOf(1))) as SaveStep.Done).transfer.state)
    val c = SaveSession(); c.begin(1, "a", null, 4)
    assertEquals(SaveState.FAILED, (c.chunk(1, 0, "!!not base64!!") as SaveStep.Done).transfer.state)
  }

  @Test fun chunkLargerThanOneMiBFails() {
    val s = SaveSession()
    s.begin(1, "a.pdf", "application/pdf", SaveRules.MAX_BYTES)
    val r = s.chunk(1, 0, b64(ByteArray(SaveRules.MAX_CHUNK_BYTES + 1))) as SaveStep.Done
    assertEquals("chunk too large", r.reason)
  }

  @Test fun cancelIsTerminalAndDropsBytes() {
    val s = SaveSession()
    s.begin(1, "a.pdf", "application/pdf", 1)
    s.buffer(byteArrayOf(9))
    val d = s.locationChosen(false) as SaveStep.Done
    assertEquals(SaveState.CANCELLED, d.transfer.state)
    assertNull(d.transfer.bytes)
    assertNull(s.active)
  }

  @Test fun writeFailureIsFailed() {
    val s = SaveSession()
    s.begin(1, "a.pdf", "application/pdf", 1)
    s.buffer(byteArrayOf(9))
    s.locationChosen(true)
    val d = s.written(false, "disk full") as SaveStep.Done
    assertEquals(SaveState.FAILED, d.transfer.state)
    assertEquals("disk full", d.reason)
  }

  @Test fun timeoutFailsOnlyWhileReceiving() {
    val s = SaveSession()
    s.begin(3, "a.pdf", "application/pdf", 2)
    assertEquals("timed out", (s.timeout(3) as SaveStep.Done).reason)
    val s2 = SaveSession()
    s2.begin(3, "a.pdf", "application/pdf", 1)
    s2.buffer(byteArrayOf(1))
    assertTrue(s2.timeout(3) is SaveStep.Refused)
  }

  @Test fun outOfStateMessagesRefused() {
    val s = SaveSession()
    assertTrue(s.buffer(byteArrayOf(1)) is SaveStep.Refused)
    assertTrue(s.end(1) is SaveStep.Refused)
    assertTrue(s.locationChosen(true) is SaveStep.Refused)
    assertTrue(s.written(true) is SaveStep.Refused)
    s.begin(1, "a", null, 1)
    assertTrue(s.locationChosen(true) is SaveStep.Refused)
    assertTrue(s.written(true) is SaveStep.Refused)
  }

  @Test fun newSaveAllowedAfterTerminal() {
    val s = SaveSession()
    s.begin(1, "a", null, 1)
    s.buffer(byteArrayOf(1))
    s.locationChosen(false)
    assertTrue(s.begin(2, "b", null, 1) is SaveStep.Receiving)
  }
}
