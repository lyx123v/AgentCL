// @x-code-cli/core — 对外公开的类型定义
import type { LanguageModel, ModelMessage } from 'ai'

import type { EditDiffPayload } from '../agent/diff.js'
import type { SubAgentRegistry } from '../agent/sub-agents/registry.js'
import type { SubAgentEvent } from '../agent/sub-agents/types.js'
import type { CommandRegistry } from '../commands/registry.js'
import type { HookBus } from '../hooks/bus.js'
import type { McpPermissionStore } from '../mcp/permissions.js'
import type { McpRegistry } from '../mcp/registry.js'
import type { PluginRegistry } from '../plugins/registry.js'
import type { SkillRegistry } from '../skills/registry.js'

// ─── 权限 ───

export type PermissionLevel = 'always-allow' | 'ask' | 'deny'

/** 当前会话的审批模式。
 *
 *    'default'      — 正常模式：写入类工具需要询问，模型可照常调用其他工具。
 *    'plan'         — 只读规划模式：模型会被提示先探索并把计划写到会话本地的
 *                     plan 文件里，但不做其他编辑。这里的约束主要依赖 prompt，
 *                     与 Claude Code 一致，没有额外的硬权限拦截；因此如果模型
 *                     不守规矩，写入/edit/shell 仍会落到常规 `ask` 流程。
 *    'acceptEdits'  — 写入类工具（writeFile / edit）自动批准，无需再次询问；
 *                     shell 仍按正常的 always-allow / ask / deny 分类执行，
 *                     所以破坏性命令依旧会被拦住。适合计划刚获批后的实现阶段，
 *                     因为用户既然已经审过计划，再对每次 writeFile 都点一次
 *                     “Yes” 就只剩纯摩擦了。exitPlanMode 获批后会自动切到此模式。 */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan'

// ─── Todo 清单（TodoWrite 工具） ───

/** 模型工作清单中的单个条目。
 *
 *    content    — 任务的祈使句表达（例如“更新认证处理器”）
 *    activeForm — 实时状态里展示的进行式表达（例如“正在更新认证处理器”）；
 *                 当 status 为 'in_progress' 时会显示在 UI 中，让用户知道
 *                 代理此刻正在做什么。
 *    status     — 'pending' | 'in_progress' | 'completed'
 *
 *  这里的结构与 Claude Code 的 TodoWrite payload 保持一致。
 *  仅保存在内存中（LoopState.todos），按会话隔离，不落盘。 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  content: string // 任务的祈使句描述，供列表静态展示
  activeForm: string // 任务的进行式描述，在运行中状态里展示
  status: TodoStatus // 当前任务状态：待办、进行中或已完成
}

// ─── Token 使用统计 ───

export interface TokenUsage {
  inputTokens: number // 累计输入 token 数
  outputTokens: number // 累计输出 token 数
  totalTokens: number // 累计总 token 数
  /** 从缓存 prompt 中读取的 token 数（如 Anthropic 的 cache_read、OpenAI 的 cached_tokens）。
   *  这些 token 通常按低于普通输入的费率计费，具体比例取决于 provider。
   *  它们已计入 `inputTokens`，此字段仅用于展示说明。 */
  cacheReadTokens: number // 累计命中 provider 侧缓存读取的 token 数
  /** 写入 provider 侧缓存的 token 数（如 Anthropic 的 cache_creation_input_tokens）。
   *  这部分通常比普通输入更贵，但能换来后续回合的廉价缓存读取。
   *  对不区分创建与读取的 provider 来说，这里通常为 0。 */
  cacheCreationTokens: number // 累计写入 provider 缓存的 token 数
  /** 当前上下文窗口占用量，对应“最近一次 API 响应”的 `input_tokens + output_tokens`
   *  （从 AI SDK v6 起，`inputTokens` 已经吸收了 cache_read + cache_write）。
   *  与上面的累计字段不同，这里是一个快照值：每轮覆盖，不累计。UI 底部
   *  的 “N / M · X%” 指示器就是依赖它。
   *
   *  为什么要用 input + output：因为主流 LLM API 都把上下文窗口定义成输入和
   *  输出共享的预算池，即 `input + output ≤ context_window`。如果底部只显示输入，
   *  那会和用户在 provider 文档里看到的上下文窗口定义不一致。 */
  currentContextTokens: number // 最近一次响应实际占用的上下文 token 快照
}

