// 只为在 JVM 上跑推送核心的单测。安卓构建不用这个文件:plugins/with-android-push.js 把 src/main/kotlin 下的源码拷进 android/app。
// org.json 的 JVM 版与安卓系统自带的是同一套 API(JSONObject / opt / getString)。
buildscript {
  repositories { mavenCentral() }
  dependencies { classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.3.20") }
}
apply(plugin = "org.jetbrains.kotlin.jvm")
repositories { mavenCentral() }
dependencies {
  "implementation"("org.json:json:20240303")
  "testImplementation"("junit:junit:4.12")
}
tasks.withType<Test> {
  testLogging {
    events("passed", "failed")
    exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
  }
}
