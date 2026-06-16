// @x-code-cli/cli - 按行工作的语法高亮器，供 diff renderer 使用。
//
// 为什么要自研：我们看过的现成 Node 终端高亮库（cli-highlight、
// chalk-highlight 等）要么会引入 highlight.js（大约 600KB），要么
// 已经很多年没有更新了。这里的 diff 场景其实很窄 - 我们每次只需要
// 高亮大约 60 行、背景还是深色，而且只要识别常见 token 类别就够了。
// 用约 150 行正则，就能换来大约 80% 的视觉收益，但依赖体积只有
// 它的 0.1%。
//
// 按“行”处理：这个高亮器一次只吃一行 diff。代价是失去跨行状态
// （比如被 hunk 边界切开的块注释，不能一路延续到后面的上下文行），
// 但 Claude Code 的 StructuredDiff fallback 也是这样 - 每一行都只是
// 一个独立的 React node。对 diff 场景来说，这个限制在实践里几乎看不见：
// 一个 hunk 的 context window 只有 3 行，而且你很少会刚好碰到 `/* ... */`
// 精准跨过这几行的情况。
//
// 主题系统：一小组命名调色板（one-dark、monokai、dracula、github-dark、
// solarized-dark、ansi、off）。当前调色板保存在模块级引用里，启动时从
// `~/.x-code/config.json` 初始化，运行时则由 `/syntax <name>` 切换。
// 任何想使用当前调色板的渲染路径，都直接调用不带 theme 参数的
// `highlightLine` - 它会读取这个实时的模块级引用。测试和预览则可以
// 显式传入主题，绕开全局状态。
import { Chalk } from 'chalk'

const c = new Chalk({ level: 3 })

// ─── 主题 ───

/** 高亮器会产出的 token 类别。每个主题都会把这些类别映射成颜色。
 *
 *  `storage` 从 `keyword` 里单独拆出来，是为了对齐 CC / syntect 的
 *  约定：控制流关键字（`if`、`return`、`throw`）归到 `keyword`，
 *  而声明型关键字（`const`、`let`、`function`、`class`、`interface`）
 *  归到 `storage`。在 Monokai 里它们分别会显示成热粉和青色 - 如果不
 *  拆分，`function` 就会和 `if` 变成同一个颜色，这就不符合 CC 了。
 *  参考 CC color-diff/index.ts:248-265。 */
type Token = 'keyword' | 'storage' | 'type' | 'string' | 'number' | 'comment' | 'function' | 'literal'

/** 调色板：颜色值可以是 hex（`#rrggbb`）、ANSI 名称（比如 `'magenta'`），
 *  或者 `null`（表示“不要改前景色 - 直接用终端默认值”）。
 *  正是 `null` 让 `'off'` 主题能够在不单独分支的情况下，把 token 原样
 *  放过去。 */
type ColorSpec = string | null
type Palette = Record<Token, ColorSpec>

/** 内置语法主题。名字都是小写 kebab-case。`'off'` 是一个真实条目 -
 *  它会把所有颜色都设成 null，从而让每一次 paint() 调用都失效。
 *
 *  其中有两个调色板直接来源于 CC：`monokai`（CC 的 "Monokai Extended"，
 *  会随所有深色 `/theme` 模式一起提供）和 `github-light`
 *  （CC 的 "GitHub"，会随所有浅色 `/theme` 模式一起提供）。
 *  其余名字则早于 CC 对齐工作。 */
export type SyntaxThemeName =
  | 'one-dark'
  | 'monokai'
  | 'dracula'
  | 'github-dark'
  | 'github-light'
  | 'solarized-dark'
  | 'ansi'
  | 'off'