// ─── 展示消息 ───

export interface DisplayMessage {
  id: string // 消息唯一标识
  role: 'user' | 'assistant' | 'tool' // 消息来源角色
  content: string // 要展示的文本内容
  toolCalls?: DisplayToolCall[] // 若该消息关联工具调用，则附带工具调用列表
  timestamp: number // 消息时间戳
  /** 为 true 时，表示这是 assistant 在流式输出过程中吐出的中间文本块（通常每个换行一块）。
   *  这类消息渲染时不会追加普通消息末尾的空行，因此连续块在视觉上会拼成同一段，
   *  也能避免把流式输出塞进底部 cell buffer 后造成行抖动。 */
  streamingChunk?: boolean // 是否为流式输出中的中间消息块
  /** 紧凑 slash 命令渲染模式，对齐 Claude Code 的两行展示风格：
   *    > /model
   *      ⎿  已切换到 Sonnet 4.6
   *  `command-echo`（user role）不会带常规用户消息的尾部空行；
   *  `command-result`（assistant role）则使用 ⎿ 前缀，并只保留一个结尾换行。 */
  kind?: 'command-echo' | 'command-result' // 消息展示样式类别
}

export interface DisplayToolCall {
  id: string // 工具调用唯一标识
  toolName: string // 工具名称
  input: Record<string, unknown> // 工具调用入参
  output?: string // 工具调用输出文本
  /** `error` 表示工具虽已结束，但以非零退出码或异常结束，stdout writer 会把这类
   *  结果渲染成红色，方便用户快速看到失败。`denied` 专门留给权限拒绝场景。 */
  status: 'pending' | 'running' | 'completed' | 'denied' | 'error' // 当前工具调用状态
  /** 工具调用实际执行耗时，单位毫秒。 */
  durationMs?: number // 工具调用耗时
  /** 由 writeFile / edit 产生的结构化补丁数据，用于在滚动区工具条目下渲染彩色 diff。
   *  非编辑类工具、会话恢复后的历史消息，以及实际没有产生内容变化的编辑，都不会带这个字段。 */
  editPayload?: EditDiffPayload // 与本次编辑相关的结构化 diff 数据
}

// ─── Agent 回调（core → UI 桥接层） ───

export interface AgentCallbacks {
  onTextDelta: (text: string) => void // 流式文本增量回调，用于实时渲染 assistant 输出
  onToolCall: (toolCallId: string, toolName: string, input: Record<string, unknown>) => void // 工具开始调用时触发
  /** 工具运行中发出的进度消息（例如“正在搜索”→“找到 5 条结果”）。
   *  实时 UI 只展示最新一条，最终摘要仍通过 onToolResult 进入消息流。 */
  onToolProgress: (toolCallId: string, message: string) => void // 工具进度更新回调
  onToolResult: (toolCallId: string, result: string, isError?: boolean) => void // 工具结束时返回结果或错误
  /** 可选。成功执行 writeFile / edit 时，会在 `onToolResult` 之前触发，
   *  并附带结构化补丁与行数信息，供 UI 在工具条目下方渲染 diff 块。
   *  若写入被拒绝、执行报错，或编辑其实没有产生变化，则不会触发。 */
  onFileEdit?: (toolCallId: string, payload: EditDiffPayload) => void // 成功文件编辑后的 diff 回调
  onAskPermission: (toolCall: {
    toolCallId: string // 待审批工具调用的唯一标识
    toolName: string // 待审批工具名称
    input: Record<string, unknown> // 待审批工具输入参数
  }) => Promise<'yes' | 'always' | 'no'> // 向用户请求权限审批的回调
  onAskUser: (
    question: string,
    options: { label: string // 选项标题
      description: string // 选项说明
    }[],
  ) => Promise<string> // 向用户发问并等待选择结果
  /** 由 `exitPlanMode` 触发。返回 `true` 表示批准计划并退出 plan 模式，
   *  允许模型进入实现阶段；返回 `false` 表示拒绝计划并继续留在 plan 模式迭代。 */
  onPlanApprovalRequest: (planText: string) => Promise<boolean> // 计划审批请求回调
  /** 每次 permissionMode 变化时触发，让 UI 同步底部状态，也可顺带把新值持久化到用户配置。 */
  onPlanModeChange: (mode: PermissionMode) => void // 规划模式切换回调
  /** 模型调用 `todoWrite` 后触发，用来更新 UI 中的实时清单。
   *  todoWrite 每次传的是完整列表，不是 delta，因此 UI 直接整表替换即可。 */
  onTodosUpdate: (todos: TodoItem[]) => void // Todo 清单更新回调
  onShellOutput: (chunk: string) => void // shell 流式输出片段回调
  onUsageUpdate: (usage: TokenUsage) => void // token 使用统计更新回调
  onContextCompressed: (summary: string) => void // 上下文压缩完成后的摘要回调
  /** 在上下文压缩的各阶段边界触发，让 UI 可以显示跟随进度变化的 spinner 文案。 */
  onCompressionProgress?: (description: string) => void // 上下文压缩阶段进度回调
  onError: (error: Error) => void // 统一错误回调
  /** 由子代理执行器触发，用来流式转发子代理 loop 的进度事件。
   *  CLI UI 会用这些事件构造可折叠/展开的 task 展示块。 */
  onSubAgentEvent?: (event: SubAgentEvent) => void // 子代理事件回调
  /** 可选。后处理记忆提取器每成功写入一条 AutoMemory 时触发，
   *  用于在滚动区展示 “Remembered: …” 之类的提示，让用户知道静默提取器记住了什么。
   *  该提取器是 fire-and-forget 的，因此这个回调可能在 `submit()` 返回之后，
   *  甚至下一轮开始后才被触发，所以闭包里不要依赖“仅本轮有效”的状态。 */
  onMemoryWrite?: (notice: MemoryWriteNotice) => void // 自动记忆写入提示回调
}

