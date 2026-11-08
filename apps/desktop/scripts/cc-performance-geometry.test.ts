import { expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

it('moves the body assembly without folds and leaves a planted foot unchanged',()=>{
  const file=new URL('./cc_performance_geometry.py',import.meta.url)
  expect(existsSync(file),'transient performance geometry is available').toBe(true)
  const result=JSON.parse(execFileSync(process.platform==='win32'?'python':'python3',['-c',`
import json,sys,math
sys.path.insert(0,sys.argv[1])
from cc_performance_geometry import body_point,foot_point
rest={'lean':0,'squash':1,'rise':0,'shift':0}
motion={'lean':.045,'squash':.9,'rise':.1,'shift':.03}
point=(.2,-.3,1.4)
eps=1e-5
p=body_point(point,motion)
columns=[]
for axis in range(3):
 q=list(point);q[axis]+=eps
 columns.append([(b-a)/eps for a,b in zip(p,body_point(q,motion))])
a,b,c=columns
det=a[0]*(b[1]*c[2]-b[2]*c[1])-b[0]*(a[1]*c[2]-a[2]*c[1])+c[0]*(a[1]*b[2]-a[2]*b[1])
plant={'lift':0,'stride':0,'roll':0}
print(json.dumps({'rest':body_point(point,rest),'plant':foot_point((-.64,-.52,0),(-.64,-.52,0),plant),'det':det,'repeat':body_point(point,motion)==body_point(point,motion)}))
`,fileURLToPath(new URL('.',file))],{encoding:'utf8'}))
  expect(result.rest).toEqual([.2,-.3,1.4])
  expect(result.plant).toEqual([-.64,-.52,0])
  expect(result.det).toBeCloseTo(1,5)
  expect(result.repeat).toBe(true)
})

it('seats directed eyes on the unchanged face while preserving exact neutral placement',()=>{
  const file=new URL('./cc_performance_geometry.py',import.meta.url)
  const result=JSON.parse(execFileSync(process.platform==='win32'?'python':'python3',['-c',`
import json,sys,math
sys.path.insert(0,sys.argv[1])
import cc_performance_geometry as geometry
f=getattr(geometry,'eye_surface_point',None)
result={'available':f is not None}
if f:
 base=(.2,-.918,.8)
 p=f(base,.03,.1)
 rejected=[]
 for gaze,up in [(0,.141),(0,-.041),(.071,0),(float('nan'),0),(0,float('inf'))]:
  try: f(base,gaze,up);rejected.append(False)
  except ValueError: rejected.append(True)
 result.update({'neutral':f(base,0,0),'point':p,'surface':(p[0]/1.12)**2+((p[2]-.742)/.93)**2+((p[1]+.013)/.94)**2,'rejected':rejected,'repeat':f(base,.03,.1)==p,'base':base})
print(json.dumps(result))
`,fileURLToPath(new URL('.',file))],{encoding:'utf8'}))
  expect(result.available,'bounded vertical eye control exists').toBe(true)
  expect(result.neutral).toEqual([.2,-.918,.8])
  expect(result.point[0]).toBeCloseTo(.23,8)
  expect(result.point[2]).toBeCloseTo(.9,8)
  expect(result.point[1]).toBeLessThan(-.9)
  expect(result.surface).toBeCloseTo(1,8)
  expect(result.rejected).toEqual([true,true,true,true,true])
  expect(result.repeat).toBe(true)
  expect(result.base).toEqual([.2,-.918,.8])
})

it('tilts the C around its embedded root without scaling, detaching or accumulating transforms',()=>{
  const file=new URL('./cc_performance_geometry.py',import.meta.url)
  const result=JSON.parse(execFileSync(process.platform==='win32'?'python':'python3',['-c',`
import json,sys,math
sys.path.insert(0,sys.argv[1])
import cc_performance_geometry as geometry
f=getattr(geometry,'crest_point',None)
r={'available':f is not None}
if f:
 root=(-.12+.44*math.cos(math.radians(265)),.015,1.88+.49*math.sin(math.radians(265)))
 point=(root[0],root[1],root[2]+1)
 neutral=f(point,root,0);p=f(point,root,.18);q=f(point,root,-.18)
 eps=1e-5;columns=[]
 for axis in range(3):
  moved=list(point);moved[axis]+=eps
  columns.append([(b-a)/eps for a,b in zip(p,f(moved,root,.18))])
 a,b,c=columns
 det=a[0]*(b[1]*c[2]-b[2]*c[1])-b[0]*(a[1]*c[2]-a[2]*c[1])+c[0]*(a[1]*b[2]-a[2]*b[1])
 rejected=[]
 for tilt in [.801,-.421,float('nan'),float('inf')]:
  try:f(point,root,tilt);rejected.append(False)
  except ValueError:rejected.append(True)
 r.update(neutral=neutral,point=point,rootFixed=all(math.dist(f(root,root,t),root)<1e-12 for t in [-.18,0,.18]),left=p,right=q,root=root,distance=math.dist(p,root),det=det,rejected=rejected,repeat=f(point,root,.18)==p)
print(json.dumps(r))
`,fileURLToPath(new URL('.',file))],{encoding:'utf8'}))
  expect(result.available,'a root-preserving C transform exists').toBe(true)
  expect(result.neutral).toEqual(result.point)
  expect(result.rootFixed).toBe(true)
  expect(result.left[1]).toBe(result.root[1]);expect(result.right[1]).toBe(result.root[1])
  expect(result.left[0]-result.root[0]).toBeGreaterThan(.17)
  expect(result.right[0]-result.root[0]).toBeLessThan(-.17)
  expect(result.distance).toBeCloseTo(1,10);expect(result.det).toBeCloseTo(1,5)
  expect(result.repeat).toBe(true);expect(result.rejected).toEqual([true,true,true,true])
})

it('supports the visibly larger curl sweep without moving its root or stretching its volume',()=>{
  const file=new URL('./cc_performance_geometry.py',import.meta.url)
  const result=JSON.parse(execFileSync(process.platform==='win32'?'python':'python3',['-c',`
import json,sys,math
sys.path.insert(0,sys.argv[1])
import cc_performance_geometry as geometry
f=getattr(geometry,'crest_point',None);r={'maximumAccepted':False}
if f:
 root=(-.1583485268,.015,1.3918645979);point=(root[0],root[1],root[2]+1)
 try:
  p=f(point,root,.42);q=f(point,root,-.42)
  r.update(maximumAccepted=True,rootFixed=all(math.dist(f(root,root,t),root)<1e-12 for t in [-.42,.42]),distance=math.dist(p,root),sweep=p[0]-q[0])
 except ValueError:pass
print(json.dumps(r))
`,fileURLToPath(new URL('.',file))],{encoding:'utf8'}))
  expect(result.maximumAccepted,'the approved larger curl sweep is supported').toBe(true)
  expect(result.rootFixed).toBe(true);expect(result.distance).toBeCloseTo(1,10)
  expect(result.sweep).toBeGreaterThan(.8)
})

it('allows a forward curl dip without extending the backward envelope or changing its root and volume',()=>{
  const file=new URL('./cc_performance_geometry.py',import.meta.url)
  const result=JSON.parse(execFileSync(process.platform==='win32'?'python':'python3',['-c',`
import json,sys,math
sys.path.insert(0,sys.argv[1])
import cc_performance_geometry as geometry
root=(-.1583485268,.015,1.3918645979);point=(root[0],root[1],root[2]+1)
r={'forwardAccepted':False}
try:
 p=geometry.crest_point(point,root,.8)
 r.update(forwardAccepted=True,rootFixed=math.dist(geometry.crest_point(root,root,.8),root)<1e-12,distance=math.dist(p,root),sweep=p[0]-root[0])
except ValueError:pass
print(json.dumps(r))
`,fileURLToPath(new URL('.',file))],{encoding:'utf8'}))
  expect(result.forwardAccepted,'a forward dip can supply a visible cause').toBe(true)
  expect(result.rootFixed).toBe(true);expect(result.distance).toBeCloseTo(1,10)
  expect(result.sweep).toBeGreaterThan(.7)
})