const THEMES: Record<SyntaxThemeName, Palette> = {
  // One Dark - Atom 的标志性主题。深色背景下对比度平稳、均衡，
  // 对大多数用户来说都是很稳妥的默认选择。
  'one-dark': {
    keyword: '#c678dd', // 紫色
    storage: '#c678dd', // 紫色 - One Dark 把 storage 和 keyword 放在一起
    type: '#e5c07b', // 砂黄色
    string: '#98c379', // 苔绿色
    number: '#d19a66', // 温暖的橙色
    comment: '#7f848e', // 冷调灰色
    function: '#61afef', // 浅蓝
    literal: '#d19a66', // 橙色（和 number 属于同一色系）
  },
  // Monokai - Sublime Text 的经典主题。饱和度高、非常有冲击力。
  // 这些值与 CC 的 MONOKAI_SCOPES（native-ts/color-diff/index.ts:190-215）
  // 完全一致，这样深色模式下的 diff 就能和 Claude Code 的
  // "Monokai Extended" syntect 主题渲染出同样的语法颜色。
  monokai: {
    keyword: '#f92672', // 热粉 - 控制流关键字（if/return/throw）
    storage: '#66d9ef', // 青色 - 声明型关键字（const/let/function/class）
    type: '#a6e22e', // 黄绿色 - 类型、内建对象
    string: '#e6db74', // 柔和黄
    number: '#be84ff', // 淡紫 - 数字 / 字面量（CC rgb 190,132,255）
    comment: '#75715e', // 棕灰
    function: '#a6e22e', // 黄绿色 - 函数 / 类名标题（CC 会和 types 放一起）
    literal: '#be84ff', // 淡紫
  },
  // Dracula - 很受欢迎的深色主题，走的是柔和的粉彩路线。
  dracula: {
    keyword: '#ff79c6', // 粉色
    storage: '#ff79c6', // 粉色 - Dracula 也把 storage 和 keyword 归一起
    type: '#8be9fd', // 青蓝
    string: '#f1fa8c', // 淡黄
    number: '#bd93f9', // 薰衣草紫
    comment: '#6272a4', // 蓝灰
    function: '#50fa7b', // 薄荷绿
    literal: '#bd93f9', // 薰衣草紫
  },
  // GitHub Dark - 对齐 GitHub.com 深色模式下的代码块。
  'github-dark': {
    keyword: '#ff7b72', // 鲑红
    storage: '#ff7b72', // 鲑红
    type: '#ffa657', // 橙色
    string: '#a5d6ff', // 浅蓝
    number: '#79c0ff', // 蓝色
    comment: '#8b949e', // 灰色
    function: '#d2a8ff', // 薰衣草紫
    literal: '#79c0ff', // 蓝色
  },
  // GitHub Light - 数值与 CC 的 GITHUB_SCOPES
  // （native-ts/color-diff/index.ts:218-243）逐字节一致。它是为浅色
  // 终端调的：颜色更深、更饱和，在白底上读起来更清楚。会随
  // light / light-daltonized /theme 模式一起提供。
  'github-light': {
    keyword: '#a71d5d', // 深洋红 - 控制流关键字
    storage: '#a71d5d', // 深洋红 - GitHub 也把 storage 和 keyword 放一起
    type: '#0086b3', // 青绿 - 类型、内建、数字、字面量
    string: '#183691', // 海军蓝 - 字符串
    number: '#0086b3', // 青绿
    comment: '#969896', // 中灰
    function: '#795da3', // 紫色 - 函数 / 类名标题
    literal: '#0086b3', // 青绿
  },
  // Solarized Dark - Ethan Schoonover 的经典低对比度主题，后来的很多
  // 主题都受它影响。
  'solarized-dark': {
    keyword: '#859900', // 苔绿
    storage: '#cb4b16', // 烧橙 - 用来区分声明
    type: '#b58900', // 金色
    string: '#2aa198', // 青绿
    number: '#d33682', // 品红
    comment: '#586e75', // 石板灰
    function: '#268bd2', // 蓝色
    literal: '#d33682', // 品红
  },
  // ANSI - 直接使用终端的 16 色调色板（Chalk 的命名颜色）。
  // 这种模式在任何地方都能看起来“合理”，哪怕是很简陋的终端；
  // 代价是牺牲一些色彩保真度来换兼容性。这里的值和 CC 的
  // `ANSI_SCOPES`（color-diff/index.ts:267-280）逐字节对齐：
  // 每一项都使用 `ansiIdx(N)`，其中 N 在 10-14 之间，也就是
  // BRIGHT 调色板那一半。我们之前用的是普通的 0-7 名称，
  // 这会让我们的 ANSI 模式看起来比 CC 明显更暗、饱和度更低。
  // 映射关系：
  //   keyword         = ansiIdx(13) = bright magenta
  //   _storage        = ansiIdx(14) = bright cyan
  //   built_in / type = ansiIdx(14) = bright cyan
  //   string          = ansiIdx(10) = bright green
  //   number / literal = ansiIdx(12) = bright blue
  //   title.function  = ansiIdx(11) = bright yellow
  //   comment         = ansiIdx(8)  = bright black（chalk 的 `gray`）
  ansi: {
    keyword: 'magentaBright',
    storage: 'cyanBright',
    type: 'cyanBright',
    string: 'greenBright',
    number: 'blueBright',
    comment: 'gray',
    function: 'yellowBright',
    literal: 'blueBright',
  },
  // Off - 每个 token 颜色都是 null，所以 paint() 会退化成恒等函数。
  // 这样热路径就不需要额外分支：规则循环照样跑（对 ~60 行输入来说
  // 代价很小），只是不会插入任何 escape code。
  off: {
    keyword: null,
    storage: null,
    type: null,
    string: null,
    number: null,
    comment: null,
    function: null,
    literal: null,
  },
}

