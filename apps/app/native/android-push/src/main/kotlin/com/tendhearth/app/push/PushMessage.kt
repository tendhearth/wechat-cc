package com.tendhearth.app.push

import org.json.JSONObject
import java.net.URLEncoder

/** 与 packages/protocol 的 PushPlaintext(zod)同一形状:多余字段忽略;可选字段出现就必须是字符串(JSON null 也拒)。 */
data class PushMessage(val ts: Double, val kind: String, val title: String, val body: String, val taskId: String?, val requestId: String?) {
  /** 安卓通知渠道:需要你决定(批准 / 问题)与 完成与失败(其余)。 */
  val channel: String get() = if (kind == "permission" || kind == "question") "decide" else "updates"

  /** 点通知的深链,交给 app 的 src/app/push-open.tsx(参数在那边校验)。 */
  fun deepLink(): String {
    val q = mutableListOf("kind" to kind)
    taskId?.let { q.add("taskId" to it) }
    requestId?.let { q.add("requestId" to it) }
    return "tendhearth://push-open?" + q.joinToString("&") { (k, v) -> "$k=${URLEncoder.encode(v, "UTF-8")}" }
  }

  companion object {
    val KINDS = setOf("permission", "question", "task_done", "task_failed", "test")

    fun parse(o: JSONObject): PushMessage? {
      val ts = o.opt("ts") as? Number ?: return null
      val kind = o.opt("kind") as? String ?: return null
      if (kind !in KINDS) return null
      val title = o.opt("title") as? String ?: return null
      val body = o.opt("body") as? String ?: return null
      val taskId = o.opt("taskId")
      if (taskId != null && taskId !is String) return null
      val requestId = o.opt("requestId")
      if (requestId != null && requestId !is String) return null
      return PushMessage(ts.toDouble(), kind, title, body, taskId as String?, requestId as String?)
    }
  }
}
