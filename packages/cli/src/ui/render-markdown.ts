// @x-code-cli/cli - Markdown 到 ANSI 的渲染器（基于 token）。
//
// 这是 Claude Code 的 formatToken()（src/utils/markdown.ts）的一份移植版，
// 但改成了直接写 stdout 的方式，不再经过 React / Ink 外壳。它使用
// marked.lexer() 把 Markdown 解析成 AST，然后递归地把每个 token 渲染成
// 带 ANSI 样式的文本。
//
// 视觉风格尽量对齐 Claude Code：h1 使用 bold+italic+underline（不额外加
// 强调色），h2/h3 及更低级标题使用 bold，blockquote 用 U+258E ▎ 作为
// 变暗的前缀条并配合斜体文本，代码块直接输出原始文本且不缩进，行内代码
// 统一染成品牌蓝紫色，列表 bullet 使用 `-`（嵌套有序列表则切换成字母 /
// 罗马数字），链接则输出 OSC 8 超链接。
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Chalk } from 'chalk'
import { type Token, type Tokens, marked } from 'marked'

import { detectFenceLanguage, highlightLine } from './syntax-highlight.js'
import { GLYPH_BLOCKQUOTE_BAR, GLYPH_LIST_BULLET } from './terminal-glyphs.js'
import { visualWidth } from './text-width.js'
import { BLUE_PURPLE, SPINNER_BLUE as LINK } from './theme.js'

const c = new Chalk({ level: 3 })

const EOL = '\n'

const BLOCKQUOTE_BAR = GLYPH_BLOCKQUOTE_BAR

// 行内代码的着色 - 对齐 Claude Code 的 `permission` 颜色
// （rgb(177,185,249)）。
const CODE_INLINE = BLUE_PURPLE

let markedConfigured = false
function configureMarked(): void {
  if (markedConfigured) return
  markedConfigured = true
  // 禁用删除线：模型经常把 ~N 写成“约 N”的意思，几乎不会真想表达
  // strikethrough。这里和 Claude Code 保持一致。
  marked.use({
    tokenizer: {
      del() {
        return undefined as any
      },
    },
  })
}

// 快速路径：如果文本里没有 Markdown 标记，就跳过完整 lexer。
// 这能覆盖短句式的普通助手回复，也就是最常见的情况。
const MD_SYNTAX_RE = /[#*`|[>_~\-]|\n\n|^\d+\. |\n\d+\. /
function hasMarkdownSyntax(s: string): boolean {
  return MD_SYNTAX_RE.test(s.length > 500 ? s.slice(0, 500) : s)
}

// 去掉 CSI escape（`\x1B[…m` 等），这样在彩色文本上计算视觉宽度时
// 才不会被 ANSI 控制序列干扰。
const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]/g
function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, '')
}

function numberToLetter(n: number): string {
  let result = ''
  while (n > 0) {
    n--
    result = String.fromCharCode(97 + (n % 26)) + result
    n = Math.floor(n / 26)
  }
  return result
}

const ROMAN_VALUES: ReadonlyArray<[number, string]> = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
]

function numberToRoman(n: number): string {
  let result = ''
  for (const [value, numeral] of ROMAN_VALUES) {
    while (n >= value) {
      result += numeral
      n -= value
    }
  }
  return result
}

function getListNumber(listDepth: number, orderedListNumber: number): string {
  switch (listDepth) {
    case 0:
    case 1:
      return orderedListNumber.toString()
    case 2:
      return numberToLetter(orderedListNumber)
    case 3:
      return numberToRoman(orderedListNumber)
    default:
      return orderedListNumber.toString()
  }
}

function padAligned(
  content: string,
  displayWidth: number,
  targetWidth: number,
  align: 'left' | 'center' | 'right' | null | undefined,
): string {
  const padding = Math.max(0, targetWidth - displayWidth)
  if (align === 'center') {
    const leftPad = Math.floor(padding / 2)
    return ' '.repeat(leftPad) + content + ' '.repeat(padding - leftPad)
  }
  if (align === 'right') {
    return ' '.repeat(padding) + content
  }
  return content + ' '.repeat(padding)
}

// 表格布局直接调用 text-width.js 里的 `visualWidth`，让它和 chat-input
// 框架、scrollback diff 共用同一份“宽字符”真相来源。否则像 `运算`
// 这种标题在不同渲染器里的宽度判断只要有一点不一致，表格右边框就会
// 在后续每一行里逐步向左漂移。