// ─── Agent 选项 ───

export interface AgentOptions {
  modelId: string // 当前会话使用的模型 ID
  trustMode: boolean // 是否启用更信任模型的运行模式
  /** 单次 `agentLoop` 调用允许的最大迭代轮数。
   *  如果省略，则不会设置轮数上限，用户按 Esc / Ctrl+C 才是唯一停止方式。
   *  实际上传值的主要是子代理与 `--print` 模式；交互式会话通常不设。 */
  maxTurns?: number // 本次 agent loop 的最大轮次限制
  printMode: boolean // 是否处于非交互式 print 模式
  /** 为 true 时，agent loop 会请求各 provider 支持的最高 reasoning 强度
   *  （映射关系见 providers/thinking.ts）。该值会持久化到
   *  `~/.x-code/config.json` 的 `thinking` 字段，也可通过 `/thinking on|off`
   *  在运行时切换，默认 false。 */
  thinking?: boolean // 是否启用深度思考模式
  /** 本次会话的初始权限模式，默认是 'default'。
   *  通常来自 CLI 的 `--plan` 标志，或 `loadUserConfig().permissionMode`。 */
  permissionMode?: PermissionMode // 会话初始权限模式
  systemPromptExtra?: string // 额外拼接到 system prompt 的文本
  abortSignal?: AbortSignal // 用于中断当前会话或当前轮执行的 AbortSignal

  // ── 子代理支持 ──

  /** provider 注册表，用于解析子代理的模型覆盖配置。
   *  在 CLI 启动时注入。若缺失，则子代理继承父级模型，不能独立选型。 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  modelRegistry?: { languageModel: (...args: any[]) => LanguageModel } // 子代理可用的模型注册表
  /** 子代理注册表。CLI 启动扫描完内置与自定义 agent 定义后注入。
   *  若缺失，则不会注册 task 工具，也就没有子代理能力。 */
  subAgentRegistry?: SubAgentRegistry // 可用子代理定义注册表
  /** 工具允许/拒绝过滤器。主要供子代理 loop 使用，用来限制子代理能调用哪些工具。
   *  其中 `task` 永远会被放进 `deny`，避免递归派生子代理。 */
  toolFilter?: { allow?: string[]; deny?: string[] } // 工具调用白名单/黑名单过滤器

  // ── Skill 支持 ──

