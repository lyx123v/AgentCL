// @x-code-cli/core — listDir 工具
import fs from 'node:fs/promises'

import { tool } from 'ai'

import { z } from 'zod'

import { formatToolError } from '../utils/tool-errors.js'
import { reportProgress } from './progress.js'

export const listDir = tool({
  description: '列出目录内容。返回的名称会带上类型标记（目录会以 `/` 结尾）。',
  inputSchema: z.object({
    dirPath: z.string().describe('目录的绝对路径'),
  }),
  /** 读取指定目录并返回可读的条目列表。 */
  execute: async ({ dirPath }, { toolCallId }) => {
    try {
      reportProgress(toolCallId, `正在列出 ${dirPath}`)
      const entries = await fs.readdir(dirPath, { withFileTypes: true })
      const lines = entries.map((e) => {
        const suffix = e.isDirectory() ? '/' : ''
        return `${e.name}${suffix}`
      })
      return lines.join('\n') || '（空目录）'
    } catch (err) {
      return formatToolError('列出目录', err)
    }
  },
})
