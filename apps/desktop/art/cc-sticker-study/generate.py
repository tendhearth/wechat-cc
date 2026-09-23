"""Review-only SVG study. Fixed CC body + authored C poses; no model calls."""
from pathlib import Path
import json
ROOT = Path(__file__).resolve().parent
INK='#725942'; BODY='#fff7e6'; GOLD='#dda23f'; GREEN='#8aa36f'; RUST='#b0563a'
def path(d,fill='none',stroke=INK,w=3,extra=''):
    return f'<path d="{d}" fill="{fill}" stroke="{stroke}" stroke-width="{w}" stroke-linecap="round" stroke-linejoin="round" {extra}/>'
def ellipse(x,y,rx,ry,fill,stroke='none',w=2):
    return f'<ellipse cx="{x}" cy="{y}" rx="{rx}" ry="{ry}" fill="{fill}" stroke="{stroke}" stroke-width="{w}"/>'
def rect(x,y,w,h,fill,rx=4,stroke=INK):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="2.5"/>'
def sparkle(x,y,s=8):
    return path(f'M{x} {y-s}Q{x} {y} {x+s} {y}Q{x} {y} {x} {y+s}Q{x} {y} {x-s} {y}Q{x} {y} {x} {y-s}',GOLD,'none')
POSES={
'default':'M117 155C104 138 101 116 109 94C118 66 141 51 164 55C185 58 194 76 185 90C178 101 167 100 158 96C145 91 137 105 137 117C136 128 140 138 147 143',
'happy':'M117 155C99 128 103 97 120 69C135 43 158 36 174 44C193 52 194 70 184 78C176 87 165 80 158 83C144 90 138 112 141 128L147 143',
'forward':'M117 155C103 128 109 100 131 87C151 75 179 78 189 96C197 109 189 121 179 121C168 121 162 109 153 111C142 112 139 128 147 143',
'sleep':'M117 155C105 139 105 118 119 107C136 94 161 93 179 104C195 116 194 133 184 137C174 140 168 132 166 124C163 116 152 114 144 122C139 128 141 138 147 143',
'listening':'M117 155C101 134 103 113 119 91C135 71 159 64 177 75C190 83 189 98 180 104C171 111 162 103 154 108C143 116 141 134 147 143',
}
BODY_END='C179 138 212 146 232 169C253 192 260 224 246 248C234 271 214 278 177 279C136 281 101 277 84 258C67 239 65 213 73 193C81 175 96 162 117 155Z'
def cc(pose='default',eyes='default',form='light'):
    art=ellipse(162,280,89,7,'#725942')
    art='<g opacity="0.10">'+art+'</g>'
    art+=path(POSES[pose]+BODY_END,BODY,INK,3.1)
    art+=path('M82 228C97 257 126 269 170 269C204 269 231 257 246 237C232 269 211 276 177 277C131 280 97 272 84 254Z','#f0dec4','none',extra='opacity="0.7"')
    art+=path('M87 203C92 186 105 176 120 170',stroke='#ffffff',w=4)
    art+=path('M100 271C98 262 105 253 116 255C128 256 134 268 126 276C116 284 101 280 100 271Z',BODY,INK,2.5)
    art+=path('M205 270C207 258 218 254 227 259C238 265 231 279 219 280C209 281 203 277 205 270Z',BODY,INK,2.5)
    if eyes=='happy':
        art+=path('M150 219Q157 209 164 219M191 219Q198 209 205 219',stroke='#332b23',w=4.5)
    elif eyes=='sleep':
        art+=path('M149 219Q157 225 165 219M190 219Q198 225 206 219',stroke='#332b23',w=3.5)
    elif eyes=='thinking':
        art+=path('M149 218L164 218M189 218L204 218',stroke='#332b23',w=3.5)
    else:
        dx=3 if eyes=='look' else 0
        art+=rect(152+dx,206,7,21,'#332b23',3.5,'none')+rect(193+dx,205,7,21,'#332b23',3.5,'none')
    if form == 'dark':
        art=art.replace(BODY,'#343330').replace('#f0dec4','#252623').replace('#332b23','#fff7e6').replace('#ffffff','#a99d87')
        # Warm rim stays a vector stroke; no halo or extra silhouette.
        art=art.replace(f'stroke="{INK}"', 'stroke="#a99a81"')
    return art

def svg(title,content,w=320,h=320):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}"><title>{title}</title>{content}</svg>\n'

def cup(x,y):
    return rect(x,y,24,22,BODY,5)+path(f'M{x+24} {y+4}C{x+40} {y} {x+39} {y+20} {x+24} {y+17}')+path(f'M{x+7} {y-7}C{x+1} {y-14} {x+14} {y-17} {x+8} {y-24}',stroke='#b99463',w=2)