  /** Skill 注册表，由 CLI 启动时的 createSkillRegistry 填充。
   *  若缺失，表示未配置任何 skill，此时 activateSkill 工具不会注册，
   *  system prompt 里也不会出现 `## Available Skills` 区块。 */
  skillRegistry?: SkillRegistry // 当前会话可用的 Skill 注册表

  // ── MCP 支持 ──

  /** MCP 注册表，由 CLI 启动时的 loadMcpServers 填充。
   *  若缺失，表示 MCP 整体禁用（没有配置 server），agent loop 会直接短路
   *  所有 MCP 相关逻辑。这个注册表在单个会话生命周期内视为不可变；
   *  `/mcp refresh` 会在下一次进入 agentLoop 时替换整份对象。 */
  mcpRegistry?: McpRegistry // 当前会话可用的 MCP 注册表
  /** MCP 工具调用的权限存储。每个 CLI 进程只创建一次，用来缓存持久化的
   *  always-allow 列表以及当前会话级别的放行结果。
   *  若缺失，tool-execution 会退回“每次都询问”的权限语义。 */
  mcpPermissionStore?: McpPermissionStore // MCP 权限缓存与持久化存储

  // ── 插件支持 ──

  /** 插件注册表，由 CLI 启动时的 loadAllPlugins 填充。
   *  它持有所有成功加载的插件（无论启用还是禁用），这样 `/plugin ...`
   *  这组 slash 命令就能在不重新扫描缓存的前提下做列表、详情与开关操作。
   *  插件带来的 skills / agents / mcp 等贡献已在 CLI 启动阶段并入各自注册表；
   *  这个字段主要是给 slash 命令 UI 暴露插件元数据。
   *  若缺失，表示插件被禁用（如 `--no-plugins`）或本机没有安装插件。 */
  pluginRegistry?: PluginRegistry // 插件元数据注册表

  /** Hook bus，由所有启用插件的 `hooks` 贡献构建而成。
   *  agent loop 会通过它发出 SessionStart / UserPromptSubmit / TurnComplete /
   *  SessionEnd 等事件，tool-execution 还会补充 PreToolUse / PostToolUse。
   *  若缺失，则完全不发 hook（agent loop 会跳过所有 emit 点）。
   *  对于测试或子代理这类“允许调用 emit，但实际没有监听器”的场景，可用
   *  `emptyHookBus()` 占位。 */
  hookBus?: HookBus // 插件 hook 事件总线

  /** 基于文件的 slash 命令注册表，由插件贡献的 `commands/` 目录构建。
   *  App.tsx 默认的 slash 分发器会在检查完内置命令和 skill 注册表后再查这里；
   *  一旦命中，就会展开命令体（包括 $ARGUMENTS / ${CLAUDE_PLUGIN_ROOT}
   *  替换）并作为模型 prompt 提交。
   *  若缺失，则表示没有可用的插件命令。 */
  commandRegistry?: CommandRegistry // 插件扩展的 slash 命令注册表
}

// ─── 知识 / 记忆 ───

/**
 * 自动记忆条目的分类体系。这里描述的是“知识的类型”
 * （它关于谁、是如何得来的），而不是具体主题本身。
 * 这种分类方式和 Claude Code 类似，能让记忆提取更精准，因为每一类对代理
 * 都有不同的触发条件。
 *
 * - user:      关于用户本人的事实，例如角色、专长、目标、约束
 * - feedback:  用户给出的纠正或认可的方法，例如“别 mock 数据库”“对，就是这个”
 * - project:   项目中的持续性工作、决策、非显而易见的状态
 * - reference: 指向外部系统的引用，例如 Linear 项目、Grafana 面板等
 */
export type KnowledgeCategory = 'user' | 'feedback' | 'project' | 'reference'

export interface KnowledgeFact {
  key: string // 记忆条目的稳定键，用于去重和更新
  fact: string // 具体记忆内容
  category: KnowledgeCategory // 记忆所属分类
  date: string // 记忆记录日期
}

/** 回合结束后的记忆提取器在把某条事实写入 AutoMemory 时抛出的展示事件。
 *  UI 可以据此在滚动区渲染一条“已记住：...”之类提示，避免静默写入完全不可见。 */
export interface MemoryWriteNotice {
  scope: 'project' | 'user' // 写入的是项目级记忆还是用户级记忆
  category: KnowledgeCategory // 写入记忆的分类
  key: string // 记忆键
  fact: string // 记忆内容
}

