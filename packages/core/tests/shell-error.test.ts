// utils/shell-error.ts 测试
import { describe, expect, it } from 'vitest'

import { foldShellErrorNoise } from '../src/utils/shell-error.js'

const PS_ERROR_SAMPLE = `At line:1 char:24
+ "powershell -Command \\"cd 'd:\\isoform\\something'; git status\\""
+                        ~~
The string is missing the terminator: ".
    + CategoryInfo          : ParserError: (:) [], ParseException
    + FullyQualifiedErrorId : TerminatorExpectedAtEndOfString`

describe('foldShellErrorNoise', () => {
  it('会把完整的 PowerShell 错误块折叠成单行摘要', () => {
    const out = foldShellErrorNoise(PS_ERROR_SAMPLE)
    const lines = out.split('\n').filter((l) => l.trim())
    expect(lines.length).toBeLessThanOrEqual(2)
    expect(out).toContain('At line:1 char:24')
    expect(out).toContain('PS parse error')
    expect(out).not.toContain('CategoryInfo')
    expect(out).not.toContain('FullyQualifiedErrorId')
  })

  it('会折叠多个连续出现的错误块', () => {
    const input = `${PS_ERROR_SAMPLE}\n${PS_ERROR_SAMPLE}`
    const out = foldShellErrorNoise(input)
    const atLineCount = (out.match(/At line:/g) ?? []).length
    expect(atLineCount).toBe(2)
    expect(out).not.toContain('CategoryInfo')
  })

  it('在错误块之间穿插普通文本时，会保留普通文本', () => {
    const input = `before marker\n${PS_ERROR_SAMPLE}\nafter marker`
    const out = foldShellErrorNoise(input)
    expect(out).toContain('before marker')
    expect(out).toContain('after marker')
    expect(out).toContain('At line:')
    expect(out).not.toContain('CategoryInfo')
  })
})