/** 给 picker 用的展示文案。顺序是有意安排的 - 按常用程度排序，
 *  这样 picker 的第一行就是最常见的选择。 */
export const SYNTAX_THEME_DESCRIPTIONS: { name: SyntaxThemeName; label: string; description: string }[] = [
  { name: 'one-dark', label: 'One Dark', description: 'Atom signature — calm, balanced contrast (default)' },
  { name: 'monokai', label: 'Monokai', description: 'Sublime classic — punchy, high saturation' },
  { name: 'dracula', label: 'Dracula', description: 'Popular dark theme with pastel palette' },
  { name: 'github-dark', label: 'GitHub Dark', description: "Match GitHub's dark-mode code blocks" },
  { name: 'solarized-dark', label: 'Solarized Dark', description: 'Low-contrast, easy on the eyes' },
  { name: 'ansi', label: 'ANSI', description: 'Use the terminal 16-color palette — works everywhere' },
  { name: 'off', label: 'Off', description: 'Disable syntax highlighting entirely' },
]

export const DEFAULT_SYNTAX_THEME: SyntaxThemeName = 'one-dark'

/** 当前激活的主题 - 当 `highlightLine` 没有显式传入 theme 参数时会
 *  读取它。启动时（从用户配置）初始化为默认值，用户运行 `/syntax`
 *  时也会再次切换。 */
let currentTheme: SyntaxThemeName = DEFAULT_SYNTAX_THEME

export function setSyntaxTheme(name: SyntaxThemeName): void {
  currentTheme = name
}

export function getSyntaxTheme(): SyntaxThemeName {
  return currentTheme
}

/** 验证 / 规整任意字符串，把它转成 SyntaxThemeName。
 *  用在读取用户配置（它的类型是 `unknown`）以及解析 slash-command
 *  参数时。任何无法识别的值都会返回 null，方便调用方给出友好的错误。 */
export function parseSyntaxThemeName(input: unknown): SyntaxThemeName | null {
  if (typeof input !== 'string') return null
  const normalized = input
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
  // 常见别名映射 - 对应用户可能真的会输入的写法。
  const aliases: Record<string, SyntaxThemeName> = {
    onedark: 'one-dark',
    one: 'one-dark',
    atom: 'one-dark',
    mono: 'monokai',
    sublime: 'monokai',
    drac: 'dracula',
    gh: 'github-dark',
    github: 'github-dark',
    'gh-dark': 'github-dark',
    solarized: 'solarized-dark',
    sol: 'solarized-dark',
    sold: 'solarized-dark',
    none: 'off',
    disable: 'off',
    disabled: 'off',
    plain: 'off',
  }
  if (normalized in aliases) return aliases[normalized]!
  if (normalized in THEMES) return normalized as SyntaxThemeName
  return null
}

// ─── 语言检测 ───

/** 我们有专门 tokenizer 规则的语言。任何不在这个集合里的内容都会
 *  回退成纯文本（不高亮），但这仍然是合法渲染 - 只是没那么花哨。 */
type Lang = 'js' | 'json' | 'html' | 'css' | 'yaml' | 'shell' | 'python' | 'go' | 'rust' | 'md'

/** 一张统一的查找表，同时给文件扩展名（detectLanguage 用）和
 *  markdown fence 的语言标识（detectFenceLanguage 用）服务。
 *  键全部是小写。大多数条目在两种上下文里都有效（比如 `ts`、
 *  `py`、`rs`）；只对 fence 有意义的别名像 `typescript`、`python`、
 *  `golang`、`rust`、`javascript`、`shell`，在文件路径场景里自然
 *  匹配不到，因为扩展名不会长这样。只对扩展名有意义的条目像 `mts`
 *  / `cts`，在 fence 里也同样不会有实际匹配。 */