export interface SessionSummary {
  id: string // 会话摘要唯一标识
  title: string // 会话标题
  startedAt: string // 会话开始时间
  endedAt: string // 会话结束时间
  status: 'completed' | 'in_progress' | 'abandoned' // 会话状态
  summary: string // 会话整体摘要
  keyResults: string[] // 本次会话达成的关键结果
  pendingWork: string[] // 尚未完成、后续待跟进的工作
  filesModified: string[] // 本次会话修改过的文件列表
  decisions: string[] // 会话中形成的关键决策
}

// ─── 模型别名 ───

export const MODEL_ALIASES: Record<string, string> = {
  fable: 'anthropic:claude-fable-5',
  sonnet: 'anthropic:claude-sonnet-4-6',
  opus: 'anthropic:claude-opus-4-8',
  haiku: 'anthropic:claude-haiku-4-5',
  gpt5: 'openai:gpt-5.5',
  gpt4: 'openai:gpt-4.1',
  gemini: 'google:gemini-3.5-flash',
  deepseek: 'deepseek:deepseek-v4-flash',
  'deepseek-pro': 'deepseek:deepseek-v4-pro',
  qwen: 'alibaba:qwen3.7-max',
  glm: 'zhipu:glm-5.1',
  kimi: 'moonshotai:kimi-k2.6',
}

// ─── Provider 检测顺序（用于智能默认值） ───

