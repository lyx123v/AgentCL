# e2e 测试套件

这是一组端到端测试，会直接驱动真实的 `xc -p` 二进制并连接真实 LLM。
它和 `packages/*/tests/` 下的单元测试不同，后者大多会 mock 掉依赖；
这里会完整跑一遍 agent loop，并断言实际调用了哪些工具、最终在磁盘上生成了哪些产物。

## 快速开始

```bash
# 1. 先确保 CLI 已完成构建
pnpm build

# 2. 在 .env（或当前 shell 环境）里至少配置一个 API Key
echo 'DEEPSEEK_API_KEY=sk-...' >> .env

# 3. 运行测试
pnpm test:e2e
```

运行器会自动检测你已配置的 `*_API_KEY`，列出可用模型并让你选择。
默认模型是 `deepseek:deepseek-v4-flash`，优点是便宜且速度快。

## 命令参数

```text
pnpm test:e2e                      # 交互模式（选择模型 + 选择续跑或全量）
pnpm test:e2e --all                # 全量运行所有场景，不再询问
pnpm test:e2e --resume             # 仅运行上次失败或跳过的场景
pnpm test:e2e --filter shell       # 按场景 id 的子串进行筛选
pnpm test:e2e --model sonnet       # 跳过模型选择（可传别名或完整 id）
pnpm test:e2e --list               # 显示场景列表和上次状态
pnpm test:e2e --keep-tmp           # 即使成功也保留临时目录
pnpm test:e2e --print-jsonl        # 每次运行后打印 session jsonl 路径
pnpm test:e2e --max-turns 8        # 限制 agent loop 的最大轮数
```

## 成本

使用 `deepseek-v4-flash` 跑完整套件（23 个场景，每个场景大约 50K-100K tokens），
整轮成本大约是 **$0.10–0.18**。单个场景通常耗时 5–30 秒，
完整一轮大多在 4–8 分钟内完成。

如果你只想验证某一小块改动，可以配合 `--filter` 使用，成本会低很多。

## 从失败处续跑

运行器会在每个场景执行结束后，立刻把结果写入 `.state/last-run.json`，因此：

- 中途按 `Ctrl+C` 是安全的，已经完成的场景会被记录下来。
- 修完代码后执行 `pnpm test:e2e --resume`，只会重跑上次失败的场景，或因为缺少 key 而被跳过的场景。
- 每个失败场景还会把对应的 session jsonl 额外保存到 `.state/failed-<id>.jsonl`，这样即使临时目录被删了，你仍然可以查看模型当时到底做了什么。

## 添加新场景

把一个 `XX-name.ts` 文件放进 `scenarios/` 目录即可。可参考下面这个模板：

```ts
import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '16-my-thing',
  name: '简短描述',
  // 可选门槛：只有当某些 key 存在时才运行
  // requires: (env) => Boolean(env.TAVILY_API_KEY),
  // requiresReason: '请设置 TAVILY_API_KEY 后再启用',
  async run(ctx) {
    await ctx.writeFile('foo.txt', 'hello')
    const r = await ctx.runCli('读取 foo.txt 并输出它的内容', {
      args: ['--trust', '--max-turns', '6'],
    })
    ctx.expect.exitCode(r, 0)
    ctx.expect.toolCalled(r, 'readFile', { filePath: /foo\.txt$/ })
    ctx.expect.assistantMentions(r, 'hello')
  },
}

export default scenario
```

### `ctx` API

| 方法                          | 作用                                                             |
| ----------------------------- | ---------------------------------------------------------------- |
| `ctx.tmpDir`                  | 当前场景临时目录的绝对路径，CLI 会在这里运行。                   |
| `ctx.modelId`                 | 已解析完成的模型 id，例如 `deepseek:deepseek-v4-flash`。         |
| `ctx.writeFile(rel, content)` | 在 tmpDir 中写入文件。                                           |
| `ctx.readFile(rel)`           | 读取文件内容。                                                   |
| `ctx.fileExists(rel)`         | 返回 `Promise<boolean>`，表示文件是否存在。                      |
| `ctx.mkdir(rel)`              | 递归创建目录。                                                   |
| `ctx.runCli(prompt, opts?)`   | 在 tmpDir 中启动 `xc -p <prompt>`，返回 `RunResult`。            |

### `RunResult` shape

```ts
{
  assistantText: string             // 模型最终回复（从 jsonl 中提取）
  toolCalls: ToolCall[]             // 所有 tool-call 事件及其匹配到的结果
  stdout: string; stderr: string
  exitCode: number
  durationMs: number
  sessionJsonlPath: string          // jsonl 路径，便于调试
  tokenUsage?: { input, output, cacheRead, cacheWrite }
}
```

### `ctx.expect` helpers

| 辅助方法                             | 断言内容                                                             |
| ------------------------------------ | -------------------------------------------------------------------- |
| `toolCalled(r, name, inputMatcher?)` | 断言某个工具被调用过，并可选地校验输入是否部分匹配。                 |
| `toolNotCalled(r, name)`             | 断言本次运行中某个工具没有被调用。                                   |
| `assistantMentions(r, needle)`       | 断言最终 assistant 文本包含指定子串或匹配指定正则。                  |
| `exitCode(r, code)`                  | 断言进程以指定退出码结束。                                           |
| `fileExists(rel)`                    | 断言 tmpDir 相对路径下存在某个文件。                                 |
| `fileContent(rel, matcher)`          | 断言文件内容包含指定子串或匹配指定正则。                             |
| `noToolErrors(r)`                    | 断言所有 tool-result 都没有被标记为 `isError: true`。                |
| `truthy(cond, msg)`                  | 通用断言：条件必须为真，并可提供自定义错误信息。                     |

输入匹配器支持字面量、`RegExp`、谓词函数以及嵌套的部分匹配对象。

## 为什么解析 session jsonl，而不是直接看 stdout

打印模式写到 stdout 的只是模型原始文本，不带结构化标记，也没有工具调用边界。
CLI 退出后，我们会去读取 `<tmpDir>/.x-code/sessions/` 下最新的 jsonl，
其中会把 assistant 的每次 tool-call 和 tool-result 都编码成结构化的
`{ t: 'msg', message: {...} }` 记录。这样做对 UI 变化更稳健，也更容易写断言。

如果 jsonl 缺失（例如 CLI 在 `saveSession` 之前就崩溃了），
我们会退回到 stdout 来提取 `assistantText`，至少还能保留一些结果信息。

## 编写稳定场景的建议

1. **优先断言行为，不要过度断言文案**。✅ `toolCalled('writeFile', { filePath: /foo/ })` / ✅ `fileExists('foo.txt')`，尽量不要写成 ❌ `expect(text).toBe('Created foo.')`
2. **对 assistant 文本使用宽松正则**。模型每次措辞可能不同，`/pnpm/i` 会比 `'pnpm@9.0.0'` 更稳。
3. **保持 tmpDir 足够小**。文件越多，上下文越大，速度越慢，花费也越高。
4. **用 `--max-turns` 限制失控循环**。便宜模型在误触发时尤其有用。
5. **可选场景记得设置 `requires:`**。比如网页搜索依赖 Tavily/Brave key，这样缺 key 时不会导致整套测试直接失败。
