#!/usr/bin/env bash
# 一次性生成两端的衬线字体(spec 2026-10-01 §3)。只在换字体时跑;生成物入库,运行时不下载(永不走 CDN)。
# 依赖:python3 + `pip install fonttools brotli`(PYTHON 环境变量可指定解释器)。
# 源字体和许可证固定到提交或发行版,并按 sources.lock.json 校验 sha256;不符即失败。
# 本子三支笔源自霞鹜文楷 Lite、悠哉字体、朱雀仿宋,与 Noto Serif SC 共用字表。
# --pens-only 只重建桌面的笔。--app-pens 只生成 App TTF 和许可证。
# PEN_SOURCE_DIR 可复用已从锁定地址取得的文件，仍核对每一项 sha256。
# Noto Serif SC 只出 Regular(裁决 D1);Source Serif 4 出 Regular+Medium。
#
# 重新生成(换字体 / 改字表时):
#   python3 -m venv /tmp/fontenv && /tmp/fontenv/bin/pip install fonttools brotli
#   PYTHON=/tmp/fontenv/bin/python scripts/fonts/build-fonts.sh
#   bun --bun vitest run scripts/design-tokens.guard.test.ts apps/app/src/ui   # 体积预算 / 字表 / 许可证守卫
# 结束时打印每个生成物的字节数;同一份源字体 + 字表 + fonttools / brotli 版本,输出逐字节相同(时间戳钉在 SOURCE_DATE_EPOCH)。
#
# CJK 只保留常用字(主人 2026-10-01 拍板,spec §9-5):GB2312 ∪《通用规范汉字表》一级 + 二级(scripts/fonts/cjk-common-chars.py,
# 共 7635 个码位,汉字 6953),再加下面 CJK_EXTRA 的拉丁 / 标点 / CJK 符号 / 全角码段。字表外的字(生僻字、扩展区)
# 不在包里:桌面按 --th-font-serif 逐字退回系统衬线(宋体),手机由系统逐字退回系统中文字体 —— 都不会出现豆腐块。
set -euo pipefail
# fontTools 把 head.modified 写成当前时间;钉一个固定时间戳,同样的输入才会得到逐字节相同的输出。
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1759276800}"   # 2025-10-01T00:00:00Z
PY="${PYTHON:-python3}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
LOCK="$ROOT/scripts/fonts/sources.lock.json"
lock() { "$PY" -c "import json,sys;d=json.load(open(sys.argv[1],encoding='utf-8'));print(eval(sys.argv[2]))" "$LOCK" "$1"; }
chk() { local got; got="$(shasum -a 256 "$1" | cut -d' ' -f1)"; [ "$got" = "$2" ] || { echo "sha256 mismatch for $1: $got != $2" >&2; exit 1; }; }

CJK_EXTRA="U+0000-00FF,U+0131,U+0152-0153,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2190-21FF,U+3000-303F,U+FF00-FFEF"
"$PY" "$ROOT/scripts/fonts/cjk-common-chars.py" "$WORK/cjk-chars.txt"   # 校验字表 sha256(sources.lock.json 的 tgscc)
LATIN="U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2190-21FF,U+2212,U+2215"
SUB() { "$PY" -m fontTools.subset "$@"; }
INST() { "$PY" -m fontTools.varLib.instancer "$@"; }
APP="$ROOT/apps/app/assets/fonts"; DESK="$ROOT/apps/desktop/src/fonts"
mkdir -p "$APP" "$DESK"

mode="${1:-}"
case "$mode" in
  ""|--pens-only|--app-pens) ;;
  *) echo "Usage: $0 [--pens-only|--app-pens]" >&2; exit 2 ;;