export const PROVIDER_DETECTION_ORDER = [
  { envKey: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek:deepseek-v4-flash' },
  { envKey: 'ANTHROPIC_API_KEY', defaultModel: 'anthropic:claude-sonnet-4-6' },
  { envKey: 'OPENAI_API_KEY', defaultModel: 'openai:gpt-5.5' },
  { envKey: 'ALIBABA_API_KEY', defaultModel: 'alibaba:qwen3.7-max' },
  { envKey: 'GOOGLE_GENERATIVE_AI_API_KEY', defaultModel: 'google:gemini-3.5-flash' },
  { envKey: 'XAI_API_KEY', defaultModel: 'xai:grok-4.3' },
  { envKey: 'ZHIPU_API_KEY', defaultModel: 'zhipu:glm-5.1' },
  { envKey: 'MOONSHOT_API_KEY', defaultModel: 'moonshotai:kimi-k2.6' },
] as const

// ─── 每个 Provider 的精选模型目录（用于交互式 /model 选择器） ───

export interface ProviderModel {
  /** 传给 AI SDK 的完整 `<provider>:<model>` 标识。 */
  id: string // 模型完整 ID
  /** 在模型选择器中展示的短标签。 */
  label: string // 模型短名称
  /** 展示在标签下方的一行说明。 */
  description: string // 模型简短描述
}

/**
 * 每个 provider 的手工精选模型列表。只有我们测试过，或官方明确标注为
 * 生产稳定的模型才会进入这里。因为代理往往会优先选择“看得见的”模型，
 * 所以这里不会把各种实验型号一股脑全倒进来。
 * 如果用户确实要用冷门型号，仍然可以手动输入完整 id：
 * `/model <provider>:<model>` 或通过 `--model` 传入。
 */
export const PROVIDER_MODELS: Record<string, readonly ProviderModel[]> = {
  anthropic: [
    {
      id: 'anthropic:claude-fable-5',
      label: 'Fable 5',
      description: '能力最强的模型，推理与代理能力最完整，支持 1M 上下文',
    },
    {
      id: 'anthropic:claude-opus-4-8',
      label: 'Opus 4.8',
      description: '顶级 Opus 档，适合复杂推理与代理式编码，支持 1M 上下文',
    },
    {
      id: 'anthropic:claude-sonnet-4-6',
      label: 'Sonnet 4.6',
      description: '速度与智能较均衡，支持 1M 上下文',
    },
    { id: 'anthropic:claude-haiku-4-5', label: 'Haiku 4.5', description: '最快也最便宜，回复通常更短' },
  ],
  openai: [
    { id: 'openai:gpt-5.5', label: 'GPT-5.5', description: '旗舰模型，适合复杂推理与编码' },
    { id: 'openai:gpt-5.4-mini', label: 'GPT-5.4 Mini', description: '能力很强的小模型，适合编码与代理任务' },
    { id: 'openai:gpt-4.1', label: 'GPT-4.1', description: '通用型模型，支持 1M 上下文窗口' },
    { id: 'openai:gpt-4.1-mini', label: 'GPT-4.1 Mini', description: 'GPT-4.1 的更低成本版本，支持 1M 上下文' },
    { id: 'openai:o3', label: 'o3', description: '推理模型，计划于 2026 年 8 月退役' },
    { id: 'openai:o4-mini', label: 'o4-mini', description: '更轻量的推理模型' },
  ],
  deepseek: [
    {
      id: 'deepseek:deepseek-v4-flash',
      label: 'DeepSeek V4 Flash',
      description: '快速、高效的通用模型，支持 1M 上下文',
    },
    {
      id: 'deepseek:deepseek-v4-pro',
      label: 'DeepSeek V4 Pro',
      description: '旗舰型号，推理更强，支持 1M 上下文',
    },
  ],
  alibaba: [
    { id: 'alibaba:qwen3.7-max', label: 'Qwen3.7 Max', description: '最新旗舰，也是当前最强的 Qwen' },
    { id: 'alibaba:qwen3-coder-plus', label: 'Qwen3 Coder Plus', description: '专为编码任务调优，支持 1M 上下文' },
    { id: 'alibaba:qwq-plus', label: 'QwQ Plus', description: '偏推理能力的模型' },
    { id: 'alibaba:qwen3-max', label: 'Qwen3 Max', description: '上一代旗舰，支持 256k 上下文' },
    { id: 'alibaba:qwen-plus', label: 'Qwen Plus', description: '成本与质量较均衡' },
    { id: 'alibaba:qwen-turbo', label: 'Qwen Turbo', description: '最便宜且速度快，支持 1M 上下文' },
  ],
  google: [
    { id: 'google:gemini-3.5-flash', label: 'Gemini 3.5 Flash', description: '最新旗舰，适合代理任务与编码' },
    { id: 'google:gemini-2.5-pro', label: 'Gemini 2.5 Pro', description: '支持 1M 上下文，长文档处理能力强' },
    { id: 'google:gemini-2.5-flash', label: 'Gemini 2.5 Flash', description: '更便宜也更快的层级，支持 1M 上下文' },
  ],
  xai: [
    { id: 'xai:grok-4.3', label: 'Grok 4.3', description: '最新旗舰，支持 1M 上下文' },
    { id: 'xai:grok-3', label: 'Grok 3', description: '上一代别名（会映射到 grok-4.3）' },
  ],
  zhipu: [
    { id: 'zhipu:glm-5.1', label: 'GLM-5.1', description: '最新旗舰，支持 200k 上下文，编码能力强' },
    { id: 'zhipu:glm-5', label: 'GLM-5', description: '偏工程代理能力的模型，支持 200k 上下文' },
    { id: 'zhipu:glm-4-plus', label: 'GLM-4 Plus', description: '上一代型号，支持 128k 上下文' },
  ],
  moonshotai: [
    { id: 'moonshotai:kimi-k2.6', label: 'Kimi K2.6', description: '最新版本，编码与代理能力最强' },
    { id: 'moonshotai:kimi-k2.5', label: 'Kimi K2.5', description: '上一代型号，支持 131k 上下文' },
  ],
}

// ─── Provider API Key 获取入口 ───

export const PROVIDER_KEY_URLS: Record<string, string> = {
  anthropic: 'https://console.anthropic.com/',
  openai: 'https://platform.openai.com/api-keys',
  google: 'https://aistudio.google.com/apikey',
  xai: 'https://console.x.ai/',
  deepseek: 'https://platform.deepseek.com/api_keys',
  alibaba: 'https://dashscope.console.aliyun.com/apiKey',
  zhipu: 'https://open.bigmodel.cn/usercenter/apikeys',
  moonshotai: 'https://platform.moonshot.ai/console/api-keys',
}

// ─── 重新导出 AI SDK 类型 ───

export type { ModelMessage, LanguageModel }

// ─── 重新导出子代理相关类型 ───

export type { SubAgentEvent, SubAgentDefinition, SubAgentTrace } from '../agent/sub-agents/types.js'
export type { SubAgentRegistry } from '../agent/sub-agents/registry.js'
