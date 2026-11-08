package io.github.kurtvalcorza.pdfsigner

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PathRulesTest {
  private fun asset(path: String) = PathRules.resolve(path) as PathRules.Asset

  @Test fun rootMapsToIndexHtml() {
    val a = asset("")
    assertEquals("www/index.html", a.assetPath)
    assertEquals("text/html", a.mime)
    assertEquals("utf-8", a.encoding)
  }

  @Test fun nestedAssetResolves() {
    assertEquals("www/assets/index-abc.js", asset("assets/index-abc.js").assetPath)
  }

  @Test fun traversalIsNotFound() {
    for (p in listOf("../secret", "assets/../../x", "a/./b", "..", "a//b", "a/")) {
      assertEquals(p, PathRules.NotFound, PathRules.resolve(p))
    }
  }

  @Test fun encodedBackslashAndAbsoluteAreNotFound() {
    for (p in listOf("%2e%2e/x", "a%2Fb", "a\\b", "/etc/passwd", "/index.html")) {
      assertEquals(p, PathRules.NotFound, PathRules.resolve(p))
    }
  }

  @Test fun moduleScriptsAreJavascript() {
    assertEquals("text/javascript", asset("assets/pdf.worker.min.mjs").mime)
    assertEquals("text/javascript", asset("sw.js").mime)
  }

  @Test fun wasmAndManifest() {
    assertEquals("application/wasm", asset("x.wasm").mime)
    assertEquals("application/manifest+json", asset("manifest.webmanifest").mime)
  }

  @Test fun unknownIsOctetStream() {
    val a = asset("file.bin")
    assertEquals("application/octet-stream", a.mime)
    assertNull(a.encoding)
    assertEquals("application/octet-stream", asset("noextension").mime)
  }

  @Test fun headersAreEmptyAndCarryNoCsp() {
    val h = PathRules.headers()
    assertTrue(h.isEmpty())
    assertFalse(h.keys.any { it.equals("Content-Security-Policy", ignoreCase = true) })
  }
}