const LANG_LOOKUP: Record<string, Lang> = {
  // JS / TS 家族 - 共用同一个 tokenizer（TS 里的 `interface`、`type`、
  // `enum` 这些语法会被当成关键字；这个 tokenizer 故意做得宽松，
  // 因为在纯 JS 里出现一点误判，视觉上也不会太刺眼）。
  ts: 'js',
  tsx: 'js',
  typescript: 'js',
  js: 'js',
  jsx: 'js',
  javascript: 'js',
  mjs: 'js',
  cjs: 'js',
  mts: 'js',
  cts: 'js',
  vue: 'js', // Vue SFC 大多是 TS - 拿来做 diff 显示已经够接近了
  svelte: 'js',
  // 数据格式
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  // Web
  html: 'html',
  htm: 'html',
  xml: 'html',
  css: 'css',
  scss: 'css',
  sass: 'css',
  less: 'css',
  // 配置
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'yaml', // 用于 diff 着色已经足够接近（key=value、字符串、数字）
  // Shell
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  shell: 'shell',
  // 其他
  py: 'python',
  python: 'python',
  go: 'go',
  golang: 'go',
  rs: 'rust',
  rust: 'rust',
  md: 'md',
  markdown: 'md',
}

export function detectLanguage(filePath: string): Lang | null {
  const m = /\.([a-zA-Z0-9]+)$/.exec(filePath)
  if (!m) return null
  return LANG_LOOKUP[m[1]!.toLowerCase()] ?? null
}

/** 把 markdown fence 的语言标识（fenced code block 开头 ``` 后面的那段）
 *  映射成我们支持的 `Lang` 值。
 *  如果 fence 没写语言，或者这个语言我们不支持，就返回 null -
 *  调用方会回退到纯文本（不高亮）。 */
export function detectFenceLanguage(fenceLang: string | undefined): Lang | null {
  if (!fenceLang) return null
  return LANG_LOOKUP[fenceLang.trim().toLowerCase()] ?? null
}

// ─── Token 化 ───

interface Rule {
  re: RegExp
  token: Token
}

/** 根据规则集构造一个 sticky regex（带 `y` 标志，锚定在 lastIndex）。
 *  我们会在当前位置按顺序尝试每条规则，先匹配到的先赢。
 *  正则模式必须避免灾难性回溯 - 所以整体都尽量保持简单、可控、
 *  有上界。 */
function makeRules(rules: { re: RegExp; token: Token }[]): Rule[] {
  return rules.map(({ re, token }) => ({
    // 强制 sticky，这样下面的循环才能按位置一步一步扫描。
    // 原始 `re` 里可能已经带了 `y`；如果没有，就用相同 pattern
    // + sticky flag 重新构造一个。
    re: re.flags.includes('y') ? re : new RegExp(re.source, re.flags + 'y'),
    token,
  }))
}

/** storage / 声明关键字 - 统一渲染成 `storage` token 的颜色，
 *  对齐 CC 的 `_storage` scope（color-diff/index.ts:248-265）。
 *  这是跨语言共用的一组全局集合：hljs / syntect 会把这些词当成
 *  同一个 scope，不管源语言是什么，而且这些词也不会和需要不同着色
 *  的内容重叠。 */
const STORAGE_KEYWORDS = new Set([
  'const',
  'let',
  'var',
  'function',
  'class',
  'type',
  'interface',
  'enum',
  'namespace',
  'module',
  'def',
  'fn',
  'func',
  'struct',
  'trait',
  'impl',
])

/** JS / TS 的全局“支持”对象 - 对应 hljs 的 `built_in`，
 *  CC 的 MONOKAI_SCOPES 会把它们画成黄绿色
 *  （color-diff/index.ts:193）。把这些值路由到 `function`
 *  调色板槽位，就能让 `console.log(...)` 变成 **绿色** 的 `console`
 *  + 纯文本的 `log` - 这和 CC 一致。否则我们以前那个“标识符后面
 *  跟着 `(` 就当函数”的启发式，会把 `log`（方法）涂成绿色，
 *  而把 `console`（全局对象）留成普通文本，正好和 CC 反过来。 */
const JS_GLOBALS = new Set([
  'console',
  'globalThis',
  'window',
  'document',
  'process',
  'module',
  'exports',
  'require',
  '__dirname',
  '__filename',
  'global',
  'self',
  'Math',
  'JSON',
  'Symbol',
  'Reflect',
  'Atomics',
  'Intl',
  'Object',
  'Array',
  'String',
  'Number',
  'Boolean',
  'BigInt',
  'Date',
  'RegExp',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'URIError',
  'EvalError',
  'AggregateError',
  'Promise',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'WeakRef',
  'Proxy',
  'ArrayBuffer',
  'SharedArrayBuffer',
  'DataView',
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'encodeURI',
  'encodeURIComponent',
  'decodeURI',
  'decodeURIComponent',
])

