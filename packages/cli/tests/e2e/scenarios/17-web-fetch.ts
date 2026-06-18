import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '17-web-fetch',
  name: 'webFetch 工具：抓取一个稳定 URL 并解析页面内容',
  // webFetch 不需要 API Key，但需要能正常访问外部 HTTPS。
  // example.com 自 1992 年起长期稳定在线，且页面内容极短，
  // 几乎任何 HTML → markdown 提取器都能可靠处理。
  // 执行网页抓取场景：验证模型不仅调用工具，还能引用页面里的真实短语。
  async run(ctx) {
    const r = await ctx.runCli(
      '请使用 webFetch 工具抓取 https://example.com/ ，然后用一句简短的话概括页面内容。' +
        '概括中至少要包含一个你在页面上看到的具体短语，并保留原文。',
      { args: ['--max-turns', '4'] },
    )
    ctx.expect.exitCode(r, 0)
    ctx.expect.toolCalled(r, 'webFetch', { url: /example\.com/ })
    // 旧断言 /example|domain|.../ 在 prompt 里就有 "example.com"，模型不用真抓页面
    // 也能蒙混。这里改成 example.com 页面正文里独有的短语 — 凭常识/prompt 都拼不出来。
    // 选 illustrative examples / literature without prior coordination 是因为这两句
    // 1992 年至今稳定，且不是模型预训练里高频泛化的句式。
    ctx.expect.assistantMentions(r, /illustrative examples|literature without prior coordination|may use this domain/i)
    ctx.expect.noToolErrors(r)
  },
}

export default scenario
