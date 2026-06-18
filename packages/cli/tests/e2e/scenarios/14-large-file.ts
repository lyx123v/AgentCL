import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '14-large-file',
  name: '大文件 readFile：head 截断后模型按 hint 二次调用拉尾部',
  // 执行大文件读取场景：构造超大文件，并验证模型会按提示再次读取尾部内容。
  async run(ctx) {
    // 生成 5000 行文件，远超 LARGE_FILE_LINE_THRESHOLD=2000。
    // readFile 默认只返回 head（前 2000 行），随后给出一条 hint：
    //   "showing first 2000/5000 lines. Call readFile again with offset/limit..."
    // 模型必须按 hint 再调一次 readFile 才能看到尾部。
    const lines: string[] = []
    for (let i = 1; i <= 5000; i++) {
      lines.push(`line ${i}: lorem ipsum dolor sit amet`)
    }
    // 关键标记放在尾部。前 4999 行模式完全一致 — 一个偷懒的模型只看 head
    // 就会"按模式外推"答 `lorem ipsum dolor sit amet`（deepseek-v4-flash 实测会）；
    // 只有真的二次调 readFile(offset≈5000) 拿到尾部才能引用出这个 token。
    lines[4999] = 'line 5000: FINAL_SENTINEL_TOKEN_XYZ'
    await ctx.writeFile('big.txt', lines.join('\n'))

    const r = await ctx.runCli(
      '请使用 readFile 工具读取 big.txt。由于文件很大，第一次调用会被截断，工具结果也会明确告诉你。' +
        '出现这种情况后，你必须再次调用 readFile，并通过 offset/limit 读取文件的最后一行。' +
        '不要猜测，也不要根据前面行的模式去外推。最后请在最终回答里逐字引用该文件的最后一行。',
      { args: ['--max-turns', '6'] },
    )
    ctx.expect.exitCode(r, 0)
    // 至少要有两次 readFile 调用：第一次拿 head，第二次按 hint 拉尾部
    const readCalls = r.toolCalls.filter(
      (tc) => tc.toolName === 'readFile' && /big\.txt$/.test(String(tc.input.filePath)),
    )
    ctx.expect.truthy(
      readCalls.length >= 2,
      `expected ≥2 readFile calls on big.txt (head + tail via offset), got ${readCalls.length}`,
    )
    // 至少一次带 offset — 证明模型真的按 hint 跳到了别的位置，不是反复读 head
    const hasOffsetCall = readCalls.some((tc) => tc.input.offset != null)
    ctx.expect.truthy(
      hasOffsetCall,
      `期望至少有一次 readFile 调用设置了 offset；实际输入为：${readCalls.map((c) => JSON.stringify(c.input)).join(', ')}`,
    )
    ctx.expect.noToolErrors(r)
    // 核心：尾部 token 只能从二次读拿到，凭模式外推拼不出。
    ctx.expect.assistantMentions(r, /FINAL_SENTINEL_TOKEN_XYZ/)
    // 顺手守住：loop 没冒出 orphan tool_call 报错
    ctx.expect.truthy(
      !r.stderr.toLowerCase().includes('tool_use without tool_result'),
      'stderr 中出现了孤立 tool_call 的报错：' + r.stderr.slice(0, 300),
    )
  },
}

export default scenario
