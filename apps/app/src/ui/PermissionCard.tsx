import { useRef, useState } from 'react'
import { ScrollView, View } from 'react-native'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { useBackendCtx } from '../state/BackendProvider'
import { useConnection } from '../state/hooks'
import { approvalHeading, type ApprovalView } from '../view/approval'
import { ccPresence } from '../view/presence'
import { AgentAvatar } from './AgentAvatars'
import { Button } from './Button'
import { Card } from './Card'
import { CCFigure } from './CCFigure'
import { Markdown } from './Markdown'
import { PermissionOperation } from './PermissionOperation'
import { Sheet } from './Sheet'
import { space } from './tokens'
import { Txt } from './Txt'

type CardView = Extract<ApprovalView, { kind: 'card' }>

export function MatterContext({ title, eventKey }: { title: string; eventKey?: string }) {
  const conn = useConnection()
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.m, paddingTop: space.m }}>
    <CCFigure size={36} presence={ccPresence(conn)} behavior={eventKey ? 'wait' : 'idle'} eventKey={eventKey} />
    <Txt role="meta" tone="inkSoft" content="user" style={{ flex: 1 }}>{title}</Txt>
  </View>
}

function PermissionScriptPreview({script,taskId,requestId}:{script:NonNullable<CardView['scripts']>[number];taskId:string;requestId:string}) {
  const lang=useLang(),{backend}=useBackendCtx()
  const [expanded,setExpanded]=useState(false),[full,setFull]=useState<string|null>(null),[busy,setBusy]=useState(false),[failed,setFailed]=useState(false)
  async function toggle(){
    if(busy)return
    if(expanded){setExpanded(false);return}
    if(!script.truncated||full!==null){setExpanded(true);return}
    setBusy(true);setFailed(false)
    try{
      let text='',offset:number|null=0
      for(let i=0;offset!==null&&i<32;i++){
        const part=await backend.permissionScript({id:taskId,requestId,path:script.path,sha256:script.sha256!,offset})
        text+=part.content;offset=part.nextOffset
      }
      if(offset!==null)throw Error('too_large')
      setFull(text);setExpanded(true)
    }catch{setFailed(true)}finally{setBusy(false)}
  }
  return <Card style={{gap:space.s}}>
    <Txt role="caption">{t(lang,'approval.script')} · {script.path}</Txt>
    <Txt selectable role="code">{script.error??(expanded?(full??script.content):script.content.slice(0,2000))}</Txt>
    {!script.error&&(script.truncated||script.content.length>2000)?<Button kind="secondary" testID={`approval-script-expand-${script.path}`} label={t(lang,expanded?'approval.collapseScript':'approval.expandScript')} onPress={()=>void toggle()} busy={busy} disabled={busy}/>:null}
    {failed?<Txt role="small">{t(lang,'approval.refreshFailed')}</Txt>:null}
  </Card>
}

export function ApprovalNote({ kind, text }: { kind: 'opinion' | 'reason'; text?: string }) {
  const lang = useLang()
  if (!text) return null
  // CC 的意见:标签一行(界面的字),意见一行(CC 自己的字)。读屏读成原来那一整句。
  if (kind === 'opinion') return (
    <View testID="approval-cc-opinion" accessible accessibilityLabel={t(lang, 'approval.ccOpinion', { text })} style={{ gap: space.xs }}>
      <Txt testID="approval-cc-opinion-label" role="caption" tone="inkSoft">{t(lang, 'approval.ccOpinionLabel')}</Txt>
      <Txt testID="approval-cc-opinion-text" role="small" voice="cc" content="user">{text}</Txt>
    </View>
  )
  return <Txt testID="approval-question-reason" role="small" tone="inkSoft" content="user">{t(lang, 'approval.questionReason', { text })}</Txt>
}

export function PermissionCard({ v, taskId, matterTitle, ccOpinion, questionReason, onShowExact }: {
  v: CardView; taskId: string; matterTitle: string; ccOpinion?: string; questionReason?: string; onShowExact?: (y: number) => void
}) {
  const lang = useLang()
  const { action, title } = approvalHeading(v, lang)
  const [exactOpen, setExactOpen] = useState(false)
  const exactY = useRef(0)
  const jumpOnLayout = useRef(false)
  const openExact = () => {
    jumpOnLayout.current = !exactOpen
    setExactOpen(true)
    onShowExact?.(exactY.current)
  }
  const details = [
    { key: 'what', label: t(lang, 'approval.what'), value: v.what.trim() === title.trim() ? '' : v.what },
    { key: 'scope', label: t(lang, 'approval.scope'), value: v.scope },
    { key: 'reason', label: t(lang, 'approval.reasonLabel'), value: questionReason },
  ].filter(row => row.value?.trim())

  return (
    <View style={{ gap: space.xl }}>
      <MatterContext title={matterTitle} eventKey={v.requestId} />
      <View style={{ gap: space.s }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s }}>
          {v.executor ? <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <AgentAvatar id={v.executor} size={20} names={{ [v.executor]: v.executorName }} />
          </View> : null}
          <Txt testID="approval-actor" role="small" tone="inkSoft" style={{ flex: 1 }}>{action}</Txt>
        </View>
        <Txt testID="approval-title" role="title" content="user" accessibilityRole="header">{title}</Txt>
        {v.display.note ? <Txt selectable role="body" tone="inkSoft" content="user">{v.display.note}</Txt> : null}
      </View>
      <PermissionOperation display={v.display} cwd={v.workingDir} lang={lang} open={openExact} />
      {v.scripts?.map(script => <PermissionScriptPreview key={script.path} script={script} taskId={taskId} requestId={v.requestId} />)}
      {v.effect.trim() ? <View testID="approval-effect" style={{ gap: space.xs }}>
        <Markdown text={v.effect} />
        <Txt testID="approval-model-note" role="small" tone="inkSoft">{t(lang, 'approval.aiSummary')}</Txt>
      </View> : null}
      <ApprovalNote kind="opinion" text={ccOpinion} />
      {/* 次要的两条入口挨在一起,不和上面的块抢 */}
      <View>
      {details.length ? <Sheet quiet testID="approval-details" title={t(lang, 'approval.details')}>
        <View style={{ gap: space.m }}>{details.map(({ key, label, value }) => <View key={key} style={{ gap: space.xs }}>
          <Txt role="caption" tone="inkSoft">{label}</Txt>
          <Txt testID={key === 'reason' ? 'approval-question-reason' : undefined} role="body" content="user">{value}</Txt>
        </View>)}</View>
      </Sheet> : null}
      <View collapsable={false} onLayout={e => { exactY.current = e.nativeEvent.layout.y }}>
        <Sheet quiet testID="approval-view-exact" title={t(lang, 'approval.viewExact')} expanded={exactOpen} onExpandedChange={open => {
          jumpOnLayout.current = false
          setExactOpen(open)
        }}>
          <ScrollView nestedScrollEnabled style={{ maxHeight: 320 }} onLayout={() => {
            if (!jumpOnLayout.current) return
            jumpOnLayout.current = false
            onShowExact?.(exactY.current)
          }}>
            <Txt selectable role="code" testID="approval-exact-source">{v.rawFull}</Txt>
          </ScrollView>
        </Sheet>
      </View>
      </View>
    </View>
  )
}
