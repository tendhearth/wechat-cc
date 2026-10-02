import { describe, it, expect } from 'vitest'
import { reflowLicence } from './licences'

describe('reflowLicence', () => {
  it('段内硬折行接成空格;空行、分隔线、编号条款保留换行', () => {
    expect(reflowLicence('This license is copied below, and is also available with a\nFAQ at:\nhttp://x\n\n-----\nPREAMBLE\nThe goals\nof it.\n1) Neither\n2) Original'))
      .toBe('This license is copied below, and is also available with a FAQ at: http://x\n\n-----\nPREAMBLE\nThe goals of it.\n1) Neither\n2) Original')
  })
})