stickers=[
('received','收到','default','default',rect(228,100,45,31,'#f1dfbd',5)+path('M232 105L251 118L269 105',stroke=RUST,w=2.5)+path('M268 82L274 88L285 72',stroke=GREEN,w=3),'记住啦。'),
('happy','开心','happy','happy',sparkle(82,100,9)+sparkle(234,72,11)+sparkle(265,145,6),'这下开心了。'),
('thinking','思考','forward','thinking',ellipse(218,79,3,3,INK)+ellipse(237,66,4,4,INK)+ellipse(260,59,5,5,INK),'让我想一会儿。'),
('cheering','加油','happy','default',path('M242 175L252 98',stroke=INK,w=3)+path('M251 99Q267 102 283 112L261 121L248 118Z',RUST,INK,2.5)+sparkle(86,116,7),'我陪你慢慢来。'),
('goodnight','晚安','sleep','sleep',path('M241 62C223 76 231 101 254 103C223 117 201 86 219 64C225 57 234 56 241 62Z','#efd291',INK,2)+sparkle(271,134,5)+ellipse(196,60,2.5,2.5,GOLD),'今天就到这里。'),
('company','陪着','listening','look',cup(245,251)+cup(48,257),'不急，我在呢。'),
]
for name,title,pose,eyes,motif,note in stickers:
    (ROOT/(name+'.svg')).write_text(svg(title,cc(pose,eyes)+motif))

# Both postcards share the same CC function, not an independently redrawn mascot.
def leaf(x,y,side=1):
    return path(f'M{x} {y}Q{x+side*20} {y-24} {x+side*26} {y-11}Q{x+side*22} {y+1} {x} {y}',GREEN,INK,1.7)
def plant(x,y):
    return path(f'M{x} {y}Q{x-6} {y-44} {x+8} {y-86}',stroke=INK,w=2)+leaf(x,y-18,1)+leaf(x,y-36,-1)+leaf(x+3,y-54,1)+leaf(x+5,y-72,-1)
def fish(x,y,color,scale=1):
    return f'<g transform="translate({x} {y}) scale({scale})">'+path('M13 0L30 -12L28 13L13 6Z',color,INK,2)+ellipse(0,2,17,11,color,INK,2)+ellipse(-9,0,1.6,1.6,INK)+path('M0 -7Q8 0 2 10',stroke=INK,w=1.5)+'</g>'
def paper():
    return rect(0,0,480,320,'#faf4e7',0,'none')+path('M17 29Q233 19 462 27L461 290Q238 300 18 290Z',stroke='#c6b393',w=1.4)
