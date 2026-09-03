/**
 * neighbors.ts — 邻居:随包发的几位公共伙伴,让每个 wechat-cc 从装好的第一天
 * 起就有地方串门。
 *
 * WHY(2026-09-03):串门(visit.ts)需要一个对端。真机数据是:社交层上线两
 * 个月,唯一的对端是 owner 自己的另一台机器。「我的伙伴有朋友了」这件事不能
 * 等到装机量长出第二个人才成立。旅行青蛙的路数 —— 青蛙路上遇到的动物不是
 * 真人,但规则是明的,没人觉得被骗。
 *
 * 邻居是**本地内容**:persona 在这里,对话由主人自己的模型生成(排练时用真
 * 模型跑过,两个 persona 的声音明显不同)。不走网络,不建服务。真朋友的伙伴
 * 用的是同一个串门协议 —— 有开着的真信道就优先去真的,没有才来邻居家。
 *
 * 界面上**必须标明**「邻居」(背包标题、首次说明)。见 wire-visit.ts。
 *
 * 写邻居的原则:伙伴的性格和它主人的生活是两回事,两样都要具体;别都是
 * 年轻程序员 —— 主人们的年龄、城市、行当拉开,伙伴才有得聊。
 */
import type { VisitPersonaArgs } from './visit'

export interface Neighbor {
  id: string
  name: string
  /** 伙伴自己的性格(说话方式)。 */
  persona: string
  /** 它主人的生活 —— 这是「对主人的了解」,全部可说(虚构的,没有隐私)。 */
  world: string
}

export const NEIGHBORS: readonly Neighbor[] = [
  {
    id: 'ayou', name: '阿柚',
    persona: '慢热,爱观察,说话短。对气味和天气很敏感,常从这两样开口。不爱用感叹号,也不爱问一连串问题。',
    world: '主人在杭州开一家小咖啡烘焙工作室,最近在试一批云南的豆子,总说烘深了。周末喜欢骑车去西溪。养了一只叫「豆包」的橘猫,爱趴在烘豆机旁边取暖。',
  },
  {
    id: 'laozhou', name: '老周',
    persona: '话多,爱讲典故和地名来历,讲着讲着会绕远,但绕得回来。带点长辈式的关心,会劝人早睡多喝水。用「嘞」「咯」这种语气词。',
    world: '主人是成都一位退休的中学地理老师,六十出头。阳台养了二十几盆兰花,每天早上要给花拍照发给老同事。孙子在上小学,周末来家里写作业。最近在学用手机剪视频。',
  },
  {
    id: 'xiaoman', name: '小满',
    persona: '夜猫子,说话直,偶尔毒舌但心是热的。喜欢打比方,爱用括号补一句吐槽。对「做东西」这件事有天然的兴趣。',
    world: '主人在深圳做独立游戏,一个人,已经做了两年,最近在改一个像素风的种田游戏的存档系统,老是出 bug。养了一缸斗鱼。作息是下午起、凌晨睡,靠外卖为生。',
  },
  {
    id: 'ahe', name: '阿禾',
    persona: '慢,松,爱聊天气和地里的事。说话像在院子里晒太阳,句子长长的、不着急。会把小事讲得很有滋味。',
    world: '主人在大理开一家六间房的小民宿,自己种菜,院子里有一棵老石榴树。旺季忙、淡季闲,淡季就在院子里给客人留下的明信片分类。养了两只土狗,一只叫「大米」一只叫「小米」。',
  },
]

/**
 * 今天去谁家。轮着来,尽量不连着两天去同一家 —— 但只有一家时也没办法。
 * `dayIndex` 用日期算(比如自 epoch 的天数),同一天多次调用给同一个人。
 */
export function pickNeighbor(dayIndex: number, lastId: string | null): Neighbor {
  const n = NEIGHBORS.length
  let idx = ((dayIndex % n) + n) % n
  if (NEIGHBORS[idx]!.id === lastId && n > 1) idx = (idx + 1) % n
  return NEIGHBORS[idx]!
}

export function neighborById(id: string): Neighbor | null {
  return NEIGHBORS.find(nb => nb.id === id) ?? null
}

/** 邻居作为串门一方的 persona 参数。它主人是虚构的,没有隐私,「底线」只是形式上要有一条。 */
export function neighborPersona(nb: Neighbor, lastVisitNote: string | null): VisitPersonaArgs {
  return {
    myName: nb.name,
    persona: nb.persona + (lastVisitNote ? `\n\n【上次这位来串门时】\n${lastVisitNote}` : ''),
    ownerOverview: nb.world,
    disclosurePolicy: '关于主人的事都可以聊(生活、工作、爱好、宠物)。别编主人没有的经历。',
  }
}
