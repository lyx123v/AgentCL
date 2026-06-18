import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LruCache } from '../src/utils/lru-cache.js'

describe('LruCache', () => {
  it('可以存储并读取值', () => {
    const cache = new LruCache<number>({ maxEntries: 10 })
    cache.set('a', 1)
    cache.set('b', 2)
    expect(cache.get('a')).toBe(1)
    expect(cache.get('b')).toBe(2)
  })

  it('缺失的 key 会返回 null', () => {
    const cache = new LruCache<string>({ maxEntries: 10 })
    expect(cache.get('missing')).toBeNull()
  })

  it('超过 maxEntries 时会淘汰最旧条目', () => {
    const cache = new LruCache<number>({ maxEntries: 3 })
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    cache.set('d', 4)
    expect(cache.get('a')).toBeNull()
    expect(cache.get('b')).toBe(2)
    expect(cache.get('c')).toBe(3)
    expect(cache.get('d')).toBe(4)
    expect(cache.size).toBe(3)
  })

  it('访问过的条目会提升优先级（LRU 顺序）', () => {
    const cache = new LruCache<number>({ maxEntries: 3 })
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    // 访问 `a` 后，它会变成最近使用的条目。
    cache.get('a')
    // 插入 `d` 后，`b` 会成为最旧条目并被淘汰。
    cache.set('d', 4)
    expect(cache.get('b')).toBeNull()
    expect(cache.get('a')).toBe(1)
    expect(cache.get('c')).toBe(3)
    expect(cache.get('d')).toBe(4)
  })

  describe('TTL 过期', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('过期条目会返回 null', () => {
      const cache = new LruCache<string>({ maxEntries: 10, ttlMs: 1000 })
      cache.set('key', 'value')
      expect(cache.get('key')).toBe('value')

      vi.advanceTimersByTime(1001)
      expect(cache.get('key')).toBeNull()
    })

    it('TTL 未到期前会正常返回值', () => {
      const cache = new LruCache<string>({ maxEntries: 10, ttlMs: 5000 })
      cache.set('key', 'value')

      vi.advanceTimersByTime(4999)
      expect(cache.get('key')).toBe('value')
    })
  })
})
