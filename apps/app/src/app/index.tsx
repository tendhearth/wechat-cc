import { HomeTopic } from '@wechat-cc/protocol';
import { StyleSheet, Text, View } from 'react-native';

// 占位首页:只证明工程能打包、能起来,并且协议包(zod v4 + noble)在 Metro 下能打进去 ——
// export:check 靠这一行 import 覆盖协议包。页面与演示模式在后续任务里替换。
const EMPTY_HOME = HomeTopic.parse({ unread: 0, presenceState: null, nextCursor: null });

export default function Index() {
  return (
    <View style={styles.container}>
      <Text>Tendhearth</Text>
      <Text>{EMPTY_HOME.unread}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
