// 入口:先补运行时(随机数、UTF-8),再交给 expo-router。import 按书写顺序求值,
// 所以补丁一定在任何模块 import '@wechat-cc/protocol' 之前装好。
import './src/net/install-polyfills'
import 'expo-router/entry'
