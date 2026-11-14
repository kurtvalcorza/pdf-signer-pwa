import org.gradle.api.artifacts.component.ModuleComponentIdentifier
import org.gradle.api.artifacts.result.ResolvedComponentResult
import org.gradle.api.artifacts.result.ResolvedDependencyResult

plugins {
  alias(libs.plugins.android.application)
}

// The version comes from the shared package.json so all three distributions match (FR-019).
val webVersion: String = run {
  val json = rootProject.file("../package.json").readText()
  Regex("\"version\"\\s*:\\s*\"([^\"]+)\"").find(json)?.groupValues?.get(1)
    ?: throw GradleException("package.json has no version")
}
// Strictly increasing across releases (data model): major*10000 + minor*100 + patch.
val webVersionCode: Int = run {
  val parts = webVersion.substringBefore('-').split('.').map { it.toInt() }
  require(parts.size == 3 && parts[1] < 100 && parts[2] < 100) { "unsupported version $webVersion" }
  parts[0] * 10000 + parts[1] * 100 + parts[2]
}
val validatedFloor: Int = rootProject.file("VALIDATED_WEBVIEW").readText().trim().toInt()
// ^{commit} peels an annotated tag object to the commit it points at, so the About panel always
// shows a commit hash (#27, F2). The raw GITHUB_SHA is the fallback only when git cannot answer.
val sourceRef: String? = providers.environmentVariable("GITHUB_SHA").orNull
val sourceCommit: String = providers.exec {
  commandLine("git", "rev-parse", "--verify", "--quiet", "${sourceRef ?: "HEAD"}^{commit}")
  isIgnoreExitValue = true
}.standardOutput.asText.get().trim().ifEmpty { sourceRef ?: "unknown" }

android {
  namespace = "io.github.kurtvalcorza.pdfsigner"
  compileSdk = 36
  defaultConfig {
    // Permanent: it can never change after the first release (R15).
    applicationId = "io.github.kurtvalcorza.pdfsigner"
    minSdk = 26
    targetSdk = 36
    versionCode = webVersionCode
    versionName = webVersion
    buildConfigField("int", "WEBVIEW_HARD_MIN", "119")
    buildConfigField("int", "WEBVIEW_VALIDATED_FLOOR", validatedFloor.toString())
    buildConfigField("String", "SOURCE_COMMIT", "\"$sourceCommit\"")
  }
  buildTypes {
    release {
      isMinifyEnabled = false
    }
  }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_21
    targetCompatibility = JavaVersion.VERSION_21
  }
  buildFeatures {
    aidl = false
    buildConfig = true
    shaders = false
  }
}

kotlin {
  jvmToolchain(21)
}

dependencies {
  implementation(libs.androidx.core)
  implementation(libs.androidx.activity)
  implementation(libs.androidx.webkit)
  testImplementation(libs.junit)
}

// T004: the shared web build is an input, copied into generated assets under www/.
// dist/ is never committed into android/ (FR-001, C7).
abstract class CopyWebDist : DefaultTask() {
  @get:InputFiles
  @get:PathSensitive(PathSensitivity.RELATIVE)
  abstract val distFiles: ConfigurableFileCollection

  @get:Internal
  abstract val distRoot: DirectoryProperty

  @get:OutputDirectory
  abstract val outputDir: DirectoryProperty

  @get:Inject
  abstract val fs: FileSystemOperations

  @TaskAction
  fun copy() {
    val root = distRoot.get().asFile
    if (!root.resolve("index.html").isFile) {
      throw GradleException("${root.resolve("index.html")} is missing. Run `npm run build` first.")
    }
    fs.sync {
      from(root)
      into(outputDir.dir("www"))
    }
  }
}

val webDistDir = rootProject.layout.projectDirectory.dir("../dist")
val copyWebDist = tasks.register<CopyWebDist>("copyWebDist") {
  distRoot.set(webDistDir)
  distFiles.from(webDistDir)
}

// T007: an allow-list, not a deny-list (R5, C2). Every resolved runtime coordinate must be listed.
abstract class VerifyDependencyAllowlist : DefaultTask() {
  @get:InputFile
  @get:PathSensitive(PathSensitivity.NONE)
  abstract val allowlist: RegularFileProperty

  @get:Input
  abstract val resolved: ListProperty<String>

  @TaskAction
  fun verify() {
    val allowed = allowlist.get().asFile.readLines().map { it.trim() }
      .filter { it.isNotEmpty() && !it.startsWith("#") }.toSet()
    val actual = resolved.get().toSortedSet()
    println("verifyDependencyAllowlist: ${actual.size} resolved coordinates")
    actual.forEach { println("  $it") }
    val extra = actual - allowed
    if (extra.isNotEmpty()) {
      throw GradleException("Dependencies not in android/dependency-allowlist.txt:\n  " + extra.joinToString("\n  "))
    }
  }
}

fun collectCoordinates(root: ResolvedComponentResult): List<String> {
  val seen = mutableSetOf<ResolvedComponentResult>()
  val out = sortedSetOf<String>()
  val queue = ArrayDeque(listOf(root))
  while (queue.isNotEmpty()) {
    val c = queue.removeFirst()
    if (!seen.add(c)) continue
    (c.id as? ModuleComponentIdentifier)?.let { out += "${it.group}:${it.module}:${it.version}" }
    c.dependencies.filterIsInstance<ResolvedDependencyResult>().forEach { queue += it.selected }
  }
  return out.toList()
}

androidComponents {
  onVariants { variant ->
    variant.sources.assets?.addGeneratedSourceDirectory(copyWebDist, CopyWebDist::outputDir)
  }
  onVariants(selector().withBuildType("release")) { variant ->
    val verify = tasks.register<VerifyDependencyAllowlist>("verifyDependencyAllowlist") {
      allowlist.set(rootProject.layout.projectDirectory.file("dependency-allowlist.txt"))
      resolved.set(variant.runtimeConfiguration.incoming.resolutionResult.rootComponent.map(::collectCoordinates))
    }
    tasks.matching { it.name == "preReleaseBuild" }.configureEach { dependsOn(verify) }
  }
}
