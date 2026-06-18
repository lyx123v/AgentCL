// @x-code-cli/core — 插件安装器
//
// 当前支持三种来源：
//
//   - 'local'   本地文件系统目录 → 递归复制到缓存
//                （跳过 .git / node_modules / 系统垃圾文件）
//   - 'git'     任意 git URL     → 浅克隆（depth 1，可选 ref）
//   - 'github'  github:owner/repo → 通过 resolveCloneUrl 做浅克隆
//                支持 Monorepo `subdir`：先浅克隆整个仓库，再把指定子目录
//                复制到新的临时目录，其他内容丢弃
//
// 安装流程：
//   1. 把来源拉取到临时目录
//   2. 发现并解析 manifest（这里会拦截纯 Gemini 来源）
//   3. 计算最终缓存路径：cache/<marketplace>/<plugin>/<version>/
//   4. 清理该路径上已有的安装内容（重装 / 同版本升级）
//   5. 把临时目录移动到最终位置（优先 rename，EXDEV 时回退 copy+rm）
//   6. 追加或更新 installed_plugins.json
//
// AbortSignal 会一路贯穿 git clone（通过 execa 的 `signal`）和递归复制
// 过程（在遍历条目时协作检查），这样长时间安装时按 Esc 能干净地取消。
//
// 缓存按版本号分层是刻意设计的，这样未来 `/plugin update` 可以实现并排
// 安装新版本再原子切换；当前则仍以覆盖同版本安装为主。
import { execa } from 'execa'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { debugLog } from '../utils.js'
import { type ConsentPreview, buildConsentPreview, probePluginRoot } from './consent.js'
import { ManifestParseError, discoverManifest, parseManifest } from './manifest.js'
import { RESERVED_MARKETPLACE_NAMES, readKnownMarketplaces, resolveCloneUrl } from './marketplace.js'
import { installedPluginsPath, pluginCacheDir, pluginCacheParent } from './paths.js'
import type {
  InstalledPluginRecord,
  InstalledPlugins,
  ManifestFormat,
  PluginManifest,
  PluginScope,
  PluginSource,
} from './types.js'
import { type UserConfigValue, setPluginUserConfig } from './user-config.js'

export interface InstallRequest {
  /** 插件来源定义。 */
  source: PluginSource
  /** 插件所属 marketplace。
   *  如果是未关联已订阅 marketplace 的直接 git/local 安装，请使用 `"local"`，
   *  这样最终插件 id 会变成 `<name>@local`。 */
  marketplace: string
  /** 记录安装结果的作用域，也决定哪个 settings.json 的 `enabledPlugins`
   *  会提到它。默认值为 `'user'`。 */
  scope?: PluginScope
  /** 期望的插件名。
   *  如果设置了它，而 manifest 中的 `name` 不匹配，则安装器会中止。
   *  主要用于 marketplace 安装路径，防止条目被伪装。 */
  expectedName?: string
  /** marketplace 条目是否标记为 verified。
   *  该信息会透传给 consent 回调，让用户知道该条目是否经过维护者背书。
   *  它只是元数据，不会自动带来额外信任。 */
  verified?: boolean
  /** manifest 解析完成后、临时目录写入缓存前调用的同意回调。
   *  返回 false 会中止安装，临时目录会被清理，缓存保持不变。
   *  如果不传，则表示无需提示直接安装，常见于测试与 `--yes`。 */
  consent?: (preview: ConsentPreview) => Promise<boolean> | boolean
  /** 当 manifest 声明了 `userConfig` 且用户已通过同意检查后调用的配置收集回调。
   *  调用方（CLI / TUI）负责逐项向用户收集值，通常会对 `sensitive: true`
   *  的字段隐藏输入，最终返回 `{ key: value }` 形式的映射，并通过
   *  user-config.ts 持久化。
   *  返回 `null` 表示中止安装，效果等同于用户拒绝。
   *  如果不传，则跳过该提示；非敏感字段回退到 manifest 默认值，
   *  敏感字段保持未设置，此时插件 hooks / MCP 看到的就是空 env。 */
  userConfigPrompt?: (fields: PluginManifest['userConfig']) => Promise<Record<string, UserConfigValue> | null>
  /** 安装流程使用的取消信号。 */
  signal?: AbortSignal
}

export interface InstallResult {
  /** 最终安装得到的插件 id。 */
  pluginId: string
  /** 插件安装后的根目录。 */
  rootDir: string
  /** 已解析完成的插件 manifest。 */
  manifest: PluginManifest
  /** manifest 文件所属格式。 */
  manifestFormat: ManifestFormat
  /** 写入安装记录后的完整记录对象。 */
  record: InstalledPluginRecord
}

