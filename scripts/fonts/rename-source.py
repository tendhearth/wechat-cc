"""Also fixes stale instance names (e.g. ExtraLight). Source Serif 4 declares Reserved Font Name 'Source' (name ID 0). A subset/instance is a Modified
Version under the OFL, so the shipped files must not carry that name. Copyright string stays intact."""
import sys
from fontTools.ttLib import TTFont
path, style, fam, psfam = sys.argv[1:5]  # style: Regular | Medium
f = TTFont(path)
full = f"{fam} {style}"
ps = f"{psfam}-{style}"
for rec in f["name"].names:
    if rec.nameID in (1, 16): rec.string = fam
    elif rec.nameID in (2, 17): rec.string = style
    elif rec.nameID == 4: rec.string = full
    elif rec.nameID == 6: rec.string = ps
    elif rec.nameID == 3: rec.string = f"{ps};subset"
f.save(path)
