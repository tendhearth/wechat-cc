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