const KEYWORDS_JS = new Set([
  'await',
  'async',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'finally',
  'for',
  'from',
  'function',
  'get',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'of',
  'package',
  'private',
  'protected',
  'public',
  'readonly',
  'return',
  'set',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'try',
  'type',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'as',
  'declare',
  'namespace',
  'satisfies',
  'override',
])

const LITERALS_JS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'])

const KEYWORDS_PYTHON = new Set([
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
])

const KEYWORDS_GO = new Set([
  'break',
  'case',
  'chan',
  'const',
  'continue',
  'default',
  'defer',
  'else',
  'fallthrough',
  'for',
  'func',
  'go',
  'goto',
  'if',
  'import',
  'interface',
  'map',
  'package',
  'range',
  'return',
  'select',
  'struct',
  'switch',
  'type',
  'var',
  'true',
  'false',
  'nil',
])

const KEYWORDS_RUST = new Set([
  'as',
  'async',
  'await',
  'break',
  'const',
  'continue',
  'crate',
  'dyn',
  'else',
  'enum',
  'extern',
  'false',
  'fn',
  'for',
  'if',
  'impl',
  'in',
  'let',
  'loop',
  'match',
  'mod',
  'move',
  'mut',
  'pub',
  'ref',
  'return',
  'self',
  'Self',
  'static',
  'struct',
  'super',
  'trait',
  'true',
  'type',
  'unsafe',
  'use',
  'where',
  'while',
])

const KEYWORDS_SHELL = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'case',
  'esac',
  'for',
  'while',
  'until',
  'do',
  'done',
  'function',
  'in',
  'return',
  'exit',
  'export',
  'local',
  'readonly',
  'unset',
  'echo',
  'printf',
  'source',
])

/** Keyword classification for the simple-grammar languages: look the word
 *  up in the language's keyword set, optionally classify PascalCase as a
 *  type. JS has its own richer logic (LITERALS / GLOBALS / PascalCase) so
 *  it isn't in this table. */
const KEYWORD_RULES: Partial<Record<Lang, { keywords: Set<string>; pascalAsType?: boolean }>> = {
  python: { keywords: KEYWORDS_PYTHON, pascalAsType: true },
  go: { keywords: KEYWORDS_GO, pascalAsType: true },
  rust: { keywords: KEYWORDS_RUST, pascalAsType: true },
  shell: { keywords: KEYWORDS_SHELL },
}

// ─── 各语言规则表 ───
//
// 每一组规则都会在每个字节位置按顺序尝试。第一个匹配的规则会消耗
// 那些字符，并输出一个带颜色的片段。重要的是：comment / string /
// number 规则必须排在 identifier 规则前面，否则像 `"if"` 这样的字符串
// 里的 `if` 就会被错误地当成关键字高亮。

