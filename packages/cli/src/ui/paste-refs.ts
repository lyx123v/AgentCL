// @x-code-cli/cli — 粘贴引用辅助工具。
//
// 大段粘贴内容不会直接展开显示在输入框里。我们会把完整文本存进
// 一个映射表里，只在输入框中保留类似 `[Pasted text #2 +217 lines]`
// 的占位符。用户按 Enter 提交时，再把占位符还原成原始内容后交给
// agent。这个交互方式参考了 Claude Code 的 PromptInput。

export interface PastedEntry {
  id: number
  content: string
  lineCount: number
}

export type PastedContents = Record<number, PastedEntry>

/** 用于在字符串任意位置查找粘贴引用的正则表达式。提交时会用到。 */
const REF_ANY_RE = /\[Pasted text #(\d+)(?: \+\d+ lines)?\]/g

/** 用于判断字符串末尾是否是粘贴引用。退格删除时会用到。 */
const REF_TAIL_RE = /\[Pasted text #(\d+)(?: \+\d+ lines)?\]$/

export function formatPasteRef(id: number, lineCount: number): string {
  if (lineCount <= 1) return `[Pasted text #${id}]`
  return `[Pasted text #${id} +${lineCount} lines]`
}

/**
 * 把 `text` 里的每个 `[Pasted text #N …]` 引用替换成 `contents` 中
 * 保存的真实内容。若某个 id 找不到，就保留原样，避免误删用户输入。
 */
export function expandPasteRefs(text: string, contents: PastedContents): string {
  return text.replace(REF_ANY_RE, (match, idStr: string) => {
    const id = Number(idStr)
    const entry = contents[id]
    return entry ? entry.content : match
  })
}

/**
 * 如果 `text` 以粘贴引用占位符结尾，就返回：
 * 1. 去掉该引用后的文本
 * 2. 被删掉的引用 id
 *
 * 这样调用方就能顺手把对应的内容从粘贴映射里移除。否则返回 null，
 * 调用方再退回到“删除一个字符”的普通退格逻辑。
 */
export function stripTrailingRef(text: string): { without: string; id: number } | null {
  const m = text.match(REF_TAIL_RE)
  if (!m) return null
  return {
    without: text.slice(0, text.length - m[0].length),
    id: Number(m[1]),
  }
}