art=paper()+rect(42,45,157,147,'#e6eee5',2)+rect(51,54,139,128,'#f6f7e9',1,'none')
art+=path('M122 48L122 191M45 121L196 121',stroke=INK,w=2.5)
art+=path('M53 159L115 105M135 173L185 130',stroke='#d9e4d2',w=10)
art+=path('M205 199L448 193L450 275L191 278Z','#ebd8bb',INK,2.5)
art+=path('M194 191L449 189L457 205L185 207Z','#c79d71',INK,2.5)
# Small coffee roaster and its funnel.
art+=rect(326,111,67,79,RUST,13)+path('M336 112L329 81Q355 70 383 81L378 112Z','#dda23f',INK,2.5)
art+=ellipse(356,82,27,6,'#725942',INK)+rect(343,128,30,25,'#f3d593',4)+ellipse(358,140,8,8,BODY,INK,2)+path('M358 140L362 135',w=2)
art+=path('M393 137L412 137L412 76',w=4)+path('M414 63C404 55 424 49 416 39M427 63C419 52 437 48 430 36',stroke='#b99463',w=2)
# Sleeping cat: part of the visited scene, never CC's identity.
art+=ellipse(270,183,30,10,'#d9b28a')+path('M244 185C239 168 256 163 268 171C280 164 294 168 298 181L303 170L308 182Q309 196 292 195L254 195Z','#dda23f',INK,2.2)
art+=path('M288 181L291 173L297 180M294 188L299 188M249 184Q261 192 263 181',w=1.7)
art+=cup(219,160)+plant(433,190)
art+='<g transform="translate(10 137) scale(.51)">'+cc('listening','look')+'</g>'
art+=ellipse(385,266,26,4,'#dec8a8')+ellipse(375,261,4,2,RUST)+ellipse(385,258,4,2,RUST)+ellipse(394,263,4,2,RUST)
(ROOT/'postcard-coffee.svg').write_text(svg('烘豆机旁，猫睡着了',art,480,320))
art=paper()+path('M25 262Q230 250 454 262L455 288L25 291Z','#f0dfbf','none')
art+=rect(162,48,275,207,'#f8f4e6',5)+rect(170,76,259,168,'#dce9df',1,'none')
art+=path('M173 85Q216 77 254 84T333 84T426 85',stroke='#ffffff',w=3)
art+=path('M171 227Q230 218 272 229T429 225L429 245L171 245Z','#e8ce98','none')
for x,y in [(193,231),(393,231),(416,235)]:art+=plant(x,y)
for x,y,rx in [(218,235,14),(368,232,17),(402,243,9)]:art+=ellipse(x,y,rx,6,'#c3b798',INK,1.5)
art+=fish(276,128,GOLD,.9)+fish(346,172,'#d79063',1.0)+fish(243,183,'#9cbcc1',.65)
for x,y,r in [(302,101,4),(318,90,3),(278,154,3),(360,113,4)]:art+=ellipse(x,y,r,r,'none','#fffdf6',2)
art+=path('M161 57L434 57M169 51L169 248',stroke='#c6b393',w=1.5)
art+='<g transform="translate(9 139) scale(.51)">'+cc('default','look')+'</g>'
art+=plant(52,257)+sparkle(144,128,5)
(ROOT/'postcard-fish.svg').write_text(svg('隔着玻璃打个招呼',art,480,320))
manifest={'status':'visual-study-not-shipped','character':'Authored SVG adaptation of CC; not frozen render geometry. One body template, five C poses.','stickers':[{'file':name+'.svg','title':title,'note':note} for name,title,pose,eyes,motif,note in stickers],'postcards':[{'file':'postcard-coffee.svg','title':'烘豆机旁，猫睡着了','note':'烘豆机嗡嗡响，那只橘猫连耳朵都懒得动。我在旁边待了一会儿，觉得今天也可以不用那么赶。'},{'file':'postcard-fish.svg','title':'隔着玻璃打个招呼','note':'有条小鱼隔着玻璃跟着我转。我停下来，它也停下来。什么都没说，倒像已经认识了。'}]}
(ROOT/'study.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')

# Paired study: same paths and props, material-only differences.
paired=[]
for name,title,pose,eyes,motif,note in stickers:
    if name not in ('received','happy','goodnight','company'): continue
    for form in ('light','dark'):
        file=f'{name}-{form}.svg'
        (ROOT/file).write_text(svg(f'{title} · {form}',cc(pose,eyes,form)+motif))
        paired.append({'file':file,'title':title,'note':note,'form':form})
# A quiet evening scene. Existing daytime postcards remain available.
night=paper()+rect(190,44,238,167,'#343b40',5)
night+=path('M309 46L309 209M193 128L425 128',stroke='#b7a485',w=2)
night+=path('M367 64C351 74 357 94 376 93C357 106 340 90 346 75C351 63 360 60 367 64Z','#edd6a4','none')
for x,y in [(220,76),(279,106),(394,110)]: night+=ellipse(x,y,2,2,'#ead8b1')
night+=path('M30 246Q232 238 452 246L452 288L30 290Z','#e4d2b4','none')
night+=rect(247,217,151,9,'#bfa27e',3)+path('M259 227L255 284M386 227L391 284',w=3)
night+=cup(275,191)+path('M331 215L331 174',w=3)+path('M315 172L347 172L340 155L322 155Z','#e5bd72',INK,2)
night+='<g transform="translate(19 127) scale(.54)">'+cc('listening','look','dark')+'</g>'
night+=plant(443,274)
(ROOT/'postcard-night.svg').write_text(svg('窗外慢慢安静下来',night,480,320))
manifest['pairs']=paired
manifest['postcards'].append({'file':'postcard-night.svg','title':'窗外慢慢安静下来','note':'咖啡馆快打烊了，我又坐了一会儿。窗外的灯一盏盏亮起来，杯子里还有一点温热。想着把这份安静也带给你。'})
(ROOT/'study.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')

# Explicit export for the runtime compositor; normal preview regeneration stays local.
if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--export-templates', type=Path)
    args = parser.parse_args()
    if args.export_templates:
        poses = {'received': ('default','default'), 'happy': ('happy','happy'),
                 'thinking': ('forward','thinking'), 'cheering': ('happy','default'),
                 'goodnight': ('sleep','sleep'), 'company': ('listening','look')}
        templates = {f'{form}:{name}': cc(pose,eyes,form)
                     for form in ('light','dark') for name,(pose,eyes) in poses.items()}
        args.export_templates.write_text(json.dumps(templates,ensure_ascii=False,indent=2)+'\n')
