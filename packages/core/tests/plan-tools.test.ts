// agent/plan-tools.ts 测试（handleTodoWrite / handleEnterPlanMode / handleExitPlanMode）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createLoopState } from '../src/agent/loop-state.js'
import { handleEnterPlanMode, handleExitPlanMode, handleTodoWrite } from '../src/agent/plan-tools.js'
import type { AgentCallbacks, AgentOptions, TodoItem } from '../src/types/index.js'

// 构造一组默认回调，便于只覆盖当前测试关心的行为。
function makeCallbacks(overrides: Partial<AgentCallbacks> = {}): AgentCallbacks {
  return {
    onTextDelta: vi.fn(),
    onToolCall: vi.fn(),
    onToolProgress: vi.fn(),
    onToolResult: vi.fn(),
    onAskPermission: vi.fn().mockResolvedValue('yes'),
    onAskUser: vi.fn().mockResolvedValue('option1'),
    onPlanApprovalRequest: vi.fn().mockResolvedValue(true),
    onPlanModeChange: vi.fn(),
    onTodosUpdate: vi.fn(),
    onShellOutput: vi.fn(),
    onUsageUpdate: vi.fn(),
    onContextCompressed: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  }
}

// 构造默认的 AgentOptions，避免每个测试重复填写样板参数。
function makeOptions(overrides: Partial<AgentOptions> = {}): AgentOptions {
  return {
    modelId: 'test:model',
    trustMode: false,
    maxTurns: 10,
    printMode: false,
    ...overrides,
  }
}

const captured: Array<{ toolName: string; output: string; isError: boolean }> = []
// 记录推送出的 tool result，便于断言输出文案和错误状态。
function recordPushToolResult(
  _state: unknown,
  _callbacks: unknown,
  _toolCallId: string,
  toolName: string,
  output: string,
  isError = false,
): void {
  captured.push({ toolName, output, isError })
}

let tmpHome: string

beforeEach(async () => {
  tmpHome = path.join(os.tmpdir(), 'x-code-test-' + Date.now() + '-' + Math.random().toString(36).slice(2))
  await fs.mkdir(tmpHome, { recursive: true })
  process.env.X_CODE_HOME = tmpHome
  captured.length = 0
})

afterEach(async () => {
  delete process.env.X_CODE_HOME
  await fs.rm(tmpHome, { recursive: true, force: true })
})

describe('handleTodoWrite', () => {
  it('会规范化 todos 并通知 UI', async () => {
    const state = createLoopState()
    const callbacks = makeCallbacks()
    const todos: TodoItem[] = [
      { content: 'Step A', activeForm: 'Doing A', status: 'in_progress' },
      { content: 'Step B', activeForm: 'Doing B', status: 'pending' },
    ]
    await handleTodoWrite({ todos }, 'tc1', state, callbacks, recordPushToolResult)
    expect(state.todos).toEqual(todos)
    expect(callbacks.onTodosUpdate).toHaveBeenCalledWith(todos)
    expect(captured[0].output).toContain('待办清单已更新')
    expect(captured[0].isError).toBe(false)
  })

  it('当 todos 全部完成时会清空列表', async () => {
    const state = createLoopState()
    state.todos = [{ content: 'old', activeForm: 'old', status: 'in_progress' }]
    const callbacks = makeCallbacks()
    const todos = [
      { content: 'Build', activeForm: 'Building', status: 'completed' },
      { content: 'Ship', activeForm: 'Shipping', status: 'completed' },
    ]
    await handleTodoWrite({ todos }, 'tc1', state, callbacks, recordPushToolResult)
    expect(state.todos).toEqual([])
    expect(callbacks.onTodosUpdate).toHaveBeenCalledWith([])
    expect(captured[0].output).toContain('所有待办都已完成')
  })

  it('会丢弃既没有 content 也没有 activeForm 的条目，并报告数量', async () => {
    const state = createLoopState()
    const callbacks = makeCallbacks()
    const todos = [
      { content: 'good', activeForm: 'good', status: 'pending' },
      { content: '', activeForm: '', status: 'pending' },
      { status: 'pending' },
    ]
    await handleTodoWrite({ todos }, 'tc1', state, callbacks, recordPushToolResult)
    expect(state.todos).toHaveLength(1)
    expect(captured[0].output).toMatch(/2 条待办被丢弃/)
  })

  it('当两个文本字段只提供其一时，会回退使用 activeForm', async () => {
    const state = createLoopState()
    const callbacks = makeCallbacks()
    const todos = [{ activeForm: 'Doing thing', status: 'pending' }]
    await handleTodoWrite({ todos }, 'tc1', state, callbacks, recordPushToolResult)
    expect(state.todos[0]).toEqual({
      content: 'Doing thing',
      activeForm: 'Doing thing',
      status: 'pending',
    })
  })

  it('当多步骤列表收尾时若没有测试或 lint 任务，会追加“检查你的工作”提示', async () => {
    const state = createLoopState()
    const callbacks = makeCallbacks()
    const todos = [
      { content: 'Refactor module', activeForm: 'Refactoring', status: 'completed' },
      { content: 'Update callers', activeForm: 'Updating', status: 'completed' },
      { content: 'Document changes', activeForm: 'Documenting', status: 'completed' },
    ]
    await handleTodoWrite({ todos }, 'tc1', state, callbacks, recordPushToolResult)
    expect(captured[0].output).toMatch(/验证你的工作/)
  })

  it('当列表中已包含 test/lint/build 任务时，不会追加验证提示', async () => {
    const state = createLoopState()
    const callbacks = makeCallbacks()
    const todos = [
      { content: 'Refactor module', activeForm: 'Refactoring', status: 'completed' },
      { content: 'Update callers', activeForm: 'Updating', status: 'completed' },
      { content: 'Run test suite', activeForm: 'Running tests', status: 'completed' },
    ]
    await handleTodoWrite({ todos }, 'tc1', state, callbacks, recordPushToolResult)
    expect(captured[0].output).not.toMatch(/验证你的工作/)
  })

  it('缺失 status 时默认补成 pending', async () => {
    const state = createLoopState()
    const callbacks = makeCallbacks()
    const todos = [{ content: 'Do thing', activeForm: 'Doing thing' }]
    await handleTodoWrite({ todos }, 'tc1', state, callbacks, recordPushToolResult)
    expect(state.todos[0].status).toBe('pending')
  })
})