export class InstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InstallError'
  }
}

export async function installPlugin(req: InstallRequest): Promise<InstallResult> {
  // ── 起飞前策略检查（成本低，尽早失败） ──
  // `strictKnownMarketplaces` 和 `blockedPlugins` 来自
  // ~/.x-code/plugins/known_marketplaces.json。管理员
  //（通常是企业环境）一旦开启严格模式，所有安装都必须来自已订阅的
  // marketplace，直接 git / github / local 安装都会被拒绝。
  // `blockedPlugins` 则需要等 manifest 解析完、拿到规范插件 id 后再检查。
  const km = await readKnownMarketplaces()
  if (km.strictKnownMarketplaces) {
    const subscribed = km.marketplaces.some((m) => m.name === req.marketplace)
    if (!subscribed) {
      throw new InstallError(
        `已启用严格 marketplace 模式（known_marketplaces.json:strictKnownMarketplaces=true），` +
          `插件只能从已订阅的 marketplace 安装，但 "${req.marketplace}" 不在订阅列表中。` +
          `请先订阅它（\`xc plugin marketplace add\`），或关闭严格模式。`,
      )
    }
  }

  const tempDir = await fetchToTemp(req.source, req.signal)

  try {
    const discovery = await discoverManifest(tempDir)
    if (!discovery) {
      throw new InstallError(
        '来源中未找到插件 manifest（已检查 .x-code-plugin/plugin.json、.claude-plugin/plugin.json、plugin.json）',
      )
    }
    if (discovery.format === 'gemini') {
      throw new InstallError(
        '这是一个 Gemini 扩展（检测到 gemini-extension.json），x-code-cli 暂不支持 Gemini 扩展，详见 docs/plugins.md',
      )
    }

    let manifest: PluginManifest
    try {
      manifest = await parseManifest(discovery.manifestPath)
    } catch (err) {
      if (err instanceof ManifestParseError) throw new InstallError(err.message)
      throw err
    }

    if (req.expectedName && manifest.name !== req.expectedName) {
      throw new InstallError(`manifest 名称 "${manifest.name}" 与预期值 "${req.expectedName}" 不一致`)
    }

    // 现在我们已经知道规范插件 id，可以执行第二轮策略检查：
    // known_marketplaces.json 里的 blockedPlugins。
    // 这是管理员风格的强制封禁列表，被命中的插件无论来自哪个 marketplace、
    // 用户是否同意安装，都会被直接拒绝。
    // 支持两种匹配形式：
    //   - 完整 id `name@marketplace`：精确封禁某一个 marketplace 变体
    //   - 裸名字 `name`：广义封禁该名字在所有 marketplace 下的变体
    const earlyId = `${manifest.name}@${req.marketplace}`
    const blocked = km.blockedPlugins?.find((b) => b === earlyId || b === manifest.name)
    if (blocked) {
      throw new InstallError(
        `插件 "${earlyId}" 命中了 known_marketplaces.json 中的 blockedPlugins 列表` +
          `（匹配项："${blocked}"），请先将它从封禁列表移除，或改用其他插件再安装。`,
      )
    }

    // ── 用户同意关口 ──
    // 预览信息建立在已解析 manifest 之上，调用方可以据此向用户展示
    // 这个插件会贡献什么（hooks、mcp、作用域等），并显式征求同意。
    // 不传回调表示有意跳过提示，常见于非交互路径；CLI 的 `--yes`
    // 就是通过不传 `consent` 来实现。
    if (req.consent) {
      const rootProbe = await probePluginRoot(tempDir)
      const preview = buildConsentPreview({
        pluginId: `${manifest.name}@${req.marketplace}`,
        manifest,
        source: req.source,
        marketplace: req.marketplace,
        verified: req.verified,
        fromReservedMarketplace: req.marketplace in RESERVED_MARKETPLACE_NAMES,
        rootProbe,
      })
      const accepted = await req.consent(preview)
      if (!accepted) {
        throw new InstallError('安装已取消（用户未同意继续）')
      }
    }

    // ── userConfig 收集（同意之后，真正落盘之前） ──
    // 只有 manifest 声明了 userConfig，且调用方接入了提示回调时才会执行。
    // 非交互路径（--yes、CI）会跳过该步骤，此时字段保持未设置，
    // 插件在 hook / mcp 启动时看到的是空 env，与功能加入前一致。
    // 如果回调返回 null，则中止安装，语义上等同于用户拒绝继续。
    if (manifest.userConfig && manifest.userConfig.length > 0 && req.userConfigPrompt) {
      const collected = await req.userConfigPrompt(manifest.userConfig)
      if (collected === null) {
        throw new InstallError('安装已取消（userConfig 收集流程被中止）')
      }
      // 必须先持久化，再移动临时目录到缓存。这样如果两阶段之间进程崩溃，
      // 用户不会留下一个半安装插件，也不会残留孤儿密钥。
      // 配置文件以 plugin id 为键，重装时可以自然覆盖。
      const pluginIdForConfig = `${manifest.name}@${req.marketplace}`
      await setPluginUserConfig(pluginIdForConfig, collected)
    }

    const finalDir = pluginCacheDir(req.marketplace, manifest.name, manifest.version)

    // 同版本重装时，必须先删旧安装。否则一旦新版本删掉了某个旧文件，
    // 缓存目录里就会出现“新旧文件混杂”的脏状态。
    await fs.rm(finalDir, { recursive: true, force: true })
    await fs.mkdir(path.dirname(finalDir), { recursive: true })
    await moveOrCopy(tempDir, finalDir, req.signal)

    const pluginId = `${manifest.name}@${req.marketplace}`
    const record: InstalledPluginRecord = {
      id: pluginId,
      name: manifest.name,
      marketplace: req.marketplace,
      version: manifest.version,
      source: req.source,
      installedAt: new Date().toISOString(),
      installScope: req.scope ?? 'user',
    }
    await recordInstallation(record)

    return { pluginId, rootDir: finalDir, manifest, manifestFormat: discovery.format, record }
  } catch (err) {
    // 安装过程中只要中途失败，就尽力清理临时目录。
    // 如果 moveOrCopy 已成功，临时目录其实已经被 rename 走了，因此这里只会
    // 发生在“移动之前就出了问题”的场景。
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {
      /* 这里已经没有更有价值的补救动作了 */
    })
    if (err instanceof InstallError || err instanceof ManifestParseError) throw err
    throw new InstallError(err instanceof Error ? err.message : String(err))
  }
}

