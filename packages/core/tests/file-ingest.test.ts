import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  MAX_INGEST_BYTES,
  buildUserContent,
  classifyFile,
  extractFileReferences,
  ingestFile,
} from '../src/agent/file-ingest.js'
import { captionImage, pickVisionProvider } from '../src/agent/vision-fallback.js'

// 模拟 vision-fallback，让图片路径测试可以验证 onNotice 这条链路
// 会带着正确的 provider id 触发，同时不需要真的调用 Gemini/GLM API。
// pickVisionProvider 默认返回 null，对应“未配置 key”的场景，
// 这也与现有测试依赖保持一致；需要启用视觉子代理的测试会自行 mockReturnValue。
vi.mock('../src/agent/vision-fallback.js', () => ({
  pickVisionProvider: vi.fn(() => null),
  captionImage: vi.fn(),
}))

// 模拟 tesseract，避免 OCR 回退路径在测试图片上真的拉起 worker 线程。
// 否则当子代理测试强制让 captionImage reject 时，ingestFile 会继续落到 ocrImage()，
// 然后在不可解码输入上把 worker 弄崩，并把未处理异常泄漏给测试运行器。
// 这里返回可预测的桩值，就能让断言专注在 notice 和调用链行为上。
vi.mock('tesseract.js', () => ({
  createWorker: vi.fn(async () => ({
    recognize: vi.fn(async () => ({ data: { text: '' } })),
    terminate: vi.fn(async () => {}),
  })),
}))

let tmpDir: string
let textFile: string
let jsonFile: string
let imageFile: string

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xcc-ingest-'))
  textFile = path.join(tmpDir, 'hello.md')
  jsonFile = path.join(tmpDir, 'data.json')
  imageFile = path.join(tmpDir, 'fake.png')
  await fs.writeFile(textFile, '# Hello\nLine 2')
  await fs.writeFile(jsonFile, '{"ok":true}')
  // 空文件没关系：classifyFile 会按扩展名识别成 .png，
  // 而被 mock 的 captionImage 根本不会读取字节。
  // ingestFile 只有在多模态 provider 路径下才会真正读取 buffer，这里不会走到。
  await fs.writeFile(imageFile, '')
})

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('extractFileReferences', () => {
  it('能识别 POSIX 绝对路径形式的 @ 引用', () => {
    const refs = extractFileReferences('check @/tmp/report.md please')
    expect(refs).toHaveLength(1)
    expect(refs[0]?.raw).toBe('@/tmp/report.md')
  })

  it('能识别 Windows 绝对路径形式的 @ 引用', () => {
    const refs = extractFileReferences('看看 @D:\\res\\x-code-cli\\CHANGELOG.md')
    expect(refs).toHaveLength(1)
    expect(refs[0]?.raw).toBe('@D:\\res\\x-code-cli\\CHANGELOG.md')
  })

  it('能识别带扩展名的裸绝对路径', () => {
    const refs = extractFileReferences('summarize /home/me/report.pdf today')
    expect(refs).toHaveLength(1)
  })

  it('会对重复引用去重', () => {
    const refs = extractFileReferences('@/a/b.md vs @/a/b.md')
    expect(refs).toHaveLength(1)
  })
})

describe('classifyFile', () => {
  it('会把 markdown 识别为文本', async () => {
    expect(await classifyFile(textFile)).toBe('text')
  })

  it('会把 json 识别为文本', async () => {
    expect(await classifyFile(jsonFile)).toBe('text')
  })

  it('会根据扩展名把 .png 识别为图片', async () => {
    // 这里不要求文件真实存在，因为只检查扩展名。
    expect(await classifyFile('/does/not/exist.png')).toBe('image')
  })

  it('会根据扩展名把 .pdf 识别为 pdf', async () => {
    expect(await classifyFile('/does/not/exist.pdf')).toBe('pdf')
  })

  it('会根据扩展名把 .docx 识别为 office 文件', async () => {
    expect(await classifyFile('/does/not/exist.docx')).toBe('office')
  })
})

