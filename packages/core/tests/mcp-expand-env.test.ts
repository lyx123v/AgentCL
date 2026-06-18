import { describe, expect, it } from 'vitest'

import { EnvExpansionError, expandEnvDeep, expandEnvString } from '../src/mcp/expand-env.js'

describe('expandEnvString', () => {
  it('会替换简单引用', () => {
    expect(expandEnvString('你好 ${NAME}', { NAME: '世界' } as NodeJS.ProcessEnv)).toBe('你好 世界')
  })

  it('会在同一个字符串中替换多个引用', () => {
    expect(expandEnvString('${A}/${B}/${C}', { A: '1', B: '2', C: '3' } as NodeJS.ProcessEnv)).toBe('1/2/3')
  })

  it('缺少默认值且变量不存在时会抛出 EnvExpansionError', () => {
    expect(() => expandEnvString('${MISSING_VAR}', {} as NodeJS.ProcessEnv)).toThrow(EnvExpansionError)
  })

  it('变量缺失或为空时会使用 :- 默认值', () => {
    expect(expandEnvString('${X:-默认值}', {} as NodeJS.ProcessEnv)).toBe('默认值')
    expect(expandEnvString('${X:-默认值}', { X: '' } as NodeJS.ProcessEnv)).toBe('默认值')
    expect(expandEnvString('${X:-默认值}', { X: '真实值' } as NodeJS.ProcessEnv)).toBe('真实值')
  })

  it('不会改动不匹配的 $ 模式', () => {
    // 单独的 `$` 模式和未闭合的 `${` 都应原样保留，
    // 因为这里不支持 shell 风格的 `$VAR` 语法。
    expect(expandEnvString('cost: $5', {} as NodeJS.ProcessEnv)).toBe('cost: $5')
    expect(expandEnvString('${unfinished', {} as NodeJS.ProcessEnv)).toBe('${unfinished')
  })
})

describe('expandEnvDeep', () => {
  it('会递归处理数组和对象', () => {
    const input = {
      command: '${BIN}',
      args: ['--token', '${TOKEN}'],
      env: { LOG: '${LEVEL:-info}' },
      timeout: 30000,
    }
    const env = { BIN: 'node', TOKEN: 'abc' } as NodeJS.ProcessEnv
    const out = expandEnvDeep(input, env)
    expect(out).toEqual({
      command: 'node',
      args: ['--token', 'abc'],
      env: { LOG: 'info' },
      timeout: 30000,
    })
  })

  it('不会修改输入对象', () => {
    const input = { command: '${BIN}' }
    const env = { BIN: 'foo' } as NodeJS.ProcessEnv
    expandEnvDeep(input, env)
    expect(input.command).toBe('${BIN}')
  })

  it('会保留 null、boolean、number 等原始值', () => {
    expect(expandEnvDeep({ a: null, b: true, c: 5 } as Record<string, unknown>, {} as NodeJS.ProcessEnv)).toEqual({
      a: null,
      b: true,
      c: 5,
    })
  })
})
