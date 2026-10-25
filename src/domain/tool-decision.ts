/**
 * 一次工具调用:放、问主人、还是拒 —— 档位 × 工具类别的那一条判定,只有这一处(架构终态 C1)。
 *
 * 以前同一条规矩抄了三份:`permission-relay.ts` 的 effectivePolicy(Claude)、Gemini 里为了躲 import 环逐字抄的
 * gateEffectivePolicy、openai-gate 里的一个变体。现在三家都调这里;各家只管「问」能不能真问(问不了 ⇒ 按各自
 * 编译好的策略落成拒或放,见 policy.ts 的 relayAs)和怎么问(微信 y/n 卡 / 工作台卡片)。
 *
 * 顺序:
 *   1. 档位拒(tier.deny)⇒ 拒 —— 这一档根本不许这一类;
 *   2. 档位要问(tier.relay)⇒ 问;
 *   3. 档位放(tier.allow)⇒ 放 —— 明说了放就不再看能力表(否则 strict 下 admin 读个文件都要弹卡);
 *   4. 都没说 ⇒ 看能力表的 askUser:'per-tool' ⇒ 问,'never' ⇒ 放。
 * 纯函数:只吃类型,不 import 能力表(Gemini → 能力表 → Gemini 那个环就是这么来的)。
 *
 * C2 以后各家不再直接调它:逐次调用的判定只走 ./authorize.ts,这一条是 authorize 里「档位 × 类别」那一层。
 */
import type { TierProfile, ToolKind } from './user-tier'

export type ToolVerdict = 'allow' | 'relay' | 'deny'

export function decideTool(tp: TierProfile, kind: ToolKind, matrixAskUser: 'per-tool' | 'never' = 'never'): ToolVerdict {
  if (tp.deny.has(kind)) return 'deny'
  if (tp.relay.has(kind)) return 'relay'
  if (tp.allow.has(kind)) return 'allow'
  return matrixAskUser === 'per-tool' ? 'relay' : 'allow'
}
