import { describe, expect, it } from 'vitest'

import { type FileEntry, applyCompletion, detectAtToken, scoreAndRank } from '../src/ui/file-completion.js'

describe('detectAtToken', () => {
  it('当行首只有一个裸露的 @ 时，应立即激活补全', () => {
    const t = detectAtToken('@', 1)
    expect(t.active).toBe(true)
    expect(t.atIdx).toBe(0)
    expect(t.query).toBe('')
    expect(t.tokenEnd).toBe(1)
  })

  it('应提取光标前正在输入的查询内容', () => {
    const t = detectAtToken('hello @ch', 9)
    expect(t.active).toBe(true)
    expect(t.atIdx).toBe(6)
    expect(t.query).toBe('ch')
    expect(t.tokenEnd).toBe(9)
  })

  it('应拒绝识别嵌在单词中的 @（例如 user@host）', () => {
    const t = detectAtToken('user@host', 9)
    expect(t.active).toBe(false)
  })

  it('应拒绝 npm 风格的版本标记（foo@1.2）', () => {
    // 光标位于 "npm install foo@1.2" 的结尾
    const t = detectAtToken('npm install foo@1.2', 19)
    expect(t.active).toBe(false)
  })

  it('当光标已经越过下一个空白字符时，应视为未激活', () => {
    const t = detectAtToken('@foo bar', 8)
    expect(t.active).toBe(false)
  })

  it('当光标紧跟在空格后面时，应视为未激活', () => {
    const t = detectAtToken('@foo ', 5)
    expect(t.active).toBe(false)
  })

  it('当光标位于 token 中间时，也应正确提取查询内容', () => {
    // "@foo|bar"：光标在 4，完整 token "@foobar" 会延伸到 7
    const t = detectAtToken('@foobar', 4)
    expect(t.active).toBe(true)
    expect(t.atIdx).toBe(0)
    expect(t.query).toBe('foo')
    expect(t.tokenEnd).toBe(7)
  })

  it('应把制表符和换行视为合法的空白边界', () => {
    expect(detectAtToken('a\t@x', 4).active).toBe(true)
    expect(detectAtToken('a\n@x', 4).active).toBe(true)
  })

  it('应拒绝超出范围的光标位置', () => {
    expect(detectAtToken('hello', -1).active).toBe(false)
    expect(detectAtToken('hello', 99).active).toBe(false)
  })

  it('应处理前面有文本、末尾仅剩裸露 @ 的情况', () => {
    const t = detectAtToken('hello @', 7)
    expect(t.active).toBe(true)
    expect(t.atIdx).toBe(6)
    expect(t.query).toBe('')
    expect(t.tokenEnd).toBe(7)
  })
})

describe('scoreAndRank', () => {
  // 简化测试数据构造，避免重复书写对象字面量。
  const E = (relPath: string, isDirectory = false): FileEntry => ({ relPath, isDirectory })

  it('应让文件名本体命中的结果排在嵌套路径命中之前', () => {
    const entries = [E('src/foo/chatter/util.ts'), E('packages/cli/src/ui/components/ChatInput.tsx')]
    const ranked = scoreAndRank(entries, 'chat')
    expect(ranked[0]?.relPath).toBe('packages/cli/src/ui/components/ChatInput.tsx')
  })

  it('当查询不是以点开头时，应隐藏点文件', () => {
    const entries = [E('.gitignore'), E('readme.md')]
    const ranked = scoreAndRank(entries, 'r')
    expect(ranked.find((r) => r.relPath === '.gitignore')).toBeUndefined()
    expect(ranked.find((r) => r.relPath === 'readme.md')).toBeDefined()
  })

  it('当查询以点开头时，应显示点文件', () => {
    const entries = [E('.gitignore'), E('readme.md')]
    const ranked = scoreAndRank(entries, '.gi')
    expect(ranked[0]?.relPath).toBe('.gitignore')
  })

  it('当查询为空时，应优先返回更浅层的路径', () => {
    const entries = [E('a/b/c/deep.ts'), E('top.ts'), E('a/mid.ts')]
    const ranked = scoreAndRank(entries, '')
    expect(ranked[0]?.relPath).toBe('top.ts')
    expect(ranked[1]?.relPath).toBe('a/mid.ts')
    expect(ranked[2]?.relPath).toBe('a/b/c/deep.ts')
  })

  it('应丢弃未通过子序列匹配的条目', () => {
    const entries = [E('foo.ts'), E('bar.ts')]
    const ranked = scoreAndRank(entries, 'xyz')
    expect(ranked).toHaveLength(0)
  })

  it('应支持大小写不敏感匹配', () => {
    const ranked = scoreAndRank([E('ChatInput.tsx')], 'chat')
    expect(ranked).toHaveLength(1)
  })

  it('当分数相同时，应按字母顺序打破平局', () => {
    // 两个条目在空查询下拥有相同的 basename 分数，
    // 且目录深度都为 1，因此最终应按字母顺序排序。
    const ranked = scoreAndRank([E('zebra.ts'), E('apple.ts')], '')
    expect(ranked[0]?.relPath).toBe('apple.ts')
    expect(ranked[1]?.relPath).toBe('zebra.ts')
  })
})

describe('applyCompletion', () => {
  it('应使用选中的路径替换原来的 @ token', () => {
    const out = applyCompletion('hello @ch', 6, 9, {
      relPath: 'src/ui/ChatInput.tsx',
      isDirectory: false,
    })
    expect(out.text).toBe('hello @src/ui/ChatInput.tsx')
    expect(out.cursor).toBe(out.text.length)
  })

  it('目录补全结果应自动补上末尾斜杠', () => {
    const out = applyCompletion('@s', 0, 2, { relPath: 'src', isDirectory: true })
    expect(out.text).toBe('@src/')
    expect(out.cursor).toBe(5)
  })

  it('应保留 token 结束位置之后的文本', () => {
    const out = applyCompletion('look @ch then read it', 5, 8, {
      relPath: 'a.ts',
      isDirectory: false,
    })
    expect(out.text).toBe('look @a.ts then read it')
    expect(out.cursor).toBe(10)
  })
})