function jsRules(): Rule[] {
  return makeRules([
    { re: /\/\/[^\n]*/, token: 'comment' },
    // 给块注释加上长度上限，避免正则灾难性回溯 - 单行超过 500
    // 字符的注释本来也很病态，我们宁可直接放弃，也不要卡住。
    { re: /\/\*[\s\S]{0,500}?\*\//, token: 'comment' },
    { re: /"(?:[^"\\\n]|\\.){0,500}"/, token: 'string' },
    { re: /'(?:[^'\\\n]|\\.){0,500}'/, token: 'string' },
    { re: /`(?:[^`\\]|\\.){0,500}`/, token: 'string' },
    { re: /0[xX][0-9a-fA-F]+n?/, token: 'number' },
    { re: /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?n?\b/, token: 'number' },
    // 声明名捕获：在 `function` / `class` / `interface` / `type`
    // / `enum` / `namespace` 后面的下一个标识符，在 hljs 里通常会被
    // 归到 `title.*` scope。我们把它们统一压到 `function` token 上，
    // 因为 CC 的三套主题里 `title.function` 和 `title.class` 实际上
    // 都是同色：monokai 黄绿色，ansi 亮黄。（github-light 是唯一的
    // 例外 - 那里 `title.class` 是黑色，但我们还是把类名放在
    // `function` 槽位里，以便在 monokai / ansi 这种用户更容易看出差异
    // 的模式下保持正确。）
    {
      re: /(?<=\b(?:function|class|interface|type|enum|namespace)\s+)[A-Za-z_$][\w$]*/,
      token: 'function',
    },
    // 通用标识符 - keyword / literal / global / type 的分类都在 paint()
    // 里完成。注意：这里我们故意不放一个“标识符后面跟着 `(` 就算函数”
    // 的通用规则。按照 CC 的 hljs 语义，像 `obj.method(...)` 里的
    // `method` 会被画成 `property`（也就是默认前景色、没有颜色），
    // 而不是函数名。以前那个启发式会把 `log` 涂成黄绿色，视觉上正好
    // 和 CC 相反。现在函数调用按设计就是纯文本。
    { re: /[A-Za-z_$][\w$]*/, token: 'keyword' },
  ])
}

function jsonRules(): Rule[] {
  return makeRules([
    { re: /"(?:[^"\\\n]|\\.){0,500}"/, token: 'string' },
    { re: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/, token: 'number' },
    { re: /\b(?:true|false|null)\b/, token: 'literal' },
  ])
}

function htmlRules(): Rule[] {
  return makeRules([
    { re: /<!--[\s\S]{0,500}?-->/, token: 'comment' },
    // 标签名：`<TagName` 和 `</TagName`。黄色。
    { re: /<\/?[A-Za-z][\w-]*/, token: 'type' },
    { re: /"(?:[^"\\\n]|\\.){0,500}"/, token: 'string' },
    { re: /'(?:[^'\\\n]|\\.){0,500}'/, token: 'string' },
    // 属性名 - 不算完美（也会匹配一些松散 id），但已经够接近了。
    { re: /\b[a-zA-Z_:][\w:.-]*(?=\s*=)/, token: 'function' },
  ])
}

function cssRules(): Rule[] {
  return makeRules([
    { re: /\/\*[\s\S]{0,500}?\*\//, token: 'comment' },
    { re: /"(?:[^"\\\n]|\\.){0,500}"/, token: 'string' },
    { re: /'(?:[^'\\\n]|\\.){0,500}'/, token: 'string' },
    // 带 `.foo`、`#bar`、`:hover` 这类 selector - 黄色。
    { re: /[#.][a-zA-Z_-][\w-]*/, token: 'type' },
    { re: /:[a-zA-Z-]+(?:\([^)]*\))?/, token: 'function' },
    // 属性名（标识符后面紧跟 `:`）。
    { re: /\b[a-zA-Z-]+(?=\s*:)/, token: 'function' },
    // #hex 颜色和数值（可带单位）。
    { re: /#[0-9a-fA-F]{3,8}\b/, token: 'number' },
    { re: /-?\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|deg|s|ms|fr)?\b/, token: 'number' },
  ])
}

function yamlRules(): Rule[] {
  return makeRules([
    { re: /#[^\n]*/, token: 'comment' },
    { re: /"(?:[^"\\\n]|\\.){0,500}"/, token: 'string' },
    { re: /'(?:[^'\\\n]|\\.){0,500}'/, token: 'string' },
    // 后面跟着 `:` 的 key（大概在行首附近；我们不追踪精确位置，所以
    // 这里是近似匹配）。
    { re: /\b[a-zA-Z_][\w-]*(?=\s*:)/, token: 'function' },
    { re: /\b(?:true|false|null|yes|no|on|off)\b/i, token: 'literal' },
    { re: /-?\b\d+(?:\.\d+)?\b/, token: 'number' },
  ])
}

function shellRules(): Rule[] {
  return makeRules([
    { re: /#[^\n]*/, token: 'comment' },
    { re: /"(?:[^"\\\n]|\\.){0,500}"/, token: 'string' },
    { re: /'[^'\n]{0,500}'/, token: 'string' },
    // 变量：$VAR 或 ${VAR}。
    { re: /\$\{[^}\n]{1,200}\}|\$[A-Za-z_]\w*/, token: 'literal' },
    { re: /-?\b\d+\b/, token: 'number' },
    { re: /[A-Za-z_][\w-]*/, token: 'keyword' },
  ])
}

function pythonRules(): Rule[] {
  return makeRules([
    { re: /#[^\n]*/, token: 'comment' },
    // 三引号字符串（这里只处理单行 - 多行本来也活不过按行 token 化）。
    { re: /"""(?:[^"\\]|\\.){0,500}"""/, token: 'string' },
    { re: /'''(?:[^'\\]|\\.){0,500}'''/, token: 'string' },
    { re: /"(?:[^"\\\n]|\\.){0,500}"/, token: 'string' },
    { re: /'(?:[^'\\\n]|\\.){0,500}'/, token: 'string' },
    { re: /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[jJ]?\b/, token: 'number' },
    { re: /[A-Za-z_][\w]*(?=\s*\()/, token: 'function' },
    { re: /[A-Za-z_][\w]*/, token: 'keyword' },
  ])
}

