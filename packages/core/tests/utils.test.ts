// tools/utils.ts 的回归测试
//
// 背景：之前的实现会在 ESM 模块里直接调用 `require('@vscode/ripgrep')`。
// 运行时这会抛出 `ReferenceError: require is not defined`，随后进入 catch，
// 并静默回退到 `'rg'`。如果机器上没有全局安装 ripgrep，就会在执行时得到
// `spawn rg ENOENT`。现在 `tools/utils.ts` 改用 `createRequire(import.meta.url)`，
// 因此 require 调用本身应当能够正常工作。
import { describe, expect, it } from 'vitest'

import fs from 'node:fs'

import { getRipgrepPath } from '../src/tools/utils.js'

describe('getRipgrepPath', () => {
  it('会解析到 @vscode/ripgrep 的预编译二进制，而不是字面量 "rg"', () => {
    const p = getRipgrepPath()
    // @vscode/ripgrep 的意义就在于它自带各平台预编译二进制，
    // 因此这里解析出的必须是绝对路径，而不能是无修饰的 `'rg'` 回退值。
    // `'rg'` 只应该在 require 自身失败时才出现，而那正是之前 ESM/CJS
    // 不匹配导致的问题。
    expect(p).not.toBe('rg')
    expect(p.length).toBeGreaterThan(2)
  })

  it('指向的二进制文件必须真实存在于磁盘上', () => {
    const p = getRipgrepPath()
    // 如果解析路径不存在，glob/grep 首次调用时就会把 `spawn ... ENOENT`
    // 暴露给模型。这个测试就是金丝雀：它既能抓住 ESM/CJS 回归
    // （require 失败并静默回退），也能抓住 @vscode/ripgrep 安装损坏
    // （require 成功，但 postinstall 没有把二进制落盘）。
    expect(fs.existsSync(p)).toBe(true)
  })

  it('会在多次调用之间缓存已解析的路径', () => {
    const a = getRipgrepPath()
    const b = getRipgrepPath()
    expect(a).toBe(b)
  })
})
