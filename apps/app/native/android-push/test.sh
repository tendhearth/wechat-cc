#!/usr/bin/env bash
# 本机跑安卓推送核心的 JVM 单测。第一次要联网(kotlin-gradle-plugin 的少量依赖 + org.json,约 10 秒),之后可加 --offline。
# gradle 找法:$GRADLE → PATH 上的 gradle → ~/.gradle 里缓存的 9.1.0 发行版。JDK 默认 Homebrew 的 openjdk@21。
set -euo pipefail
cd "$(dirname "$0")"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}"
G="${GRADLE:-}"
if [ -z "$G" ]; then G="$(command -v gradle || true)"; fi
if [ -z "$G" ]; then G="$(ls -d "$HOME"/.gradle/wrapper/dists/gradle-9.1.0-all/*/gradle-9.1.0/bin/gradle 2>/dev/null | head -1 || true)"; fi
if [ -z "$G" ]; then echo "找不到 gradle:brew install gradle,或设 GRADLE=/path/to/bin/gradle" >&2; exit 2; fi
exec "$G" --no-daemon test "$@"
