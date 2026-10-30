import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const python = process.platform === 'win32' ? 'python' : 'python3'
const probe = () => JSON.parse(execFileSync(python, ['-c', `
import json,sys
sys.path.insert(0,sys.argv[1])
from cc_motion_geometry import morph_eye,eye_width
epsilon=1e-6
determinants=[]
for amount in [0,.2,.525364,.58299,.628,.781,1]:
 for x in [-.061,0,.061]:
  for z in [-.136,0,.136]:
   p=morph_eye(x,z,amount)
   a=morph_eye(x+epsilon,z,amount)
   b=morph_eye(x,z+epsilon,amount)
   determinants.append(((a[0]-p[0])*(b[1]-p[1])-(b[0]-p[0])*(a[1]-p[1]))/(epsilon*epsilon))
print(json.dumps({'determinants':determinants,'rest':morph_eye(.02,.1,0),'widths':[eye_width(.2-epsilon),eye_width(.2+epsilon)]}))
`, resolve(__dirname)], { encoding: 'utf8' }))

describe('continuous eye geometry', () => {
  it('never collapses, folds or reverses the eye surface while becoming a crescent', () => {
    const result = probe()
    expect(result.rest).toEqual([0.02, 0.1])
    expect(Math.min(...result.determinants)).toBeGreaterThan(0.3)
  })

  it('changes squint width continuously when the eye crosses twenty percent height', () => {
    const result = probe()
    expect(Math.abs(result.widths[0] - result.widths[1])).toBeLessThan(0.0001)
  })
})