function formatToken(
  token: Token,
  listDepth: number = 0,
  orderedListNumber: number | null = null,
  parent: Token | null = null,
): string {
  switch (token.type) {
    case 'blockquote': {
      const inner = (token.tokens ?? []).map((t) => formatToken(t, 0, null, null)).join('')
      const bar = c.dim(BLOCKQUOTE_BAR)
      return inner
        .split(EOL)
        .map((line) => (stripAnsi(line).trim() ? `${bar} ${c.italic(line)}` : line))
        .join(EOL)
    }

    case 'code': {
      const code = token as Tokens.Code
      const text = code.text ?? ''
      // 把 fenced code block 的语言提示（` ```typescript`、` ```bash`
      // 等）映射到我们支持的 tokenizer。未知 / 缺失的语言会回退到纯
      // 文本 - 这和之前的行为一致，只是不再把它当成“无条件默认”了。
      const lang = detectFenceLanguage(code.lang)
      if (!lang) return text + EOL
      // 按行高亮，这样 `text` 里的嵌入换行不会被当成源码内容喂给
      // tokenizer（这些正则本来就是按行设计的）。
      const highlighted = text
        .split('\n')
        .map((line) => highlightLine(line, lang))
        .join('\n')
      return highlighted + EOL
    }

    case 'codespan':
      return c.hex(CODE_INLINE)((token as Tokens.Codespan).text ?? '')

    case 'em':
      return c.italic((token.tokens ?? []).map((t) => formatToken(t, 0, null, parent)).join(''))

    case 'strong':
      return c.bold((token.tokens ?? []).map((t) => formatToken(t, 0, null, parent)).join(''))

    case 'heading': {
      const h = token as Tokens.Heading
      const content = (h.tokens ?? []).map((t) => formatToken(t, 0, null, null)).join('')
      // 标题后面一定要输出一个空行。marked 从来不会在标题和下一块
      // 之间产出 `space` token - 即使源文本是 `# H\n\nbody`，那个空行
      // 也会被折进标题自己的 `raw` 里。没有这个额外的 EOL，`# H\nbody`
      // 就会被渲染成两行紧挨着的文本，没有任何分隔。这里和 Claude Code
      // 保持一致。
      if (h.depth === 1) {
        return c.bold.italic.underline(content) + EOL + EOL
      }
      return c.bold(content) + EOL + EOL
    }

    case 'hr':
      // `---` 自己也需要终止符 - 之前少了它会让 `hr` 不输出换行，
      // 于是下一块内容就直接落到了分割线同一行上。
      return c.hex('#999999')('\u2500'.repeat(20)) + EOL

    case 'image':
      return (token as Tokens.Image).href ?? ''

    case 'link': {
      const l = token as Tokens.Link
      if (l.href?.startsWith('mailto:')) {
        return l.href.replace(/^mailto:/, '')
      }
      const linkText = (l.tokens ?? []).map((t) => formatToken(t, 0, null, l as Token)).join('')
      const href = l.href ?? ''
      const plain = stripAnsi(linkText)
      const styled = c.hex(LINK).underline(plain && plain !== href ? linkText : href)
      // OSC 8 超链接：现代终端会把显示文本渲染成可点击链接，鼠标悬停 /
      // Ctrl+click 时可以看到 `href`。不支持 OSC 8 的旧终端会把 escape
      // 字节直接剥掉，只剩下带下划线的显示文本 - 两边都能优雅降级。
      // 如果把原始 URL 也直接塞进正文里，web-fetch 结果就会变成
      // `text (url)text (url)...` 这种很乱的输出。
      return href ? `\x1b]8;;${href}\x1b\\${styled}\x1b]8;;\x1b\\` : styled
    }

    case 'list': {
      const list = token as Tokens.List
      return list.items
        .map((item, index) =>
          formatToken(item as Token, listDepth, list.ordered ? Number(list.start ?? 1) + index : null, list as Token),
        )
        .join('')
    }

    case 'list_item':
      return (token.tokens ?? [])
        .map((t) => `${'  '.repeat(listDepth)}${formatToken(t, listDepth + 1, orderedListNumber, token)}`)
        .join('')

    case 'paragraph':
      return (token.tokens ?? []).map((t) => formatToken(t, 0, null, null)).join('') + EOL

    case 'space':
      return EOL

    case 'br':
      return EOL

    case 'text': {
      const tx = token as Tokens.Text
      if (parent?.type === 'link') {
        // 已经在链接内部了 - 不要再二次包裹；link 分支已经发过 OSC 8
        // 序列了。
        return tx.text
      }
      if (parent?.type === 'list_item') {
        // 用一个视觉上更明确的 bullet，让渲染结果不会和原始 Markdown
        // 源码混淆。无序列表会得到带颜色的 U+2022 •；有序列表保留
        // "N."，但数字会加亮。Claude Code 也是这么做的 - 只要 marker
        // 变成了 unicode，用户一眼就能知道 marked.lexer 真的把列表解析
        // 出来了，不会再看到渲染前后都只是 `-` 然后误以为没变化。
        const marker =
          orderedListNumber === null
            ? c.hex(BLUE_PURPLE)(GLYPH_LIST_BULLET)
            : c.hex(BLUE_PURPLE)(`${getListNumber(listDepth, orderedListNumber)}.`)
        const content = tx.tokens
          ? tx.tokens.map((t) => formatToken(t, listDepth, orderedListNumber, token)).join('')
          : tx.text
        return `${marker} ${content}${EOL}`
      }
      return tx.text
    }

    case 'table': {
      const tb = token as Tokens.Table

      const displayWidthOf = (tokens?: Token[]): number =>
        visualWidth(stripAnsi((tokens ?? []).map((t) => formatToken(t, 0, null, null)).join('')))

      const colWidths = tb.header.map((header, index) => {
        let max = displayWidthOf(header.tokens)
        for (const row of tb.rows) {
          max = Math.max(max, displayWidthOf(row[index]?.tokens))
        }
        return Math.max(max, 3)
      })

      // 使用 box-drawing 字符，渲染成真正的 CLI 表格，而不是把 Markdown
      // 里的管道符原样回显给用户。
      const TL = '\u250c',
        TR = '\u2510',
        TM = '\u252c'
      const BL = '\u2514',
        BR = '\u2518',
        BM = '\u2534'
      const ML = '\u251c',
        MR = '\u2524',
        MM = '\u253c'
      const H = '\u2500',
        V = '\u2502'

      const makeDivider = (left: string, mid: string, right: string): string =>
        left + colWidths.map((w) => H.repeat(w + 2)).join(mid) + right + EOL

      const padCell = (
        cell: { tokens?: Token[] },
        width: number,
        align: 'left' | 'center' | 'right' | null | undefined,
      ): string => {
        const content = (cell.tokens ?? []).map((t) => formatToken(t, 0, null, null)).join('')
        const displayWidth = displayWidthOf(cell.tokens)
        return padAligned(content, displayWidth, width, align)
      }

      const dim = (s: string) => c.hex('#999999')(s)
      let out = dim(makeDivider(TL, TM, TR))

      out += dim(V) + ' '
      tb.header.forEach((header, index) => {
        if (index > 0) out += ' ' + dim(V) + ' '
        out += c.bold(padCell(header, colWidths[index]!, tb.align?.[index]))
      })
      out += ' ' + dim(V) + EOL

      out += dim(makeDivider(ML, MM, MR))

      tb.rows.forEach((row) => {
        out += dim(V) + ' '
        row.forEach((cell, index) => {
          if (index > 0) out += ' ' + dim(V) + ' '
          out += padCell(cell, colWidths[index]!, tb.align?.[index])
        })
        out += ' ' + dim(V) + EOL
      })

      out += dim(makeDivider(BL, BM, BR))
      // `out` 在最后一个分隔线后面已经自带 EOL 了 - 如果再返回
      // `out + EOL`，就会多出一条空白行，而旁边的 `space` token 又会
      // 把它再放大一遍。
      return out
    }

    case 'escape':
      return (token as Tokens.Escape).text ?? ''

    case 'def':
    case 'del':
    case 'html':
      return ''
  }
  return ''
}

