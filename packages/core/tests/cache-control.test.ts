// providers/cache-control.ts 的测试。
import { describe, expect, it } from 'vitest'

import type { ModelMessage } from 'ai'

import { applyCacheControl } from '../src/providers/cache-control.js'

// 构造一个最小化消息对象，方便复用测试数据。
function msg(role: 'user' | 'assistant', text: string): ModelMessage {
  return { role, content: text } as ModelMessage
}

describe('applyCacheControl', () => {
  const baseMessages: ModelMessage[] = [msg('user', 'first'), msg('assistant', 'response'), msg('user', 'second')]

  describe('anthropic', () => {
    it('会把 system prompt 折叠进 messages，并附带 cache_control', () => {
      const out = applyCacheControl({
        system: 'you are helpful',
        messages: baseMessages,
        modelId: 'anthropic:claude-opus-4-7',
        sessionId: 'abc',
      })
      expect(out.system).toBeUndefined()
      expect(out.messages[0].role).toBe('system')
      expect(out.messages[0].content).toBe('you are helpful')
      const sysOpts = (out.messages[0] as { providerOptions?: { anthropic?: { cacheControl?: { type: string } } } })
        .providerOptions?.anthropic?.cacheControl
      expect(sysOpts?.type).toBe('ephemeral')
    })

    it('会给最后两条非 system 消息打上 cache_control', () => {
      const out = applyCacheControl({
        system: 'sys',
        messages: baseMessages,
        modelId: 'anthropic:claude-sonnet-4-6',
        sessionId: 'abc',
      })
      // 结构应为：[system, user1, assistant, user2]
      const lastTwo = out.messages.slice(-2)
      for (const m of lastTwo) {
        const opts = (m as { providerOptions?: { anthropic?: { cacheControl?: { type: string } } } }).providerOptions
          ?.anthropic?.cacheControl
        expect(opts?.type).toBe('ephemeral')
      }
      // 最早的 user 消息不应带 cache_control。
      const earliest = out.messages[1]
      const earliestOpts = (earliest as { providerOptions?: Record<string, unknown> }).providerOptions
      expect(earliestOpts).toBeUndefined()
    })

    it('不会给 anthropic 设置顶层 providerOptions', () => {
      const out = applyCacheControl({
        system: 'sys',
        messages: baseMessages,
        modelId: 'anthropic:claude-haiku-4-5',
        sessionId: 'abc',
      })
      expect(out.providerOptions).toBeUndefined()
    })

    it('不会修改传入的消息数组', () => {
      const frozenSource: ModelMessage[] = [msg('user', 'a'), msg('assistant', 'b')]
      const snapshot = frozenSource.map((m) => ({ ...m }))
      applyCacheControl({
        system: 'sys',
        messages: frozenSource,
        modelId: 'anthropic:claude-opus-4-7',
        sessionId: 'abc',
      })
      // 原始消息对象都不应被注入 providerOptions。
      for (let i = 0; i < frozenSource.length; i++) {
        const before = snapshot[i]
        const after = frozenSource[i]
        expect(after.role).toBe(before.role)
        expect(after.content).toBe(before.content)
        expect((after as { providerOptions?: unknown }).providerOptions).toBeUndefined()
      }
    })

    it('只会给最后一个工具打上 cache_control', () => {
      const tools = {
        read: { description: 'read a file' },
        write: { description: 'write a file' },
        edit: { description: 'edit a file' },
      }
      const out = applyCacheControl({
        system: 'sys',
        messages: baseMessages,
        tools,
        modelId: 'anthropic:claude-opus-4-7',
        sessionId: 'abc',
      })
      expect(out.tools).toBeDefined()
      // 前面的工具不应带 providerOptions。
      expect((out.tools!.read as { providerOptions?: unknown }).providerOptions).toBeUndefined()
      expect((out.tools!.write as { providerOptions?: unknown }).providerOptions).toBeUndefined()
      const lastOpts = (out.tools!.edit as { providerOptions?: { anthropic?: { cacheControl?: { type: string } } } })
        .providerOptions?.anthropic?.cacheControl
      expect(lastOpts?.type).toBe('ephemeral')
    })

    it('会保留工具键顺序，确保缓存前缀字节稳定', () => {
      const tools = { read: {}, write: {}, edit: {}, shell: {} }
      const out = applyCacheControl({
        system: 'sys',
        messages: baseMessages,
        tools,
        modelId: 'anthropic:claude-opus-4-7',
        sessionId: 'abc',
      })
      expect(Object.keys(out.tools!)).toEqual(['read', 'write', 'edit', 'shell'])
    })

    it('不会修改传入的 tools 记录', () => {
      const tools = { read: { description: 'r' }, write: { description: 'w' } }
      applyCacheControl({
        system: 'sys',
        messages: baseMessages,
        tools,
        modelId: 'anthropic:claude-opus-4-7',
        sessionId: 'abc',
      })
      expect((tools.write as { providerOptions?: unknown }).providerOptions).toBeUndefined()
    })

    it('会与已有的工具 providerOptions 合并', () => {
      const tools = {
        read: {},
        write: {
          providerOptions: { anthropic: { cacheControl: { type: 'persistent' }, deferLoading: true } },
        },
      }
      const out = applyCacheControl({
        system: 'sys',
        messages: baseMessages,
        tools,
        modelId: 'anthropic:claude-opus-4-7',
        sessionId: 'abc',
      })
      const writeOpts = (
        out.tools!.write as {
          providerOptions?: { anthropic?: { cacheControl?: { type: string }; deferLoading?: boolean } }
        }
      ).providerOptions?.anthropic
      // 新注入的 ephemeral 标记会覆盖原有 cacheControl，
      // 但无关字段（如 deferLoading）必须保留。
      expect(writeOpts?.cacheControl?.type).toBe('ephemeral')
      expect(writeOpts?.deferLoading).toBe(true)
    })
  })

  describe('openai', () => {
    it('会把顶层 promptCacheKey 设置为 sessionId', () => {
      const out = applyCacheControl({
        system: 'sys',
        messages: baseMessages,
        modelId: 'openai:gpt-4.1',
        sessionId: 'session-xyz',
      })
      expect(out.providerOptions?.openai).toBeDefined()
      const oaiOpts = out.providerOptions?.openai as { promptCacheKey?: string; store?: boolean }
      expect(oaiOpts.promptCacheKey).toBe('session-xyz')
      expect(oaiOpts.store).toBe(false)
    })

    it('会保留独立的 system prompt（不折叠进 messages）', () => {
      const out = applyCacheControl({
        system: 'sys',
        messages: baseMessages,
        modelId: 'openai:gpt-4.1',
        sessionId: 'abc',
      })
      expect(out.system).toBe('sys')
      expect(out.messages).toHaveLength(baseMessages.length)
    })

    it('会原样透传 tools', () => {
      const tools = { read: { description: 'r' }, write: { description: 'w' } }
      const out = applyCacheControl({
        system: 'sys',
        messages: baseMessages,
        tools,
        modelId: 'openai:gpt-4.1',
        sessionId: 'abc',
      })
      expect(out.tools).toBe(tools)
    })
  })

  describe('openai-compatible（deepseek、moonshot、alibaba、zhipu）', () => {
    it.each([
      ['deepseek:deepseek-v4-pro'],
      ['moonshotai:kimi-k2.5'],
      ['alibaba:qwen3-coder-plus'],
      ['zhipu:glm-4-plus'],
      ['xai:grok-3'],
      ['google:gemini-2.5-pro'],
    ])('对 %s 会保持所有输入不变', (modelId) => {
      const tools = { read: { description: 'r' } }
      const out = applyCacheControl({
        system: 'sys',
        messages: baseMessages,
        tools,
        modelId,
        sessionId: 'abc',
      })
      expect(out.system).toBe('sys')
      expect(out.messages).toEqual(baseMessages)
      expect(out.providerOptions).toBeUndefined()
      expect(out.tools).toBe(tools)
    })
  })
})
