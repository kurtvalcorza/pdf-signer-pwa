package io.github.kurtvalcorza.pdfsigner

import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AboutInfoTest {
  private fun inputs(engine: EngineCheck.State = EngineCheck.State.OK) =
    AboutInfo.Inputs("0.1.1", "0123456789abcdef0123", "133.0.6943.137", 133, engine)

  private val text = AboutInfo.lines(inputs()).joinToString("\n")

  private fun assertMentions(vararg needles: String) {
    for (n in needles) assertTrue("missing \"$n\" in:\n$text", text.contains(n, ignoreCase = true))
  }

  @Test fun versionCommitStoreAndUpdates() {
    assertMentions("0.1.1", "0123456789ab", "outside the Play Store", "never updates itself")
  }

  @Test fun engineVersionFloorAndDeviceDependence() {
    assertMentions("133.0.6943.137", "WebView 133", "depends on this device")
  }

  @Test fun networkClaimHowToConfirmAndCaveat() {
    assertMentions("No network permission", "Settings → Apps → PDF Signer", "No permissions requested", "crash reports")
  }

  @Test fun rememberedItemsBackupTransferUninstall() {
    assertMentions("this app's storage only", "backups", "new phone", "uninstall")
  }

  @Test fun screenshotsAndRecentsBlocked() {
    assertMentions("Screenshots", "recent-apps preview", "open the saved file in another app")
  }

  @Test fun largeFileCeilingDisclosed() {
    assertMentions("${AboutInfo.TESTED_LARGE_PDF_MB} MB", "nothing is saved")
  }

  @Test fun commitIsShortenedNotDropped() {
    assertTrue(!text.contains("0123456789abcdef0123"))
  }

  @Test fun bannerOnlyWhenUnvalidated() {
    assertNull(AboutInfo.banner(inputs(EngineCheck.State.OK)))
    assertNull(AboutInfo.banner(inputs(EngineCheck.State.REFUSED)))
    val b = AboutInfo.banner(inputs(EngineCheck.State.UNVALIDATED))
    assertNotNull(b)
    assertTrue(b!!.contains("133"))
    assertTrue(!b.contains("don't show", ignoreCase = true))
  }
}