function goRules(): Rule[] {
  return makeRules([
    { re: /\/\/[^\n]*/, token: 'comment' },
    { re: /\/\*[\s\S]{0,500}?\*\//, token: 'comment' },
    { re: /"(?:[^"\\\n]|\\.){0,500}"/, token: 'string' },
    { re: /`[^`]{0,500}`/, token: 'string' },
    { re: /'(?:[^'\\\n]|\\.){0,5}'/, token: 'string' }, // rune
    { re: /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/, token: 'number' },
    { re: /[A-Za-z_][\w]*(?=\s*\()/, token: 'function' },
    { re: /[A-Za-z_][\w]*/, token: 'keyword' },
  ])
}

function rustRules(): Rule[] {
  return makeRules([
    { re: /\/\/[^\n]*/, token: 'comment' },
    { re: /\/\*[\s\S]{0,500}?\*\//, token: 'comment' },
    { re: /"(?:[^"\\\n]|\\.){0,500}"/, token: 'string' },
    { re: /'(?:[^'\\\n]|\\.){0,5}'/, token: 'string' }, // 字符字面量
    { re: /\b\d+(?:_\d+)*(?:\.\d+(?:_\d+)*)?(?:[eE][+-]?\d+)?(?:[uif]\d+|usize|isize)?\b/, token: 'number' },
    { re: /[A-Za-z_][\w]*!/, token: 'function' }, // 宏
    { re: /[A-Za-z_][\w]*(?=\s*\()/, token: 'function' },
    { re: /[A-Za-z_][\w]*/, token: 'keyword' },
  ])
}

function mdRules(): Rule[] {
  return makeRules([
    { re: /^#{1,6}\s.*/, token: 'type' }, // 标题
    { re: /\*\*[^*\n]{1,200}\*\*/, token: 'keyword' },
    { re: /`[^`\n]{1,200}`/, token: 'string' },
    { re: /\[[^\]\n]{1,200}\]\([^)\n]{1,200}\)/, token: 'function' },
  ])
}

const RULES_BY_LANG: Record<Lang, () => Rule[]> = {
  js: jsRules,
  json: jsonRules,
  html: htmlRules,
  css: cssRules,
  yaml: yamlRules,
  shell: shellRules,
  python: pythonRules,
  go: goRules,
  rust: rustRules,
  md: mdRules,
}

// ─── Token 着色 ───

/** 把当前调色板里的颜色规范应用到文本上。
 *  hex 字符串走 `chalk.hex`；命名 ANSI 颜色走 chalk 的命名访问器；
 *  `null` 则保持文本不变（`'off'` 会用到它，另外当单词没有匹配到
 *  任何已知 keyword/type 模式时，identifier 分类的回退也会用到它）。 */
export function applyColor(text: string, spec: ColorSpec): string {
  if (spec === null) return text
  if (spec.startsWith('#')) return c.hex(spec)(text)
  // 命名 ANSI 颜色 - 这里只做一个很小的访问器查找。
  // Chalk 把它类型化成可链式 getter，但我们只需要常见的 8 / 16 色。
  const named = (c as unknown as Record<string, (s: string) => string>)[spec]
  if (typeof named === 'function') return named(text)
  return text
}

/** 默认前景色回退。供 paint() 和 highlightLine 里的“未匹配字符”循环使用，
 *  让 diff 行里的纯文本也能得到和 CC 的 `Theme.foreground` 一样的
 *  亮奶白 / 深灰效果。
 *  当 `defaultFg` 是 null / undefined 时，就保持不变。 */
function paintDefault(text: string, defaultFg: ColorSpec | undefined): string {
  if (!defaultFg) return text
  return applyColor(text, defaultFg)
}

