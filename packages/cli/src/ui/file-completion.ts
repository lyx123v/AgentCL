// @x-code-cli/cli — `@` 文件补全菜单的纯函数实现。
//
// 这里刻意保持无状态、无副作用，这样可以在没有终端环境的情况下直接做单测：
//
//   1. detectAtToken：给定输入文本和光标位置，判断用户是否正在编辑一个
//      `@...` token，如果是，就返回它的范围。触发规则是：
//      `@` 位于行首，或前面紧挨着空白字符。
//      这个规则要和 core 里的 extractFileReferences（file-ingest.ts）保持一致，
//      因为 UI 绝不能推荐一个后端最后又拒绝 ingest 的路径，否则用户会看到
//      文件被建议出来，却最终没有被真正接收。
//
//   2. scoreAndRank：对扁平的文件/目录列表做模糊排序，综合考虑 basename
//      和完整路径的权重，以及点文件门控（只有当查询本身以 `.` 开头时，
//      才显示隐藏文件）。
//
//   3. applyCompletion：把用户选中的条目拼回输入缓冲区，替换整个 @ token
//     （atIdx..tokenEnd）。这样用户即使在半个补全项后继续输入，也不会
//      把尾巴重复拼接两次。

export interface AtTrigger {
  /** True when the cursor sits inside an @-token whose '@' is at line
   *  start or preceded by whitespace. */
  active: boolean
  /** `@` 自身的位置。只有 active=true 时才有意义。 */
  atIdx: number
  /** `@` 和光标之间的子串，会传给 scoreAndRank 做匹配。 */
  query: string
  /** token 的右边界（光标后第一个空白字符，或 text.length）。
   *  applyCompletion 会替换 text.slice(atIdx, tokenEnd)。 */
  tokenEnd: number
}

const INACTIVE: AtTrigger = { active: false, atIdx: -1, query: '', tokenEnd: -1 }

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
}

export function detectAtToken(text: string, cursor: number): AtTrigger {
  if (cursor < 0 || cursor > text.length) return INACTIVE
  // 从光标向左回扫；如果在遇到 `@` 之前先碰到空白，说明不在 token 里。
  let i = cursor - 1
  while (i >= 0) {
    const ch = text[i] ?? ''
    if (ch === '@') break
    if (isWhitespace(ch)) return INACTIVE
    i--
  }
  if (i < 0 || text[i] !== '@') return INACTIVE
  const atIdx = i
  // 这里要和 file-ingest.ts 的前缀规则一致，避免把 `user@host`、
  // `npm install foo@1.2` 这种普通文本误判成文件引用。
  if (atIdx > 0 && !isWhitespace(text[atIdx - 1] ?? '')) return INACTIVE
  // 右边界：向前扫描到第一个空白字符。
  let j = cursor
  while (j < text.length && !isWhitespace(text[j] ?? '')) j++
  return {
    active: true,
    atIdx,
    query: text.slice(atIdx + 1, cursor),
    tokenEnd: j,
  }
}

export interface FileEntry {
  /** 相对 cwd 的 POSIX 风格路径。 */
  relPath: string
  isDirectory: boolean
}

export interface ScoredEntry extends FileEntry {
  score: number
}

function isHidden(relPath: string): boolean {
  const slash = relPath.lastIndexOf('/')
  const basename = slash >= 0 ? relPath.slice(slash + 1) : relPath
  return basename.startsWith('.')
}

/** 子序列匹配，连续命中会加分。未命中返回 -Infinity。
 *  命中位置越靠前，分数越高（有上限）。 */
function fuzzyScore(target: string, query: string): number {
  if (query.length === 0) return 0
  const t = target.toLowerCase()
  const q = query.toLowerCase()
  let ti = 0
  let qi = 0
  let score = 0
  let consecutive = 0
  let firstMatchIdx = -1
  while (ti < t.length && qi < q.length) {
    if (t[ti] === q[qi]) {
      if (firstMatchIdx === -1) firstMatchIdx = ti
      consecutive++
      score += 1 + consecutive
      qi++
    } else {
      consecutive = 0
    }
    ti++
  }
  if (qi < q.length) return -Infinity
  score += Math.max(0, 10 - firstMatchIdx)
  return score
}

function scoreEntry(entry: FileEntry, query: string): number {
  if (query.length === 0) {
    // 空查询：优先浅层路径；字母顺序的平局处理交给外层排序。
    const depth = entry.relPath.split('/').length
    return -depth
  }
  const slash = entry.relPath.lastIndexOf('/')
  const basename = slash >= 0 ? entry.relPath.slice(slash + 1) : entry.relPath
  // basename 命中权重更高，这样查询 `chat` 时，ChatInput.tsx 会排在
  // 深层的 `src/foo/chatter/util.ts` 前面。
  const baseScore = fuzzyScore(basename, query)
  if (baseScore !== -Infinity) return baseScore * 10
  return fuzzyScore(entry.relPath, query)
}

export function scoreAndRank(entries: FileEntry[], query: string): ScoredEntry[] {
  const showHidden = query.startsWith('.')
  const out: ScoredEntry[] = []
  for (const e of entries) {
    if (!showHidden && isHidden(e.relPath)) continue
    const score = scoreEntry(e, query)
    if (score === -Infinity) continue
    out.push({ ...e, score })
  }
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.relPath.localeCompare(b.relPath)
  })
  return out
}

/** 把选中的条目拼回输入缓冲区，并替换掉完整的 @ token。
 *  目录会带上尾部 `/`，方便用户继续输入子路径；文件则不加斜杠，
 *  光标停在路径末尾，用户可以继续写提示词。 */
export function applyCompletion(
  text: string,
  atIdx: number,
  tokenEnd: number,
  picked: { relPath: string; isDirectory: boolean },
): { text: string; cursor: number } {
  const insert = '@' + picked.relPath + (picked.isDirectory ? '/' : '')
  const before = text.slice(0, atIdx)
  const after = text.slice(tokenEnd)
  return {
    text: before + insert + after,
    cursor: atIdx + insert.length,
  }
}