esac
base_ofl="$APP/OFL.txt"
if [ -z "$mode" ]; then
  base_ofl="$WORK/OFL-serif.txt"
  GF=https://raw.githubusercontent.com/google/fonts
  NOTO_REV="$(lock "d['notoSerifSC']['commit']")"; SRC_REV="$(lock "d['sourceSerif4']['commit']")"
  curl -fsSL "$GF/$NOTO_REV/ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf" -o "$WORK/noto.ttf"
  curl -fsSL "$GF/$SRC_REV/ofl/sourceserif4/SourceSerif4%5Bopsz,wght%5D.ttf" -o "$WORK/source.ttf"
  curl -fsSL "$GF/$NOTO_REV/ofl/notoserifsc/OFL.txt" -o "$WORK/OFL-noto.txt"
  curl -fsSL "$GF/$SRC_REV/ofl/sourceserif4/OFL.txt" -o "$WORK/OFL-source.txt"
  curl -fsSL "$(lock "d['geistMonoLicense']['url']")" -o "$WORK/OFL-geist.txt"
  chk "$WORK/noto.ttf" "$(lock "d['notoSerifSC']['sha256']")"
  chk "$WORK/source.ttf" "$(lock "d['sourceSerif4']['sha256']")"
  chk "$WORK/OFL-noto.txt" "$(lock "d['notoSerifSC']['oflSha256']")"
  chk "$WORK/OFL-source.txt" "$(lock "d['sourceSerif4']['oflSha256']")"
  chk "$WORK/OFL-geist.txt" "$(lock "d['geistMonoLicense']['sha256']")"

  INST "$WORK/noto.ttf" wght=400 -o "$WORK/noto-400.ttf" >/dev/null
  SUB "$WORK/noto-400.ttf" --unicodes="$CJK_EXTRA" --text-file="$WORK/cjk-chars.txt" --layout-features='*' --output-file="$WORK/nsc.ttf"
  "$PY" "$ROOT/scripts/fonts/rename-source.py" "$WORK/nsc.ttf" Regular "Noto Serif SC" NotoSerifSC   # 实例名表还写着 ExtraLight
  cp "$WORK/nsc.ttf" "$APP/NotoSerifSC-Regular.ttf"
  "$PY" -c "from fontTools.ttLib import TTFont;f=TTFont('$WORK/nsc.ttf');f.flavor='woff2';f.save('$DESK/noto-serif-sc-400.woff2')"
  for W in 400 500; do
    NAME=$([ $W = 400 ] && echo Regular || echo Medium)
    INST "$WORK/source.ttf" wght=$W opsz=16 -o "$WORK/source-$W.ttf" >/dev/null
    SUB "$WORK/source-$W.ttf" --unicodes="$LATIN" --layout-features='*' --output-file="$WORK/ss-$W.ttf"
    "$PY" "$ROOT/scripts/fonts/rename-source.py" "$WORK/ss-$W.ttf" "$NAME" "TH Serif 4" THSerif4   # RFN 'Source'
    cp "$WORK/ss-$W.ttf" "$APP/THSerif4-$NAME.ttf"
    "$PY" -c "from fontTools.ttLib import TTFont;f=TTFont('$WORK/ss-$W.ttf');f.flavor='woff2';f.save('$DESK/th-serif-4-$W.woff2')"
  done
  { printf -- '----- Noto Serif SC -----\n\n'; cat "$WORK/OFL-noto.txt"; printf '\n\n----- Source Serif 4 -----\n\n'; cat "$WORK/OFL-source.txt"; printf '\n\n----- Geist Mono -----\n\n'; cat "$WORK/OFL-geist.txt"; } > "$base_ofl"
fi

# 钉住下载件,压缩包的成员也独立校验。所有来源就绪后才写随包文件。
for key in kai hand fangsong; do
  entry="d['notebookPens']['$key']"
  if [ -n "${PEN_SOURCE_DIR:-}" ]; then
    suffix=ttf
    [ "$key" != fangsong ] || suffix=zip
    cp "$PEN_SOURCE_DIR/$key.$suffix" "$WORK/$key.download"
  else
    curl -fsSL "$(lock "$entry['url']")" -o "$WORK/$key.download"
  fi
  chk "$WORK/$key.download" "$(lock "$entry['sha256']")"
  if [ "$key" = fangsong ]; then
    unzip -p "$WORK/$key.download" "$(lock "$entry['ttfMember']")" > "$WORK/$key.ttf"
    chk "$WORK/$key.ttf" "$(lock "$entry['ttfSha256']")"
  else
    mv "$WORK/$key.download" "$WORK/$key.ttf"
  fi
  if [ -n "${PEN_SOURCE_DIR:-}" ]; then
    cp "$PEN_SOURCE_DIR/OFL-$key.txt" "$WORK/OFL-$key.txt"
  else
    curl -fsSL "$(lock "$entry['oflUrl']")" -o "$WORK/OFL-$key.txt"
  fi
  chk "$WORK/OFL-$key.txt" "$(lock "$entry['oflSha256']")"
done