function paint(text: string, token: Token, lang: Lang, palette: Palette, defaultFg?: ColorSpec): string {
  // 标识符的二次分类：对于那些同一个正则会匹配 keyword / literal /
  // 普通 identifier 的语言，我们会根据原始单词重新分桶。
  // 这样 rule table 就能保持扁平，不需要写很多嵌套规则。
  if (token === 'keyword') {
    const word = text
    // storage 关键字会在所有语言里都路由到 `storage` 调色板槽位 -
    // `function` / `const` / `class` / `def` / `fn` / `struct` 等都会
    // 变成青色（Monokai）/ 洋红（GitHub），而不是和控制流关键字一样
    // 变成热粉。这里对齐的是 CC scopeColor 里的 STORAGE_KEYWORDS 检查
    // （color-diff/index.ts:459-461）。
    if (STORAGE_KEYWORDS.has(word)) return applyColor(text, palette.storage)
    if (lang === 'js') {
      if (KEYWORDS_JS.has(word)) return applyColor(text, palette.keyword)
      if (LITERALS_JS.has(word)) return applyColor(text, palette.literal)
      // 已知 JS 全局对象（`console`、`Math`、`JSON` 等）→ palette.type。
      // 原因是 hljs 会把它们标成 `built_in`，而在 CC 的三套语法主题里，
      // `built_in` 和 `type` 始终同色（monokai 黄绿色 / github-light 青绿 /
      // ansi 亮青）。`function` 槽位保留给 `title.function`
      //（像 `greet` 这样的声明名），因为它在 github-light 里是紫色、
      // 在 ANSI 里是亮黄。
      if (JS_GLOBALS.has(word)) return applyColor(text, palette.type)
      // 启发式：PascalCase 标识符大概率是类型 / 类名。
      // 这个判断很便宜，而且对常见惯用代码几乎没有漏判。
      if (/^[A-Z][a-zA-Z0-9_]*$/.test(word)) return applyColor(text, palette.type)
      return paintDefault(text, defaultFg)
    }
    const rule = KEYWORD_RULES[lang]
    if (rule) {
      if (rule.keywords.has(word)) return applyColor(text, palette.keyword)
      if (rule.pascalAsType && /^[A-Z][a-zA-Z0-9_]*$/.test(word)) return applyColor(text, palette.type)
      return paintDefault(text, defaultFg)
    }
    return applyColor(text, palette.keyword)
  }
  if (token === 'storage') return applyColor(text, palette.storage)
  if (token === 'string') return applyColor(text, palette.string)
  if (token === 'number') return applyColor(text, palette.number)
  if (token === 'comment') return applyColor(text, palette.comment)
  if (token === 'function') return applyColor(text, palette.function)
  if (token === 'type') return applyColor(text, palette.type)
  if (token === 'literal') return applyColor(text, palette.literal)
  return paintDefault(text, defaultFg)
}

// ─── 主入口 ───

/** 用指定主题（如果没传，就用当前模块级主题）高亮单行代码。
 *  返回的是 ANSI 彩色文本，但可见宽度和输入完全一致 - 只增加 escape
 *  code，不替换字符本身。
 *
 *  当 `lang` 为 null（文件扩展名不认识）或者当前主题是 `'off'` 时，
 *  如果没有 `defaultFg`，输出会和输入完全一致。若有 `defaultFg`，
 *  那么所有字符都会带前景色，这样 diff 背景上的未高亮文本就能像 CC
 *  一样显示成更亮的奶白 / 深灰，而不是终端默认白色。 */
export function highlightLine(
  line: string,
  lang: Lang | null,
  theme?: SyntaxThemeName,
  defaultFg?: string | null,
): string {
  if (line.length === 0) return line

  // 语言不认识时：如果提供了 defaultFg，就把整行都涂成它
  //（这样一个没有 Python 规则的 Python diff 也能在背景上显示成
  // 亮奶白前景）；否则就原样返回。
  if (lang === null) {
    return defaultFg ? applyColor(line, defaultFg) : line
  }

  const palette = THEMES[theme ?? currentTheme]
  // 对 `'off'`（全 null 调色板）来说，没有任何 token 颜色可用。
  // 但我们仍然希望 defaultFg 生效，这样 diff 背景上的未高亮文本
  // 亮度才对。这里直接跳过正则工作 - 整行都用 defaultFg 着色
  //（如果没有 defaultFg，就直接原样返回）。
  if (palette === THEMES.off) {
    return defaultFg ? applyColor(line, defaultFg) : line
  }

  const rules = RULES_BY_LANG[lang]()
  let pos = 0
  let out = ''
  const len = line.length

  while (pos < len) {
    let matched = false
    for (const r of rules) {
      r.re.lastIndex = pos
      const m = r.re.exec(line)
      if (m && m.index === pos && m[0].length > 0) {
        out += paint(m[0], r.token, lang, palette, defaultFg ?? undefined)
        pos += m[0].length
        matched = true
        break
      }
    }
    if (!matched) {
      // 没有任何规则匹配到 - 就把当前字符按 defaultFg 着色（或者
      // 原样透传）。
      // 这会覆盖 `(`、`)`、`;`、`{`、`}` 这些标点 - CC 的 hljs 会
      // 把它们标成 `punctuation`（也就是 theme.foreground）。
      // 每次只前进一个字符，可以保证循环是有界的。
      out += defaultFg ? applyColor(line[pos]!, defaultFg) : line[pos]!
      pos++
    }
  }
  return out
}
