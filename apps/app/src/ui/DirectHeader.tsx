import { useRouter } from 'expo-router'
import { Pressable, View } from 'react-native'
import type { DirectHeaderView } from '../view/direct-header'
import { AgentAvatar } from './AgentAvatars'
import { Txt } from './Txt'
import { IconButton } from './IconButton'
import { space } from './tokens'
import { useTheme } from './useTheme'
/** Back always lands in CC, including direct cold-start links with no navigation history. */
export function DirectHeader({view,onMore,onProject}: {view:DirectHeaderView;onMore():void;onProject?():void}) {
  const router=useRouter(), {c}=useTheme()
  return <View testID="direct-header" style={{paddingHorizontal:space.l,paddingVertical:space.s,gap:space.xs,borderBottomWidth:1,borderBottomColor:c.hair}}>
    <View style={{flexDirection:'row',alignItems:'center',gap:space.s}}>
      <Pressable testID="topbar-back" accessibilityRole="button" accessibilityLabel="CC" onPress={()=>router.canGoBack()?router.back():router.replace('/')} style={{minHeight:44,minWidth:44,justifyContent:'center'}}><Txt role="meta">‹ CC</Txt></Pressable>
      <AgentAvatar id={view.current} size={36} border="ink" />
      <View style={{flex:1}}><Txt testID="direct-title" role="item" content="user" numberOfLines={view.titleLines}>{view.title}</Txt>
        {onProject?<Pressable testID="direct-project" accessibilityRole="button" onPress={onProject} style={{minHeight:44,justifyContent:'center'}}><Txt role="caption" tone="inkSoft">{view.subtitle}</Txt></Pressable>:<Txt role="caption" tone="inkSoft">{view.subtitle}</Txt>}
      </View>
      <IconButton name="more" label="⋯" testID="direct-more" onPress={onMore} />
    </View>
    {view.relay.length?<View testID="direct-relay" style={{flexDirection:'row',alignItems:'center',paddingLeft:space.xl,gap:space.s,flexWrap:'wrap'}}>{view.relay.map((a,i)=><View key={a.id} style={{flexDirection:'row',alignItems:'center',gap:space.s}}>{i?<Txt role="caption" style={{color:c.hair}}>—</Txt>:null}<Txt role="caption" tone={a.current?'ink':'inkSoft'}>{a.name}</Txt></View>)}</View>:null}
  </View>
}
