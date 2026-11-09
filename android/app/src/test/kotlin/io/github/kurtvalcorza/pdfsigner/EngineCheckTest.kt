package io.github.kurtvalcorza.pdfsigner

import io.github.kurtvalcorza.pdfsigner.EngineCheck.Reason
import io.github.kurtvalcorza.pdfsigner.EngineCheck.State
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class EngineCheckTest {
  private fun eval(v: String?, enabled: Boolean = true) = EngineCheck.evaluate(v, enabled, 119, 133)

  @Test fun parsesMajor() {
    assertEquals(133, EngineCheck.majorOf("133.0.6943.137"))
    assertEquals(119, EngineCheck.majorOf(" 119 "))
    assertNull(EngineCheck.majorOf("beta"))
    assertNull(EngineCheck.majorOf(""))
    assertNull(EngineCheck.majorOf(null))
  }

  @Test fun atOrAboveFloorIsOk() {
    assertEquals(State.OK, eval("133.0.6943.137").state)
    assertEquals(State.OK, eval("140.0.1").state)
  }

  @Test fun betweenHardMinAndFloorIsUnvalidated() {
    assertEquals(State.UNVALIDATED, eval("119.0.0.0").state)
    assertEquals(State.UNVALIDATED, eval("132.9").state)
  }

  @Test fun belowHardMinIsRefused() {
    val r = eval("118.0.5993.0")
    assertEquals(State.REFUSED, r.state)
    assertEquals(Reason.TOO_OLD, r.reason)
    assertEquals(118, r.major)
  }

  @Test fun noProviderDisabledOrUnreadableIsRefused() {
    assertEquals(Reason.NO_PROVIDER, eval(null).reason)
    assertEquals(State.REFUSED, eval("133.0", enabled = false).state)
    assertEquals(Reason.DISABLED, eval("133.0", enabled = false).reason)
    assertEquals(Reason.UNREADABLE_VERSION, eval("dev").reason)
    assertEquals(State.REFUSED, eval("dev").state)
  }

  @Test fun floorEqualToHardMinHasNoUnvalidatedBand() {
    assertEquals(State.OK, EngineCheck.evaluate("119.0", true, 119, 119).state)
  }

  @Test(expected = IllegalArgumentException::class)
  fun floorBelowHardMinIsRejected() {
    EngineCheck.evaluate("130", true, 119, 100)
  }
}
