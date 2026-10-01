// swift-tools-version:5.9
import PackageDescription

// 只为在 Mac 上 `swift test`:PushCore 是通知服务扩展的纯逻辑(CryptoKit + Foundation)。
// 构建 app 时由 plugins/with-ios-notify.js 把 Sources/PushCore/*.swift 与 Extension/*.swift 一起拷进 ios/TendhearthNotify/。
let package = Package(
  name: "TendhearthNotify",
  platforms: [.macOS(.v13), .iOS(.v16)],
  products: [.library(name: "PushCore", targets: ["PushCore"])],
  targets: [
    .target(name: "PushCore", path: "Sources/PushCore"),
    .testTarget(name: "PushCoreTests", dependencies: ["PushCore"], path: "Tests/PushCoreTests"),
  ]
)
