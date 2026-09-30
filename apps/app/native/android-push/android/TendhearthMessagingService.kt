package com.tendhearth.app.push

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.tendhearth.app.R
import java.util.Locale

/**
 * 安卓消息服务(spec §7):中继发 FCM data message(HIGH),密文在 data.wcc(JSON 字符串)。决定全在 PushResolver(JVM 单测):
 * 解不开 / 没密钥 / 明文不合形状 ⇒ 中性占位「CC 有新动态」;重复 ⇒ 直接丢掉(安卓能丢,不像 iOS 扩展)。
 * 点通知 ⇒ tendhearth://push-open 深链(app 端校验参数、先拉详情);占位 ⇒ 打开 app。
 * 从不记录明文、密钥、密文或 token(没有任何 Log 调用;plugins/android-push.test.ts 钉住)。
 * 取代 expo-notifications 自带的消息服务(manifest 里移除了它,见 plugins/with-android-push.js):
 * token 刷新不在这里接,app 每次启动 / 回前台 / 重新联网时 syncPush 重查补上。app 在前台也照样发系统通知,不另弹 app 内横幅。
 */
class TendhearthMessagingService : FirebaseMessagingService() {
  override fun onMessageReceived(message: RemoteMessage) {
    val now = System.currentTimeMillis()
    val record = SecureStoreReader.readPushKeyRecord(applicationContext)?.let { PushKeyRecord.parse(it) }
    val system = Locale.getDefault().toLanguageTag()
    val r = try {
      PushResolver.resolve(record, message.data["wcc"], system, now, PushStrings.table) { seen(it, now) }
    } catch (e: Exception) {
      PushResolver.placeholder(record, system, PushStrings.table)
    }
    if (r.duplicate) return
    post(r.display, PushPresenter.lang(record?.lang, system))
  }

  override fun onNewToken(token: String) {
    // 不存、不记:app 下次启动 / 回前台 / 重新联网时 syncPush 会拿到新 token 并重新登记(src/push/register.ts)。
  }

  /** 读-改-写 SharedPreferences;FCM 按序投递,锁只防万一。坏数据 ⇒ 空表(最多多响一次)。 */
  private fun seen(key: String, now: Long): Boolean = synchronized(LOCK) {
    val prefs = getSharedPreferences(DEDUPE_PREFS, Context.MODE_PRIVATE)
    val store = PushDedupe.fromJson(prefs.getString(DEDUPE_ENTRIES, null))
    val dup = store.seen(key, now)
    prefs.edit().putString(DEDUPE_ENTRIES, store.toJson()).commit()
    dup
  }

  /** 渠道名跟着当前语言走(createNotificationChannel 对已有渠道只改名字与描述,不动用户改过的重要性)。 */
  private fun ensureChannels(nm: NotificationManager, lang: String) {
    if (Build.VERSION.SDK_INT < 26) return
    val s = PushStrings.table[lang] ?: PushStrings.table.getValue("en")
    nm.createNotificationChannel(NotificationChannel("decide", s.getValue("channel.decide"), NotificationManager.IMPORTANCE_HIGH))
    nm.createNotificationChannel(NotificationChannel("updates", s.getValue("channel.updates"), NotificationManager.IMPORTANCE_DEFAULT))
  }

  private fun post(d: PushDisplay, lang: String) {
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    ensureChannels(nm, lang)
    val intent = if (d.deepLink != null) Intent(Intent.ACTION_VIEW, Uri.parse(d.deepLink)).setPackage(packageName)
      else packageManager.getLaunchIntentForPackage(packageName) ?: Intent().setPackage(packageName)
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    val pi = PendingIntent.getActivity(this, d.notificationId, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    @Suppress("DEPRECATION")
    val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, d.channel) else Notification.Builder(this)
    val n = b.setSmallIcon(R.drawable.notification_icon)
      .setColor(resources.getColor(R.color.notification_icon_color, theme))
      .setContentTitle(d.title)
      .setContentText(d.body)
      .setStyle(Notification.BigTextStyle().bigText(d.body))
      .setAutoCancel(true)
      .setContentIntent(pi)
      .build()
    try { nm.notify(d.notificationId, n) } catch (e: SecurityException) { /* 安卓 13+ 没给通知权限:系统不显示,app 设置页会提示 */ }
  }

  private companion object {
    val LOCK = Any()
    const val DEDUPE_PREFS = "tendhearth.push.dedupe"
    const val DEDUPE_ENTRIES = "entries"
  }
}
