"""打包进两端的 CJK 衬线字保留哪些字(spec 2026-10-01-tendhearth-design-unify §3 / §9-5)。

输出(UTF-8,无换行)= GB2312 全部可编码字符(6763 个汉字 + 一至九区的符号、假名、注音、俄文、制表符)
                    ∪ 《通用规范汉字表》(2013)一级 + 二级 6500 字(scripts/fonts/tgscc-level-1-2.txt,来源与 sha256 在 sources.lock.json)。
合计 7635 个码位(其中汉字 6953)。拉丁 / 标点 / 全角等码段由 build-fonts.sh 另用 --unicodes 补上。
GB2312 直接用 Python 自带的 gb2312 编解码器枚举,不另存数据文件 —— 同一个 Python 跑几次结果都一样。

用法:python3 scripts/fonts/cjk-common-chars.py <输出文件>
"""
import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def gb2312() -> set[str]:
    out = set()
    for hi in range(0xA1, 0xF8):
        for lo in range(0xA1, 0xFF):
            try:
                out.add(bytes([hi, lo]).decode('gb2312'))
            except UnicodeDecodeError:
                pass
    return out


def tgscc() -> set[str]:
    path = HERE / 'tgscc-level-1-2.txt'
    raw = path.read_bytes()
    want = json.loads((HERE / 'sources.lock.json').read_text(encoding='utf-8'))['tgscc']['sha256']
    got = hashlib.sha256(raw).hexdigest()
    if got != want:
        sys.exit(f'sha256 mismatch for {path.name}: {got} != {want}')
    chars = [line.strip() for line in raw.decode('utf-8').splitlines() if line.strip()]
    if len(chars) != 6500 or any(len(c) != 1 for c in chars):
        sys.exit(f'{path.name}: expected 6500 single characters, got {len(chars)}')
    return set(chars)


def main() -> None:
    chars = gb2312() | tgscc()
    Path(sys.argv[1]).write_text(''.join(sorted(chars)), encoding='utf-8')
    print(f'cjk-common: {len(chars)} code points')


if __name__ == '__main__':
    main()
