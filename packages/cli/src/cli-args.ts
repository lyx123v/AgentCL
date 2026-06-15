// @x-code-cli/cli - `xc` CLI 的 yargs 参数定义。
//
// 这里和入口文件拆开，是为了避免一长串选项（8-10 个标志位再加上 version/help
// 的别名）把 index.ts 里的启动编排挤得太乱。
// `Argv` 的形状完全交给下面这条 option 链由 yargs 推导；
// 我们故意不显式写死，这样在一个地方新增或重命名标志位时，使用方类型会自动更新。
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'

import { VERSION } from './version.js'

export async function parseCliArgs() {
  return yargs(hideBin(process.argv))
    .scriptName('x-code')
    .usage('$0 [options] [prompt]')
    .option('model', {
      alias: 'm',
      type: 'string',
      describe: 'Model to use (e.g. sonnet, deepseek, openai:gpt-5.5)',
    })
    .option('trust', {
      alias: 't',
      type: 'boolean',
      default: false,
      describe: 'Trust mode: skip write operation confirmations',
    })
    .option('print', {
      alias: 'p',
      type: 'boolean',
      default: false,
      describe: 'Non-interactive mode: output result and exit',
    })
    .option('max-turns', {
      type: 'number',
      // 不设默认值——交互模式本来就不该有上限（用户按 Esc 停止）。
      // 只有在需要强制限制时才传值；这在 `--print` 里最有用，因为那时没有人手动中止。
      describe: 'Cap on agent loop iterations per submission (default: unlimited)',
    })
    .option('plan', {
      type: 'boolean',
      default: false,
      // 不加短别名——`-p` 已经被 `--print` 占了。
      // plan 模式会把模型限制在只读探索 + 计划文件，直到用户批准为止。
      describe: 'Start the session in plan mode (read-only exploration; user must approve before code edits)',
    })
    .option('plugins', {
      type: 'boolean',
      default: true,
      // 这里声明为正向的 `--plugins`（默认开启），这样 yargs 会自动派生出
      // `--no-plugins` 这个否定写法。
      // 这个标志是排障用的逃生口：如果怀疑某个插件行为异常
      //（坏掉的 skill、失控的 hook 等）就是问题根源，`--no-plugins`
      // 会直接跳过 loadAllPlugins，只保留内建贡献。
      describe: 'Enable plugin discovery (default true). `--no-plugins` to disable for one session.',
    })
    .option('hooks', {
      type: 'boolean',
      default: true,
      // 和 `--plugins` 一样采用 `--no-hooks` 的否定写法。
      // 插件仍然会加载（skills / agents / mcp 贡献都会注册），
      // 只是跳过 hook 子系统——改接 `emptyHookBus()`，而不是集成层构建出来的 bus。
      // 适合怀疑有慢 hook / 跑飞 hook 时使用，同时又不想丢掉插件的其他内容。
      describe: 'Enable plugin hooks (default true). `--no-hooks` to skip hook execution for one session.',
    })
    .option('plugin-debug', {
      type: 'boolean',
      default: false,
      // 面向 plugin / hook / marketplace 活动的定向调试输出。
      // 它会把对应的 debugLog() 记录除了写入日志文件之外，
      // 也同步镜像到 stderr，这样就不用 tail ~/.x-code/logs/ 也能实时看到。
      // 等价于设置 `XC_PLUGIN_DEBUG=1`。不会改变行为，只是改变这些线索写到哪里。
      describe: 'Mirror plugin / hook / marketplace debug breadcrumbs to stderr (also XC_PLUGIN_DEBUG=1).',
    })
    .option('continue', {
      alias: 'c',
      type: 'boolean',
      default: false,
      describe: 'Resume the most recent session in this project (no picker)',
    })
    .option('resume', {
      alias: 'r',
      type: 'string',
      // 可选参数：`xc --resume`（不带值）会打开选择器；
      // `xc --resume <id-or-slug>` 则直接跳到文件名匹配的会话。
      // yargs 会把它当成字符串类型标志，所以 `argv.resume === undefined`
      // 表示“根本没传这个标志”，`''` 表示“传了但没带值”，
      // 其他字符串就是用户的查找 key。
      describe: 'Resume a session: `--resume` opens the picker; `--resume <id>` jumps directly',
    })
    .version(VERSION)
    .alias('v', 'version')
    .help()
    .alias('h', 'help')
    .parse()
}
