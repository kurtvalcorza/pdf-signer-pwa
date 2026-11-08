package io.github.kurtvalcorza.pdfsigner

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AcceptRulesTest {
  @Test fun pdf() {
    assertArrayEquals(arrayOf("application/pdf"), AcceptRules.mimeTypes(arrayOf(".pdf")))
    assertArrayEquals(arrayOf("application/pdf"), AcceptRules.mimeTypes(arrayOf(".pdf,application/pdf")))
  }

  @Test fun imagesSeparateOrJoined() {
    val both = arrayOf("image/png", "image/jpeg")
    assertArrayEquals(both, AcceptRules.mimeTypes(arrayOf("image/png", "image/jpeg")))
    assertArrayEquals(both, AcceptRules.mimeTypes(arrayOf("image/png,image/jpeg")))
    assertArrayEquals(arrayOf("image/png"), AcceptRules.mimeTypes(arrayOf(" IMAGE/PNG ")))
  }

  @Test fun pkcs12() {
    val p12 = arrayOf("application/x-pkcs12", "application/octet-stream")
    assertArrayEquals(p12, AcceptRules.mimeTypes(arrayOf(".p12,.pfx")))
    assertArrayEquals(p12, AcceptRules.mimeTypes(arrayOf(".p12", ".pfx")))
    assertArrayEquals(p12, AcceptRules.mimeTypes(arrayOf(".p12,.pfx,application/x-pkcs12")))
  }

  @Test fun captureOnlyForImageInputs() {
    assertTrue(AcceptRules.captureAllowed(arrayOf("image/*")))
    assertTrue(AcceptRules.captureAllowed(arrayOf("image/png,image/jpeg")))
    assertFalse(AcceptRules.captureAllowed(null))
    assertFalse(AcceptRules.captureAllowed(arrayOf("")))
    assertFalse(AcceptRules.captureAllowed(arrayOf(".pdf")))
    assertFalse(AcceptRules.captureAllowed(arrayOf("image/*,.p12")))
    assertFalse(AcceptRules.captureAllowed(arrayOf("*/*")))
  }

  @Test fun anythingElseRefused() {
    assertNull(AcceptRules.mimeTypes(null))
    assertNull(AcceptRules.mimeTypes(arrayOf()))
    assertNull(AcceptRules.mimeTypes(arrayOf("")))
    assertNull(AcceptRules.mimeTypes(arrayOf("*/*")))
    assertNull(AcceptRules.mimeTypes(arrayOf("image/*")))
    assertNull(AcceptRules.mimeTypes(arrayOf(".pdf,image/png")))
    assertNull(AcceptRules.mimeTypes(arrayOf("text/html")))
  }
}
