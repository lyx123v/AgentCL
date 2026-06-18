/** 基于 `Map` 的轻量级通用 LRU 缓存。
 *  依赖 `Map` 的插入顺序来维护最近使用顺序，并支持可选 TTL。
 *  这里不考虑线程安全；在 Node 单线程进程内缓存场景下足够使用。 */
interface LruCacheOptions {
  maxEntries: number // 缓存最多保留的条目数
  ttlMs?: number // 条目可存活的毫秒数，省略时表示不过期
}

export class LruCache<V> {
  private readonly map = new Map<string, { value: V; at: number }>()
  private readonly maxEntries: number
  private readonly ttlMs: number

  /** 创建一个新的 LRU 缓存实例。 */
  constructor(opts: LruCacheOptions) {
    this.maxEntries = opts.maxEntries
    this.ttlMs = opts.ttlMs ?? Infinity
  }

  /** 读取缓存值；命中后会把条目移动到“最近使用”的位置。 */
  get(key: string): V | null {
    const entry = this.map.get(key)
    if (!entry) return null
    if (Date.now() - entry.at > this.ttlMs) {
      this.map.delete(key)
      return null
    }
    // 移到尾部，表示最近刚被访问过。
    this.map.delete(key)
    this.map.set(key, entry)
    return entry.value
  }

  /** 写入缓存值；超出容量时会淘汰最久未使用的条目。 */
  set(key: string, value: V): void {
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
    this.map.set(key, { value, at: Date.now() })
  }

  /** 判断某个键当前是否仍然有效。 */
  has(key: string): boolean {
    return this.get(key) !== null
  }

  /** 返回当前缓存中的有效条目数量。 */
  get size(): number {
    return this.map.size
  }
}
