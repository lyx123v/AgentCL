import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '15-web-search',
  name: 'webSearch 工具：搜索外部主题（需要 TAVILY_API_KEY 或 BRAVE_API_KEY）',
  // 仅在配置了 webSearch 所需的 API Key 时才运行该场景。
  requires: (env) => Boolean(env.TAVILY_API_KEY || env.BRAVE_API_KEY),
  requiresReason: '需要设置 TAVILY_API_KEY 或 BRAVE_API_KEY 才能启用',
  // 执行网页搜索场景：验证模型会真正搜索 prompt caching 的官方文档地址。
  async run(ctx) {
    const r = await ctx.runCli(
      '请使用 webSearch 工具查找 Anthropic 官方文档中关于 prompt caching 的页面 URL，' +
        '然后在最终回答中给出这个 URL，并说明它与 prompt caching 有关。',
      { args: ['--max-turns', '6'] },
    )
    ctx.expect.exitCode(r, 0)
    // 查询词必须真的跟 prompt caching 相关 — 旧版任何 query 都算过，
    // 模型可以搜一个无关词再"凭常识"答出 anthropic.com 蒙混。
    ctx.expect.toolCalled(r, 'webSearch', { query: /(prompt[- ]?caching|cache)/i })
    // 旧断言 /anthropic\.com/i 是常识级答案 — 模型不搜也能脱口而出。
    // 改成 docs.anthropic.com 这个具体子域 — 没真搜过比较难精确说出来，
    // 同时叠加一条 prompt-caching 相关词，把"答非所问还能过"的路径堵死。
    ctx.expect.assistantMentions(r, /docs\.anthropic\.com/i)
    ctx.expect.assistantMentions(r, /prompt[- ]?cach/i)
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
