#!/usr/bin/env bash
# 一次性生成两端的衬线字体(spec 2026-10-01 §3)。只在换字体时跑;生成物入库,运行时不下载(永不走 CDN)。
# 依赖:python3 + `pip install fonttools brotli`(PYTHON 环境变量可指定解释器)。
# 源字体固定到 google/fonts 的提交,并按 sources.lock.json 校验 sha256;不符即失败。
# Noto Serif SC 只出 Regular(裁决 D1);Source Serif 4 出 Regular+Medium。
set -euo pipefail
PY="${PYTHON:-python3}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
LOCK="$ROOT/scripts/fonts/sources.lock.json"
lock() { "$PY" -c "import json,sys;d=json.load(open('$LOCK'));print(eval(sys.argv[1]))" "$1"; }
GF=https://raw.githubusercontent.com/google/fonts
NOTO_REV="$(lock "d['notoSerifSC']['commit']")"; SRC_REV="$(lock "d['sourceSerif4']['commit']")"
curl -fsSL "$GF/$NOTO_REV/ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf" -o "$WORK/noto.ttf"
curl -fsSL "$GF/$SRC_REV/ofl/sourceserif4/SourceSerif4%5Bopsz,wght%5D.ttf" -o "$WORK/source.ttf"
curl -fsSL "$GF/$NOTO_REV/ofl/notoserifsc/OFL.txt" -o "$WORK/OFL-noto.txt"
curl -fsSL "$GF/$SRC_REV/ofl/sourceserif4/OFL.txt" -o "$WORK/OFL-source.txt"
curl -fsSL "$(lock "d['geistMonoLicense']['url']")" -o "$WORK/OFL-geist.txt"
chk() { local got; got="$(shasum -a 256 "$1" | cut -d' ' -f1)"; [ "$got" = "$2" ] || { echo "sha256 mismatch for $1: $got != $2" >&2; exit 1; }; }
chk "$WORK/noto.ttf" "$(lock "d['notoSerifSC']['sha256']")"
chk "$WORK/source.ttf" "$(lock "d['sourceSerif4']['sha256']")"
chk "$WORK/OFL-noto.txt" "$(lock "d['notoSerifSC']['oflSha256']")"
chk "$WORK/OFL-source.txt" "$(lock "d['sourceSerif4']['oflSha256']")"
chk "$WORK/OFL-geist.txt" "$(lock "d['geistMonoLicense']['sha256']")"

CJK="U+0000-00FF,U+0131,U+0152-0153,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2190-21FF,U+3000-303F,U+4E00-9FFF,U+FF00-FFEF"
LATIN="U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2190-21FF,U+2212,U+2215"
SUB() { "$PY" -m fontTools.subset "$@"; }
INST() { "$PY" -m fontTools.varLib.instancer "$@"; }
APP="$ROOT/apps/app/assets/fonts"; DESK="$ROOT/apps/desktop/src/fonts"
mkdir -p "$APP" "$DESK"

INST "$WORK/noto.ttf" wght=400 -o "$WORK/noto-400.ttf" >/dev/null
SUB "$WORK/noto-400.ttf" --unicodes="$CJK" --layout-features='*' --output-file="$WORK/nsc.ttf"
"$PY" "$ROOT/scripts/fonts/rename-source.py" "$WORK/nsc.ttf" Regular "Noto Serif SC" NotoSerifSC   # 实例名表还写着 ExtraLight
cp "$WORK/nsc.ttf" "$APP/NotoSerifSC-Regular.ttf"
"$PY" -c "from fontTools.ttLib import TTFont;f=TTFont('$WORK/nsc.ttf');f.flavor='woff2';f.save('$DESK/noto-serif-sc-400.woff2')"
for W in 400 500; do
  NAME=$([ $W = 400 ] && echo Regular || echo Medium)
  INST "$WORK/source.ttf" wght=$W opsz=16 -o "$WORK/source-$W.ttf" >/dev/null
  SUB "$WORK/source-$W.ttf" --unicodes="$LATIN" --layout-features='*' --output-file="$WORK/ss-$W.ttf"
  "$PY" "$ROOT/scripts/fonts/rename-source.py" "$WORK/ss-$W.ttf" "$NAME" "TH Serif 4" THSerif4   # RFN 'Source'
  cp "$WORK/ss-$W.ttf" "$APP/SourceSerif4-$NAME.ttf"
  "$PY" -c "from fontTools.ttLib import TTFont;f=TTFont('$WORK/ss-$W.ttf');f.flavor='woff2';f.save('$DESK/source-serif-4-$W.woff2')"
done
# 三份 OFL 合成一份(各自版权行保留);Geist Mono 仍在桌面,所以桌面与手机同一份
for D in "$APP" "$DESK"; do
  { printf -- '----- Noto Serif SC -----\n\n'; cat "$WORK/OFL-noto.txt"; printf '\n\n----- Source Serif 4 -----\n\n'; cat "$WORK/OFL-source.txt"; printf '\n\n----- Geist Mono -----\n\n'; cat "$WORK/OFL-geist.txt"; } > "$D/OFL.txt"
done
du -ch "$APP"/*.ttf "$DESK"/*-serif-*.woff2 | tail -1
# 手机设置里「开源字体许可」显示的文本:同一份 OFL.txt 生成 TS 字符串(资源文件在运行时读不出文字;tokens.test 钉住两者一致)
"$PY" -c "import json,sys;t=open('$APP/OFL.txt',encoding='utf-8').read();open('$ROOT/apps/app/src/ui/ofl-text.ts','w',encoding='utf-8').write('// 生成物(scripts/fonts/build-fonts.sh):assets/fonts/OFL.txt 原文,给设置里的「开源字体许可」页显示。别手改。\nexport const OFL_TEXT = '+json.dumps(t,ensure_ascii=False)+'\n')"
