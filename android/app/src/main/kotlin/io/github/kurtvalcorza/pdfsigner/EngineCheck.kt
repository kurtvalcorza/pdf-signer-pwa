package io.github.kurtvalcorza.pdfsigner

/**
 * The system WebView engine check (data-model "Engine check", R11). Pure Kotlin, no Android
 * imports, so the JVM unit tests run without a device.
 *
 * ```
 * major < hardMin                       → REFUSED     (native screen; web app never loaded)
 * hardMin ≤ major < validatedFloor      → UNVALIDATED (web app loads; native notice shown)
 * major ≥ validatedFloor                → OK          (no notice)
 * no WebView provider / disabled        → REFUSED     (same screen, different reason)
 * ```
 */
object EngineCheck {
  enum class State { OK, UNVALIDATED, REFUSED }

  enum class Reason { NO_PROVIDER, DISABLED, UNREADABLE_VERSION, TOO_OLD }

  data class Result(val state: State, val major: Int?, val reason: Reason? = null)

  /** `133.0.6943.137` → 133. Null when the version has no leading integer. */
  fun majorOf(versionName: String?): Int? =
    versionName?.trim()?.let { Regex("^(\\d+)").find(it)?.groupValues?.get(1)?.toIntOrNull() }

  /**
   * @param versionName the provider's versionName, or null when there is no provider.
   * @param enabled whether the provider package is enabled.
   */
  fun evaluate(versionName: String?, enabled: Boolean, hardMin: Int, validatedFloor: Int): Result {
    require(hardMin <= validatedFloor) { "hardMin $hardMin above validatedFloor $validatedFloor" }
    if (versionName == null) return Result(State.REFUSED, null, Reason.NO_PROVIDER)
    if (!enabled) return Result(State.REFUSED, majorOf(versionName), Reason.DISABLED)
    // Fail closed: a version we can't read is not one we validated.
    val major = majorOf(versionName) ?: return Result(State.REFUSED, null, Reason.UNREADABLE_VERSION)
    return when {
      major < hardMin -> Result(State.REFUSED, major, Reason.TOO_OLD)
      major < validatedFloor -> Result(State.UNVALIDATED, major)
      else -> Result(State.OK, major)
    }
  }
}