for key in kai hand fangsong; do
  family="$(lock "d['notebookPens']['$key']['family']")"
  psfamily="${family// /}"
  # 禁用双向标点镜像闭包,字表外码位仍交给页面衬线体。
  SUB "$WORK/$key.ttf" --no-bidi-closure --unicodes="$CJK_EXTRA" --text-file="$WORK/cjk-chars.txt" --layout-features='*' --output-file="$WORK/pen-$key.ttf"
  "$PY" "$ROOT/scripts/fonts/rename-source.py" "$WORK/pen-$key.ttf" Regular "$family" "$psfamily"
  "$PY" - "$WORK" "$key" "$CJK_EXTRA" "$family" "$psfamily" <<'PYTHON_SCRIPT'
import sys
from pathlib import Path
from fontTools.subset import parse_unicodes
from fontTools.ttLib import TTFont

directory, key, extra, family, psfamily = sys.argv[1:]
work = Path(directory)
allowed = set(map(ord, (work / "cjk-chars.txt").read_text(encoding="utf-8")))
allowed.update(parse_unicodes(extra))
with TTFont(work / f"{key}.ttf") as source, TTFont(work / f"pen-{key}.ttf") as output:
    expected = allowed.intersection(source.getBestCmap())
    actual = set(output.getBestCmap())
    if actual != expected:
        sys.exit(f"{key}: unexpected cmap ({len(expected - actual)} missing, {len(actual - expected)} extra)")
    names = {1: family, 4: f"{family} Regular", 6: f"{psfamily}-Regular", 16: family}
    for record in output["name"].names:
        if record.nameID in names and record.toUnicode() != names[record.nameID]:
            sys.exit(f"{key}: unexpected name ID {record.nameID}")
    for name_id in (1, 4, 6):
        if not output["name"].getDebugName(name_id):
            sys.exit(f"{key}: missing name ID {name_id}")
PYTHON_SCRIPT
  if [ "$mode" = --app-pens ]; then
    mv "$WORK/pen-$key.ttf" "$WORK/$psfamily-Regular.ttf"
  else
    "$PY" -m fontTools.ttLib.woff2 compress "$WORK/pen-$key.ttf" -o "$WORK/th-pen-$key.woff2"
  fi
done

# 从已有的衬线许可取基础段落,重复生成时替换笔的许可段落。
sed '/^----- 霞鹜文楷 Lite -----$/,$d' "$base_ofl" > "$WORK/OFL-base.txt"
"$PY" - "$WORK" "$LOCK" <<'PYTHON_SCRIPT'
import json
import sys
from pathlib import Path
work, lock = map(Path, sys.argv[1:])
papers = json.loads(lock.read_text(encoding="utf-8"))["notebookPens"]
combined = (work / "OFL-base.txt").read_bytes().rstrip(b"\n")
for key, pen in papers.items():
    combined += f"\n\n----- {pen['title']} -----\n\n".encode()
    combined += (work / f"OFL-{key}.txt").read_bytes()
(work / "OFL-pens.txt").write_bytes(combined)
PYTHON_SCRIPT
if [ "$mode" != --app-pens ]; then
  cp "$WORK"/th-pen-*.woff2 "$DESK/"
  cp "$WORK/OFL-pens.txt" "$DESK/OFL.txt"
  wc -c "$DESK"/*-serif-*.woff2 "$DESK"/th-pen-*.woff2
fi

if [ "$mode" = --app-pens ]; then
  cp "$WORK"/THPen*-Regular.ttf "$APP/"
fi
if compgen -G "$APP/THPen*-Regular.ttf" >/dev/null && [ "$mode" != --pens-only ]; then
  cp "$WORK/OFL-pens.txt" "$APP/OFL.txt"
elif [ -z "$mode" ]; then
  cp "$base_ofl" "$APP/OFL.txt"
fi
if [ "$mode" = --pens-only ]; then exit 0; fi
wc -c "$APP"/*.ttf
# 手机设置里「开源字体许可」显示的文本:同一份 OFL.txt 生成 TS 字符串(资源文件在运行时读不出文字;tokens.test 钉住两者一致)
"$PY" -c "import json,sys;t=open('$APP/OFL.txt',encoding='utf-8').read();open('$ROOT/apps/app/src/ui/ofl-text.ts','w',encoding='utf-8').write('// 生成物(scripts/fonts/build-fonts.sh):assets/fonts/OFL.txt 原文,给设置里的「开源字体许可」页显示。别手改。\nexport const OFL_TEXT = '+json.dumps(t,ensure_ascii=False)+'\n')"
