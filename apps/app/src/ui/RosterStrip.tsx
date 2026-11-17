import { Pressable, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useRoster } from '../state/roster'
import { stripView, rosterHref } from '../view/roster-strip'
import { useLang } from '../i18n/useLang'
import { AgentAvatar } from './AgentAvatars'
import { Txt } from './Txt'
import { space } from './tokens'
import { useTheme } from './useTheme'
export function RosterStrip() {
  const roster = useRoster(), router = useRouter(), lang = useLang(), {c} = useTheme()
  const view = stripView(roster.items, {known:!roster.stale})
  if (!view.total) return null
  return <View testID="roster-strip" style={{flexDirection:'row',alignItems:'center',paddingHorizontal:space.l,paddingVertical:space.s,borderBottomWidth:1,borderBottomColor:c.hair}}>
    {view.avatars.map((a,i) => <Pressable key={a.key} testID={`roster-avatar-${i}`} accessibilityRole="button" accessibilityLabel={a.label} onPress={()=>router.push(rosterHref(roster.items.find(r=>r.key===a.key)!) as never)} style={{minWidth:44,minHeight:44,justifyContent:'center',alignItems:'center'}}>
      {a.agents.length > 1 ? <View style={{width:40,height:40}}>
        <View style={{position:'absolute',left:0,top:0,opacity:0.5}}><AgentAvatar id={a.agents[1]!} size={26} /></View>
        <View style={{position:'absolute',right:0,bottom:0}}><AgentAvatar id={a.current} size={30} border={a.waiting?'accent':'ink'} borderWidth={a.waiting?2:1} /></View>
      </View> : <AgentAvatar id={a.current} size={40} border={a.waiting?'accent':'hair'} borderWidth={a.waiting?2:1} />}
    </Pressable>)}
    <Pressable testID="roster-open" accessibilityRole="button" onPress={()=>router.push('/roster')} style={{flex:1,minHeight:44,alignItems:'flex-end',justifyContent:'center'}}><Txt role="meta" tone="inkSoft">{lang==='zh-Hans'?`在做 ${view.total} ›`:`Working ${view.total} ›`}</Txt></Pressable>
  </View>
}
