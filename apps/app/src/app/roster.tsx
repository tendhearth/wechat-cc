import { WelcomeGate } from '../ui/WelcomeGate'
import { HOME_GROUP_WORDS } from '@wechat-cc/protocol'
import { useRouter } from 'expo-router'
import { ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLang } from '../i18n/useLang'
import { useRoster } from '../state/roster'
import { rosterRow } from '../view/roster-strip'
import { MatterRow } from '../ui/MatterRow'
import { TopBar } from '../ui/TopBar'
import { ConnectionNotice } from '../ui/ConnectionNotice'
import { Txt } from '../ui/Txt'
import { space } from '../ui/tokens'
import { useTheme } from '../ui/useTheme'
export default function Roster() { return <WelcomeGate><RosterList /></WelcomeGate> }
export function RosterList() {
  const roster = useRoster(), router = useRouter(), lang = useLang(), {c} = useTheme()
  return <SafeAreaView style={{flex:1,backgroundColor:c.paper}}><TopBar title={HOME_GROUP_WORDS[lang].working} onBack={()=>router.canGoBack()?router.back():router.replace('/')} /><ConnectionNotice />
    <ScrollView contentContainerStyle={{padding:space.xl,gap:space.l}}>{(['waiting','working','back'] as const).map(group=>{
      const rows=roster.items.filter(i=>i.group===group)
      return rows.length?<View key={group}><Txt role="meta" tone={group==='waiting'&&!roster.stale?'accent':'inkSoft'}>{HOME_GROUP_WORDS[lang][group]}</Txt>{rows.map(item=>{const row=rosterRow(item,!roster.stale);return <MatterRow key={item.key} row={row} onOpen={()=>{router.dismissTo('/');router.push(row.href as never)}} />})}</View>:null
    })}</ScrollView></SafeAreaView>
}
