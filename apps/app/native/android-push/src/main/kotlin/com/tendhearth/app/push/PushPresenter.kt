package com.tendhearth.app.push

data class PushDisplay(val title: String, val body: String, val channel: String, val deepLink: String?, val notificationId: Int)

object PushPresenter {
  /** 占位通知的固定 id:连着几条解不开的只留一条。 */
  const val PLACEHOLDER_ID = 0x7e4d

  /** 钥匙串记录里的语言优先;否则系统语言以 zh 开头 ⇒ zh-Hans,其余 en(同 src/i18n pickLang)。 */
  fun lang(record: String?, systemTag: String): String = when {
    record == "en" || record == "zh-Hans" -> record
    systemTag.lowercase().startsWith("zh") -> "zh-Hans"
    else -> "en"
  }

  private fun s(strings: Map<String, Map<String, String>>, lang: String, key: String): String =
    strings[lang]?.get(key) ?: strings["en"]?.get(key) ?: key

  fun placeholder(lang: String, strings: Map<String, Map<String, String>>) =
    PushDisplay(s(strings, lang, "placeholder.title"), s(strings, lang, "placeholder.body"), "updates", null, PLACEHOLDER_ID)

  /** 标题按 kind 本地化;正文是用户自己的数据原样显示;test 的正文也本地化。同一件事的通知用同一个 id(与 APNs collapse-id 一样只留最新一条)。 */
  fun display(m: PushMessage, lang: String, strings: Map<String, Map<String, String>>) = PushDisplay(
    title = s(strings, lang, "title.${m.kind}"),
    body = if (m.kind == "test") s(strings, lang, "body.test") else m.body,
    channel = m.channel,
    deepLink = m.deepLink(),
    notificationId = (m.taskId ?: m.kind).hashCode(),
  )
}
