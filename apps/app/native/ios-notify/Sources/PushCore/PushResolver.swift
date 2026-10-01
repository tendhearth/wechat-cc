import Foundation

public struct PushResolution: Equatable {
  public let display: PushDisplay
  /// 同一条推送第二次到达(iOS 不能丢弃:扩展把它改成不响不亮,计划裁决 3)。
  public let duplicate: Bool
}

/// 通知服务扩展的整条决定(spec §7),纯逻辑,`swift test` 覆盖:
/// 没有 / 不合法的密钥记录、解不开(形状、认证、时间窗)、明文不合 PushPlaintext ⇒ 一律中性占位,
/// 从不回退到载荷里的原始标题 / 正文。去重只在解开且合形状之后才问(`seen` 记下并回答是否见过)。
public enum PushResolver {
  public static func placeholder(record: PushKeyRecord?, preferred: [String], strings: PushPresenter.Strings) -> PushResolution {
    let lang = PushPresenter.lang(record: record?.lang, preferred: preferred)
    return PushResolution(display: PushPresenter.placeholder(lang: lang, strings: strings), duplicate: false)
  }

  public static func resolve(record: PushKeyRecord?, sealed: Any?, preferred: [String], nowMs: Int64,
                             strings: PushPresenter.Strings, seen: (String) -> Bool) -> PushResolution {
    guard let rec = record,
          case .success(let opened) = PushCrypto.open(key: rec.key, sealed: sealed, nowMs: nowMs),
          let msg = PushMessage.parse(opened.payload) else {
      return placeholder(record: record, preferred: preferred, strings: strings)
    }
    let lang = PushPresenter.lang(record: rec.lang, preferred: preferred)
    let dup = seen(PushDedupe.key(ts: msg.ts, ct: opened.ct))
    return PushResolution(display: PushPresenter.display(msg, lang: lang, strings: strings), duplicate: dup)
  }
}