describe('handleEnterPlanMode', () => {
  it('批准后会切换 permissionMode 并清空 system prompt 缓存', async () => {
    const state = createLoopState('default')
    state.systemPromptCache = 'cached'
    const callbacks = makeCallbacks({ onAskPermission: vi.fn().mockResolvedValue('yes') })
    await handleEnterPlanMode({}, 'tc1', state, makeOptions(), callbacks, recordPushToolResult)
    expect(state.permissionMode).toBe('plan')
    expect(state.systemPromptCache).toBeNull()
    expect(state.currentPlanPath).toBeTruthy()
    expect(callbacks.onPlanModeChange).toHaveBeenCalledWith('plan')
    expect(captured[0].output).toContain('已进入计划模式')
  })

  it('当已经在 plan 模式时会返回无操作结果', async () => {
    const state = createLoopState('plan')
    const callbacks = makeCallbacks()
    await handleEnterPlanMode({}, 'tc1', state, makeOptions(), callbacks, recordPushToolResult)
    expect(callbacks.onAskPermission).not.toHaveBeenCalled()
    expect(state.permissionMode).toBe('plan')
    expect(captured[0].output).toContain('当前已经处于计划模式')
  })

  it('当用户拒绝权限提示时会干净地退出', async () => {
    const state = createLoopState('default')
    const callbacks = makeCallbacks({ onAskPermission: vi.fn().mockResolvedValue('no') })
    await handleEnterPlanMode({}, 'tc1', state, makeOptions(), callbacks, recordPushToolResult)
    expect(state.permissionMode).toBe('default')
    expect(callbacks.onPlanModeChange).not.toHaveBeenCalled()
    expect(captured[0].isError).toBe(true)
    expect(captured[0].output).toContain('用户拒绝进入计划模式')
  })

  it('当权限已返回后 abort signal 触发时，会报告中断', async () => {
    const state = createLoopState('default')
    const ac = new AbortController()
    const callbacks = makeCallbacks({
      onAskPermission: vi.fn().mockImplementation(async () => {
        ac.abort()
        return 'yes'
      }),
    })
    await handleEnterPlanMode(
      {},
      'tc1',
      state,
      makeOptions({ abortSignal: ac.signal }),
      callbacks,
      recordPushToolResult,
    )
    expect(state.permissionMode).toBe('default')
    expect(captured[0].output).toContain('中断')
    expect(captured[0].isError).toBe(true)
  })
})

describe('handleExitPlanMode', () => {
  it('当前不在 plan 模式时会拒绝调用', async () => {
    const state = createLoopState('default')
    const callbacks = makeCallbacks()
    await handleExitPlanMode({ plan: 'something' }, 'tc1', state, callbacks, recordPushToolResult)
    expect(captured[0].isError).toBe(true)
    expect(captured[0].output).toContain('当前不在计划模式')
  })

  it('plan 内容为空时会报错', async () => {
    const state = createLoopState('plan')
    state.currentPlanPath = path.join(tmpHome, 'plan.md')
    const callbacks = makeCallbacks()
    await handleExitPlanMode({}, 'tc1', state, callbacks, recordPushToolResult)
    expect(captured[0].isError).toBe(true)
    expect(captured[0].output).toContain('当前为空')
    expect(state.permissionMode).toBe('plan')
  })

  it('用户批准后会切换到 acceptEdits，并返回 plan approved 结果', async () => {
    const state = createLoopState('plan')
    state.systemPromptCache = 'cached'
    const planPath = path.join(tmpHome, 'plan-test.md')
    state.currentPlanPath = planPath
    const callbacks = makeCallbacks({
      onPlanApprovalRequest: vi.fn().mockResolvedValue(true),
    })
    await handleExitPlanMode({ plan: 'My plan body' }, 'tc1', state, callbacks, recordPushToolResult)

    expect(state.permissionMode).toBe('acceptEdits')
    expect(state.systemPromptCache).toBeNull()
    expect(state.currentPlanPath).toBeNull()
    expect(callbacks.onPlanModeChange).toHaveBeenCalledWith('acceptEdits')
    expect(captured[0].output).toContain('用户已批准计划')

    // 覆盖后的 plan 内容会落盘保存。
    const written = await fs.readFile(planPath, 'utf-8')
    expect(written).toBe('My plan body')

    // 还会追加一条后续 user 消息，让模型知道权限闸门已经切换。
    const lastMsg = state.messages[state.messages.length - 1]
    expect(lastMsg.role).toBe('user')
  })

  it('当用户拒绝时会保持在 plan 模式，并推送错误结果', async () => {
    const state = createLoopState('plan')
    state.currentPlanPath = path.join(tmpHome, 'plan-rej.md')
    const callbacks = makeCallbacks({
      onPlanApprovalRequest: vi.fn().mockResolvedValue(false),
    })
    await handleExitPlanMode({ plan: 'rejected plan' }, 'tc1', state, callbacks, recordPushToolResult)
    expect(state.permissionMode).toBe('plan')
    expect(captured[0].isError).toBe(true)
    expect(captured[0].output).toContain('用户拒绝了当前计划')
  })
})