/**
 * 轻量级的仅行内 Markdown -> ANSI 处理。
 *
 * 只处理 **bold**、*italic* 和 `code`，不处理任何块级语法。
 * 返回值是包含 ANSI escape 序列的字符串，适合交给 ansiTextToCells()
 * 继续处理。
 */
export function renderInlineMarkdown(text: string): string {
  if (!text) return ''

  return (
    text
      // 加粗：**text** 或 __text__
      .replace(/(\*\*|__)(.+?)\1/g, (_m, _d, inner) => c.bold(inner as string))
      // 斜体：*text* 或 _text_（但 `_` 不允许出现在单词内部）
      .replace(/(?<!\w)(\*|_)(?!\s)(.+?)(?<!\s)\1(?!\w)/g, (_m, _d, inner) => c.italic(inner as string))
      // 行内代码：`code`
      .replace(/`([^`]+)`/g, (_m, inner) => c.hex(CODE_INLINE)(inner as string))
  )
}

/**
 * 把 Markdown 字符串转换为带 ANSI 样式的终端文本。
 *
 * 会保留 token formatter 产出的尾随换行 - 调用方（stdout-writer）
 * 依赖这些换行来判断 streaming chunk 的边界。
 */
export function renderMarkdown(text: string): string {
  if (!text) return ''

  configureMarked()

  try {
    // 快速路径 - 普通纯文本就直接当作单段落处理。
    if (!hasMarkdownSyntax(text)) {
      return text + EOL
    }
    const tokens = marked.lexer(text) as Token[]
    return tokens.map((t) => formatToken(t, 0, null, null)).join('')
  } catch {
    // 流式输出过程中 Markdown 可能是半截的 / 非法的 - 这里回退到原文，
    // 至少保证用户还能看到内容。
    return text
  }
}