describe('ingestFile', () => {
  const multimodalCaps = { image: true, pdf: true, filesApi: true }
  const textOnlyCaps = { image: false, pdf: false, filesApi: false }

  it('对任意 provider 都会内联文本文件', async () => {
    const parts = await ingestFile({ raw: `@${textFile}`, absolutePath: textFile }, textOnlyCaps)
    expect(parts).toHaveLength(1)
    expect(parts[0]?.type).toBe('text')
    if (parts[0]?.type === 'text') {
      expect(parts[0].text).toContain('Hello')
      expect(parts[0].text).toContain(textFile)
    }
  })

  it('文件缺失时会返回错误文本 part', async () => {
    const missing = path.join(tmpDir, 'missing.md')
    const parts = await ingestFile({ raw: `@${missing}`, absolutePath: missing }, multimodalCaps)
    expect(parts).toHaveLength(1)
    expect(parts[0]?.type).toBe('text')
    if (parts[0]?.type === 'text') {
      expect(parts[0].text).toMatch(/Cannot read/i)
    }
  })

  // 回归说明：以前多 MB 的 @path 附件会被原样内联，
  // 导致首轮对话还没开始，用户消息就已经把模型上下文窗口撑爆。
  // 现在这里会换成一条简短提示，引导模型使用带 offset/limit 的 readFile 工具。
  it('超大的文本文件会被替换成 readFile 使用提示', async () => {
    const big = path.join(tmpDir, 'big.txt')
    await fs.writeFile(big, 'x'.repeat(MAX_INGEST_BYTES + 1))
    try {
      const parts = await ingestFile({ raw: `@${big}`, absolutePath: big }, multimodalCaps)
      expect(parts).toHaveLength(1)
      expect(parts[0]?.type).toBe('text')
      if (parts[0]?.type === 'text') {
        expect(parts[0].text).toMatch(/too large to inline/i)
        expect(parts[0].text).toMatch(/readFile/)
        expect(parts[0].text).not.toContain('xxxxxxxxxx')
      }
    } finally {
      await fs.rm(big, { force: true })
    }
  })
})

describe('buildUserContent', () => {
  it('没有文件引用时会走字符串快速路径', async () => {
    const result = await buildUserContent('hello world', {
      image: true,
      pdf: true,
      filesApi: true,
    })
    expect(result).toBe('hello world')
  })

  it('会把摄取后的 part 拼接到原始用户文本之后', async () => {
    const input = `please read @${textFile}`
    const result = await buildUserContent(input, {
      image: true,
      pdf: true,
      filesApi: true,
    })
    expect(Array.isArray(result)).toBe(true)
    if (!Array.isArray(result)) return
    expect(result[0]).toEqual({ type: 'text', text: input })
    expect(result.length).toBeGreaterThan(1)
  })
})

describe('ingestFile 图片路径与模拟视觉子代理', () => {
  const textOnlyCaps = { image: false, pdf: false, filesApi: false }

  beforeEach(() => {
    vi.mocked(pickVisionProvider).mockReset()
    vi.mocked(captionImage).mockReset()
  })

  it('会用选中的子代理 id 触发 onNotice，并内联图片描述', async () => {
    // 模拟一个“主模型是 DeepSeek（纯文本）但环境里同时有 Google key”的用户：
    // picker 会选中 Gemini，captionImage 产出描述文本，
    // 最终生成的 TextPart 既要向 UI 抛出 notice，也要把描述文字和 provider 标识
    // 一并嵌进模型真正能看到的内容里。
    vi.mocked(pickVisionProvider).mockReturnValue({
      provider: 'google',
      modelId: 'google:gemini-2.5-flash',
      label: 'Gemini 2.5 Flash',
    })
    vi.mocked(captionImage).mockResolvedValue('A red Submit button on a white card')

    const notices: string[] = []
    const parts = await ingestFile({ raw: `@${imageFile}`, absolutePath: imageFile }, textOnlyCaps, (msg) =>
      notices.push(msg),
    )

    expect(notices).toEqual(['Captioned image via google:gemini-2.5-flash'])
    expect(captionImage).toHaveBeenCalledTimes(1)
    expect(parts).toHaveLength(1)
    expect(parts[0]?.type).toBe('text')
    if (parts[0]?.type === 'text') {
      expect(parts[0].text).toContain('A red Submit button on a white card')
      expect(parts[0].text).toContain('via="google:gemini-2.5-flash"')
      expect(parts[0].text).toContain('kind="image-caption"')
    }
  })

  it('子代理抛错时会回退，并通过 notice 暴露失败原因', async () => {
    // 当 captionImage reject（比如限流、网络错误、错误 key）时，
    // ingestFile 必须做到两点：
    // 1. 发出 “failed, falling back to OCR” 之类的 notice，让用户知道发生了什么。
    // 2. 不能悄悄吞掉这次尝试，然后直接返回多模态图片路径。
    // 这里通过断言 notice 来在 OCR 之前短路，因为在空文件上跑真实 OCR
    // 会让 worker 线程不稳定。
    vi.mocked(pickVisionProvider).mockReturnValue({
      provider: 'zhipu',
      modelId: 'zhipu:glm-4v-flash',
      label: 'GLM-4V Flash',
    })
    vi.mocked(captionImage).mockRejectedValue(new Error('rate limit exceeded'))

    const notices: string[] = []
    await ingestFile({ raw: `@${imageFile}`, absolutePath: imageFile }, textOnlyCaps, (msg) => notices.push(msg))

    expect(captionImage).toHaveBeenCalledTimes(1)
    // 这里要同时满足两点：失败已经被上报，而且 notice 里包含所选子代理的标签，
    // 让用户知道到底是谁尝试过、又是在哪里失败的。
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('GLM-4V Flash')
    expect(notices[0]).toContain('rate limit exceeded')
    expect(notices[0]).toContain('falling back to OCR')
  })
})
