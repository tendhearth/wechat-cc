import { Pressable, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useLang } from '../i18n/useLang'
import { t } from '../i18n'
import { useMatterSay } from '../state/matter-say'
import type { DirectHeaderView } from '../view/direct-header'
import { AgentAvatar } from './AgentAvatars'
import { TextField } from './TextField'
import { Icon } from './Icon'
import { IconButton } from './IconButton'
import { Txt } from './Txt'
import { componentAppearance, radius, space } from './tokens'
import { useTheme } from './useTheme'
export function DirectComposer({view,text,onChangeText,onSend,disabled,busy,onAdd,testID='direct',maxLength,variant='chat'}:{view:DirectHeaderView;text:string;onChangeText(v:string):void;onSend():void;disabled?:boolean;busy?:boolean;onAdd?():void;testID?:string;maxLength?:number;variant?:'chat'}) {
  const {c}=useTheme(),lang=useLang(),appearance=componentAppearance.textField.chat
  return <View style={{flexDirection:'row',alignItems:'center',gap:space.s,padding:space.s,borderWidth:appearance.borderWidth,borderColor:c.accent,borderRadius:radius.control}}>
    {onAdd?<IconButton name="plus" testID={`${testID}-add`} label={t(lang,'images.addLabel')} onPress={onAdd}/>:null}
    <AgentAvatar id={view.current} size={24} border="ink" />
    <TextField variant={variant} underlineColorAndroid="transparent" maxLength={maxLength} testID={`${testID}-input`} value={text} onChangeText={onChangeText} placeholder={view.placeholder} accessibilityLabel={view.placeholder} multiline style={{flex:1,minHeight:44,maxHeight:140,borderWidth:0,borderBottomWidth:0,paddingHorizontal:0,paddingVertical:space.s}} />
    <Pressable testID={`${testID}-send`} accessibilityRole="button" accessibilityLabel={t(lang,'input.send')} accessibilityState={{disabled:disabled||busy,busy}} disabled={disabled||busy} onPress={onSend} style={{width:44,height:44,borderRadius:radius.control,alignItems:'center',justifyContent:'center',backgroundColor:c.accent,opacity:disabled||busy?componentAppearance.button.disabledOpacity:1}}><Icon name="arrowUp" color={c.onAccent} /></Pressable>
  </View>
}
export function MatterDirectComposer({id,view}:{id:string;view:DirectHeaderView}) {
  const say=useMatterSay({kind:'matter',id}),router=useRouter(),lang=useLang()
  const pending=say.rows.some(r=>['uncertain','accepted','submitting'].includes(r.status))
  return <View style={{gap:space.s}}>
    <DirectComposer view={view} text={say.text} onChangeText={say.setText} onSend={()=>void say.send()} disabled={!say.online||!say.text.trim()||(!say.detail.fresh&&!pending)} busy={say.busy} onAdd={()=>router.push(`/compose?matter=${encodeURIComponent(id)}`)} />
    {pending?<Txt testID="direct-unconfirmed" role="meta" tone="inkSoft">{lang==='zh-Hans'?'结果待核对':'Result awaiting confirmation'}</Txt>:null}
    {say.inputNotice?<Txt role="meta" tone="inkSoft">{say.inputNotice}</Txt>:null}
  </View>
}