// ── 来源拉取到临时目录 ──────────────────────────────────────────────────

/** 把插件来源获取到一个临时目录中，供后续解析与安装流程继续处理。 */
async function fetchToTemp(source: PluginSource, signal?: AbortSignal): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-plugin-install-'))

  if (source.kind === 'local') {
    const resolved = path.resolve(source.path)
    const stat = await fs.stat(resolved).catch(() => null)
    if (!stat || !stat.isDirectory()) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      // 错误里带上 cwd，便于理解相对路径究竟是按哪里解析的。
      // 特别是在通过 `pnpm dev` 启动 xc 时，cwd 可能是 `packages/cli/`
      // 而不是仓库根目录，用户在 slash command 里输入 `./foo` 时很容易困惑。
      // 同时展示解析后的绝对路径和 cwd，原因就会非常直观。
      const isRelative = !path.isAbsolute(source.path)
      const cwdHint = isRelative ? `（按当前 cwd 解析：${process.cwd()}）` : ''
      throw new InstallError(`本地来源不是目录：${resolved}${cwdHint}`)
    }
    await copyDirFiltered(resolved, tempDir, signal)
    return tempDir
  }

  if (source.kind === 'git' || source.kind === 'github') {
    const cloneUrl = source.kind === 'git' ? source.url : resolveCloneUrl(`github:${source.owner}/${source.repo}`)
    const args = ['clone', '--depth', '1']
    if (source.ref) args.push('--branch', source.ref)
    // 即便只安装 subdir，这里依然先浅克隆整个仓库。
    // 真正的 sparse-checkout 在超大 monorepo 上会更快，但
    // `--depth 1 --filter=blob:none --sparse` 这套组合在不同 git 版本里
    // 稳定性一般；而 depth-1 克隆即使面对较大的 monorepo，通常也在
    // 100 MB 以内。等它真的成为痛点时再优化。
    args.push(cloneUrl, tempDir)

    try {
      await execa('git', args, { signal, stdio: 'pipe' })
    } catch (err) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      throw new InstallError(`git 克隆失败：${err instanceof Error ? err.message : String(err)}`)
    }

    // 完整性校验：如果 marketplace.json 固定了 `sha`，就验证实际克隆到的
    // commit 是否匹配。这样可以防止 marketplace 审核后到终端用户安装前
    // 这段时间里，上游 ref 被强推，或仓库遭到供应链篡改。
    // 这一步必须放在删除 `.git` 之前，因为 `rev-parse` 需要仓库元数据。
    //
    // 这里允许前缀匹配：声明的 sha 可以是短 sha（至少 7 位十六进制），
    // 只要是最终 40 位 HEAD 的前缀即可，容忍度与 `git checkout <short-sha>`
    // 保持一致，也符合真实 marketplace 的产物形态。
    //
    // 为什么这里直接硬失败而不是只告警：sha 不匹配本质上不是作者配置错了，
    // 就是实打实的供应链异常。无论哪种，用户都不应该在本地落下一份
    // 未审查代码，因此宁可给出醒目的错误，也不能静默安装当前 HEAD。
    if (source.expectedSha) {
      try {
        const result = await execa('git', ['rev-parse', 'HEAD'], { cwd: tempDir, stdio: 'pipe', signal })
        const actualSha = result.stdout.trim().toLowerCase()
        const expected = source.expectedSha.toLowerCase()
        if (!actualSha.startsWith(expected)) {
          await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
          throw new InstallError(
            `${cloneUrl}${source.ref ? `@${source.ref}` : ''} 的 sha 完整性校验失败：` +
              `marketplace.json 声明的 sha=${expected}，实际 HEAD=${actualSha}。` +
              `这可能表示上游 ref 被强推，或仓库已遭到篡改。` +
              `请联系 marketplace 作者，或改为固定到其他版本。`,
          )
        }
      } catch (err) {
        if (err instanceof InstallError) throw err
        // rev-parse 失败（理论上在刚克隆的仓库里不应发生），这里统一按
        // 完整性校验失败处理，避免静默安装未经校验的内容。
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
        throw new InstallError(
          `无法校验 ${cloneUrl} 的 sha：${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    // 安装完成后不再需要 .git 目录，而且对历史较长的仓库来说它会显著膨胀缓存。
    await fs.rm(path.join(tempDir, '.git'), { recursive: true, force: true }).catch(() => {})

    // 处理 subdir：真正的插件内容位于 <tempDir>/<subdir>。
    // 这里会重新整理一次临时目录，让后续安装流程（manifest 探测 +
    // moveOrCopy 到缓存）只面对该子目录本身。最简单的办法就是把子目录
    // 复制到新的临时目录，再丢弃原始克隆。
    const subdir = source.subdir
    if (subdir) {
      const subdirPath = path.join(tempDir, subdir)
      const stat = await fs.stat(subdirPath).catch(() => null)
      if (!stat || !stat.isDirectory()) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
        throw new InstallError(`在克隆仓库 ${cloneUrl} 中未找到子目录 "${subdir}"`)
      }
      const subdirTemp = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-plugin-subdir-'))
      try {
        await copyDirFiltered(subdirPath, subdirTemp, signal)
      } catch (err) {
        await fs.rm(subdirTemp, { recursive: true, force: true }).catch(() => {})
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
        throw new InstallError(`提取子目录失败：${err instanceof Error ? err.message : String(err)}`)
      }
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      return subdirTemp
    }
    return tempDir
  }

  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  throw new InstallError(`未知的来源类型：${(source as PluginSource).kind}`)
}

/** 永远不会被复制进缓存的目录/文件名集合。
 *  之所以排除 `node_modules`，是因为带依赖的插件应当在用户机器上自行重装；
 *  如果未来真有插件必须原样携带 node_modules，再重新评估。 */
const COPY_SKIP = new Set(['.git', 'node_modules', '.DS_Store', 'Thumbs.db'])

/** 递归复制目录，同时按规则过滤不应进入缓存的文件。 */
async function copyDirFiltered(src: string, dst: string, signal?: AbortSignal, root?: string): Promise<void> {
  // `root` 会在第一次（非递归）调用时固定下来，下面做符号链接逃逸检查时
  // 就能始终以原始插件根目录为边界，而不是误用当前递归层级的 `src`。
  const rootDir = root ?? src
  await fs.mkdir(dst, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    signal?.throwIfAborted()
    if (COPY_SKIP.has(entry.name)) continue
    const s = path.join(src, entry.name)
    const d = path.join(dst, entry.name)
    if (entry.isDirectory()) {
      await copyDirFiltered(s, d, signal, rootDir)
    } else if (entry.isFile()) {
      await fs.copyFile(s, d)
    } else if (entry.isSymbolicLink()) {
      // 先按其所在目录解析符号链接目标。
      // 如果解析后跳出了插件源根目录，就直接丢弃该链接而不是保留：
      // 在 POSIX 上，插件里若有 `evil -> /etc/passwd` 这样的链接，
      // 运行时 loader / hooks 解引用时就会碰到宿主机文件；在 Windows 上，
      // 下面的回退逻辑甚至可能把宿主机等价文件直接复制进缓存。
      // 这里不会进一步追踪目标是否真实存在，因为“范围内但已损坏”的链接
      // 依然是安全可保留的。
      const target = await fs.readlink(s)
      const resolved = path.resolve(path.dirname(s), target)
      const rel = path.relative(rootDir, resolved)
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
        debugLog('plugins.copy-symlink-escape', `${s} -> ${target} (resolved ${resolved}, outside ${rootDir})`)
        continue
      }
      try {
        await fs.symlink(target, d)
      } catch {
        // Windows 如果没有创建符号链接权限，则回退为复制目标文件。
        // 这里只做尽力而为，损坏链接复制失败时就直接丢弃。
        await fs.copyFile(s, d).catch(() => {})
      }
    }
  }
}

/** 把目录从临时位置移动到最终位置。
 *  如果源和目标在同一文件系统上，rename 既原子又高效；否则
 * （Windows 上常见 EXDEV）会回退为 copy + rm。 */
async function moveOrCopy(src: string, dst: string, signal?: AbortSignal): Promise<void> {
  try {
    await fs.rename(src, dst)
    return
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'ENOTEMPTY') {
      // 直接把原始错误往外抛会让一些暂时性怪问题阻塞安装，而下面的复制回退
      // 在我们见过的大多数实际场景里都能成功，因此这里优先降级处理。
      // 同时仍然打日志，方便事后排查。
      debugLog('plugins.install-rename-fallback', String(err))
    }
  }
  await copyDirFiltered(src, dst, signal)
  await fs.rm(src, { recursive: true, force: true }).catch(() => {})
}

// ── installed_plugins.json 读写维护 ────────────────────────────────────

/** 读取已安装插件清单文件；若文件不存在或损坏，则返回空清单。 */
async function readInstalledPlugins(): Promise<InstalledPlugins> {
  const file = installedPluginsPath()
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(raw) as InstalledPlugins
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.plugins)) {
      return { schemaVersion: '1', plugins: [] }
    }
    return { schemaVersion: parsed.schemaVersion ?? '1', plugins: parsed.plugins }
  } catch {
    return { schemaVersion: '1', plugins: [] }
  }
}

/** 把已安装插件清单完整写回磁盘。 */
async function writeInstalledPlugins(data: InstalledPlugins): Promise<void> {
  const file = installedPluginsPath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

/** 将单个安装记录写入清单，若已存在同 id 条目则覆盖。 */
async function recordInstallation(record: InstalledPluginRecord): Promise<void> {
  const data = await readInstalledPlugins()
  const idx = data.plugins.findIndex((p) => p.id === record.id)
  if (idx >= 0) data.plugins[idx] = record
  else data.plugins.push(record)
  await writeInstalledPlugins(data)
}

/** 列出当前记录中的全部已安装插件。 */
export async function listInstalledPlugins(): Promise<InstalledPluginRecord[]> {
  const data = await readInstalledPlugins()
  return data.plugins
}

/** 按插件 id 查找单个安装记录。 */
export async function findInstalledPlugin(id: string): Promise<InstalledPluginRecord | undefined> {
  const data = await readInstalledPlugins()
  return data.plugins.find((p) => p.id === id)
}

// ── 卸载 ───────────────────────────────────────────────────────────────

export interface UninstallResult {
  /** 从缓存中删除掉的版本号列表；若插件原本就未缓存，则为空。 */
  removedVersions: string[]
  /** 是否成功移除了 installed_plugins.json 中的记录。 */
  removedRecord: boolean
}

/** 删除某个插件在缓存中的所有版本，并移除其 installed_plugins.json 记录。
 *  会保留数据目录 `~/.x-code/plugins/data/<id>/`，以免用户未来重装时丢失
 *  插件状态数据。 */
export async function uninstallPlugin(id: string): Promise<UninstallResult> {
  const record = await findInstalledPlugin(id)
  const result: UninstallResult = { removedVersions: [], removedRecord: false }

  if (record) {
    const parent = pluginCacheParent(record.marketplace, record.name)
    try {
      const versions = await fs.readdir(parent)
      result.removedVersions = versions
      await fs.rm(parent, { recursive: true, force: true })
    } catch {
      // 没有缓存条目时，说明记录可能已经过期；后续仍会继续尝试删除记录本身。
    }
  }

  const data = await readInstalledPlugins()
  const before = data.plugins.length
  data.plugins = data.plugins.filter((p) => p.id !== id)
  if (data.plugins.length !== before) {
    await writeInstalledPlugins(data)
    result.removedRecord = true
  }

  return result
}
