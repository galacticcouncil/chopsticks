import type { HexString } from '@polkadot/util/types'
import _ from 'lodash'
import { LRUCache } from 'lru-cache'

import type { Api } from '../api.js'
import type { Database } from '../database.js'
import { defaultLogger } from '../logger.js'
import { CHILD_PREFIX_LENGTH, isPrefixedChildKey, PREFIX_LENGTH } from '../utils/index.js'
import KeyCache from '../utils/key-cache.js'

const logger = defaultLogger.child({ name: 'layer' })

const BATCH_SIZE = 1000

// Sentinel for "key exists upstream but has no value" — real values are 0x-hex.
const MISSING = '\x00missing'

// Shared, bounded cache of remotely-fetched storage values across all
// RemoteStorageLayer instances, keyed by block hash + storage key (values at a
// given block are immutable). Keeps hot keys warm across blocks without a db
// while eviction keeps the footprint fixed — unlike the per-layer read caches,
// which are dropped once a block falls behind head.
//
// Sized via CHOPSTICKS_STORAGE_CACHE_MB (default 128). An env var rather than
// a config key because the cache is process-global — one YAML per chain in
// multi-chain (XCM) setups would fight over it.
const storageCacheMB = Number((globalThis as any)?.process?.env?.CHOPSTICKS_STORAGE_CACHE_MB) || 128
const remoteValueCache = new LRUCache<string, string>({
  // ~4k entries per MB — maxSize (bytes-ish) is the real bound, this just
  // caps bookkeeping overhead for pathologically tiny values
  max: storageCacheMB * 4096,
  maxSize: storageCacheMB * 1024 * 1024,
  sizeCalculation: (value) => value.length + 64,
})

export enum StorageValueKind {
  Deleted = 'Deleted',
  DeletedPrefix = 'DeletedPrefix',
}

export type StorageValue = string | StorageValueKind | undefined

export interface StorageLayerProvider {
  /**
   * Returns true if key is deleted
   */
  deleted(key: string): boolean
  /**
   * Get the value of a storage key.
   */
  get(key: string, cache: boolean): Promise<StorageValue>
  /**
   * Get the value of many storage keys.
   */
  getMany(keys: string[], _cache: boolean): Promise<StorageValue[]>
  /**
   * Get paged storage keys.
   */
  getKeysPaged(prefix: string, pageSize: number, startKey: string): Promise<string[]>
  /**
   * Find next storage key.
   */
  findNextKey(prefix: string, startKey: string, knownBest?: string): Promise<string | undefined>
}

export class RemoteStorageLayer implements StorageLayerProvider {
  readonly #api: Api
  readonly #at: HexString
  readonly #db: Database | undefined
  readonly #keyCache = new KeyCache(PREFIX_LENGTH)
  readonly #defaultChildKeyCache = new KeyCache(CHILD_PREFIX_LENGTH)
  readonly #inflight = new Map<string, Promise<StorageValue>>()

  constructor(api: Api, at: HexString, db: Database | undefined) {
    this.#api = api
    this.#at = at
    this.#db = db
  }

  deleted(_key: string): boolean {
    return false
  }

  async get(key: string, _cache: boolean): Promise<StorageValue> {
    const cacheKey = `${this.#at}:${key}`
    const cached = remoteValueCache.get(cacheKey)
    if (cached !== undefined) {
      return cached === MISSING ? undefined : cached
    }

    const inflight = this.#inflight.get(key)
    if (inflight) return inflight

    if (this.#db) {
      const res = await this.#db.queryStorage(this.#at as HexString, key as HexString)
      if (res) {
        remoteValueCache.set(cacheKey, res.value ?? MISSING)
        return res.value ?? undefined
      }
    }

    logger.trace({ at: this.#at, key }, 'RemoteStorageLayer get')
    const fetch = this.#api
      .getStorage(key, this.#at)
      .then((data) => {
        this.#db?.saveStorage(this.#at as HexString, key as HexString, data)
        remoteValueCache.set(cacheKey, data ?? MISSING)
        return data ?? undefined
      })
      .finally(() => {
        this.#inflight.delete(key)
      })
    this.#inflight.set(key, fetch)
    return fetch
  }

  async getMany(keys: string[], _cache: boolean): Promise<StorageValue[]> {
    const result: StorageValue[] = []
    let pending: Array<{ key: string; idx: number }> = []
    const inflightWaits: Promise<void>[] = []

    keys.forEach((key, idx) => {
      const cached = remoteValueCache.get(`${this.#at}:${key}`)
      if (cached !== undefined) {
        result[idx] = cached === MISSING ? undefined : cached
        return
      }
      const inflight = this.#inflight.get(key)
      if (inflight) {
        inflightWaits.push(
          inflight.then((val) => {
            result[idx] = val
          }),
        )
        return
      }
      pending.push({ key, idx })
    })

    if (this.#db && pending.length) {
      const results = await Promise.all(
        pending.map(({ key }) => this.#db!.queryStorage(this.#at as HexString, key as HexString)),
      )

      const oldPending = pending
      pending = []
      results.forEach((res, idx) => {
        if (res) {
          result[oldPending[idx].idx] = res.value ?? undefined
          remoteValueCache.set(`${this.#at}:${oldPending[idx].key}`, res.value ?? MISSING)
        } else {
          pending.push(oldPending[idx])
        }
      })
    }

    if (pending.length) {
      logger.trace({ at: this.#at, keys }, 'RemoteStorageLayer getMany')
      const data = await this.#api.getStorageBatch(
        '0x',
        pending.map(({ key }) => key as HexString),
        this.#at,
      )
      data.forEach(([, res], idx) => {
        result[pending[idx].idx] = res ?? undefined
        remoteValueCache.set(`${this.#at}:${pending[idx].key}`, res ?? MISSING)
      })

      if (this.#db?.saveStorageBatch) {
        this.#db?.saveStorageBatch(data.map(([key, value]) => ({ key, value, blockHash: this.#at })))
      } else if (this.#db) {
        data.forEach(([key, value]) => {
          this.#db?.saveStorage(this.#at, key, value)
        })
      }
    }

    await Promise.all(inflightWaits)
    return result
  }

  /**
   * Batch-fetch values for freshly-discovered keys and stage them in the
   * shared value cache (and db). Registered in `#inflight` so concurrent
   * `get`/`getMany` calls for the same keys await the batch instead of
   * re-fetching key by key — full map iteration (`.entries()`) issues
   * exactly one upstream round-trip per key page this way (issue #9).
   */
  #prefetchValues(prefix: HexString, keys: HexString[]): void {
    const newKeys = keys.filter((key) => !this.#inflight.has(key) && !remoteValueCache.has(`${this.#at}:${key}`))
    if (newKeys.length === 0) return

    const batch = this.#api.getStorageBatch(prefix, newKeys, this.#at).then((data) => {
      const values = new Map(data)
      for (const [key, value] of data) {
        this.#db?.saveStorage(this.#at, key, value)
        remoteValueCache.set(`${this.#at}:${key}`, value ?? MISSING)
      }
      return values
    })

    for (const key of newKeys) {
      const fetch: Promise<StorageValue> = batch
        .then((values) => values.get(key) ?? undefined)
        .finally(() => {
          if (this.#inflight.get(key) === fetch) this.#inflight.delete(key)
        })
      // swallow batch failures here — the keys fall out of #inflight and any
      // actual reader gets the rejection (or retries) through its own await
      fetch.catch(() => {})
      this.#inflight.set(key, fetch)
    }
  }

  async findNextKey(prefix: string, startKey: string, _knownBest?: string): Promise<string | undefined> {
    const keys = await this.getKeysPaged(prefix, 1, startKey)
    return keys[0]
  }

  async getKeysPaged(prefix: string, pageSize: number, startKey: string): Promise<string[]> {
    if (pageSize > BATCH_SIZE) throw new Error(`pageSize must be less or equal to ${BATCH_SIZE}`)
    logger.trace({ at: this.#at, prefix, pageSize, startKey }, 'RemoteStorageLayer getKeysPaged')

    const isChild = isPrefixedChildKey(prefix as HexString)
    const minPrefixLen = isChild ? CHILD_PREFIX_LENGTH : PREFIX_LENGTH

    // KeyCache groups by the first `minPrefixLen` chars; it cannot correctly answer queries
    // whose prefix is longer than that grouping width, so proxy directly to upstream.
    if (
      prefix.length < minPrefixLen ||
      startKey.length < minPrefixLen ||
      prefix.length > minPrefixLen ||
      startKey.length > minPrefixLen
    ) {
      return this.#api.getKeysPaged(prefix, pageSize, startKey, this.#at)
    }

    const startKeyEqualsPrefix = startKey === prefix
    let cachedKeys: HexString[] | undefined
    if (this.#db?.queryPagedKeys && startKeyEqualsPrefix) {
      const cached = await this.#db.queryPagedKeys(this.#at, prefix as HexString)
      if (cached) {
        cachedKeys = cached
        isChild
          ? this.#defaultChildKeyCache.feed([startKey, ...cached] as HexString[])
          : this.#keyCache.feed([startKey, ...cached] as HexString[])
      }
    }

    let batchComplete = false
    let fetchedNewKeys = false
    const keysPaged: string[] = []
    // Seed with cached keys so a cache-hit-then-extend doesn't truncate the persisted set.
    const allFetchedKeys: HexString[] = cachedKeys ? [...cachedKeys] : []
    while (keysPaged.length < pageSize) {
      const nextKey = isChild
        ? await this.#defaultChildKeyCache.next(startKey as HexString)
        : await this.#keyCache.next(startKey as HexString)
      if (nextKey) {
        keysPaged.push(nextKey)
        startKey = nextKey
        continue
      }
      // batch fetch was completed
      if (batchComplete) {
        break
      }

      // fetch a batch of keys
      const batch = await this.#api.getKeysPaged(prefix, BATCH_SIZE, startKey, this.#at)
      batchComplete = batch.length < BATCH_SIZE

      // feed the key cache
      if (batch.length > 0) {
        if (isChild) {
          this.#defaultChildKeyCache.feed([startKey, ...batch] as HexString[])
        } else {
          this.#keyCache.feed([startKey, ...batch] as HexString[])
        }
      }

      if (batch.length === 0) {
        // no more keys were found
        break
      }

      {
        // stage values for the discovered keys — clients iterating a map
        // (`.entries()`) will ask for them within milliseconds
        let newBatch = batch as HexString[]
        if (this.#db) {
          newBatch = await Promise.all(
            newBatch.map((key) => this.#db!.queryStorage(this.#at, key).then((r) => (r ? null : key))),
          ).then((rs) => rs.filter((k): k is HexString => k !== null))
        }
        this.#prefetchValues(prefix as HexString, newBatch)

        if (this.#db && startKeyEqualsPrefix) {
          allFetchedKeys.push(...(batch as HexString[]))
          fetchedNewKeys = true
        }
      }
    }

    if (this.#db?.savePagedKeys && startKeyEqualsPrefix && fetchedNewKeys) {
      await this.#db.savePagedKeys(this.#at, prefix as HexString, allFetchedKeys)
    }

    return keysPaged
  }
}

export class StorageLayer implements StorageLayerProvider {
  /** Writes applied to this layer — the block's actual diff. */
  readonly #store: Map<string, StorageValue | Promise<StorageValue>> = new Map()
  /**
   * Read-through cache of values resolved from parent layers. Kept separate
   * from `#store` so cached reads never end up in {@link mergeInto} output
   * (block diffs stay honest) and can be dropped via {@link clearReadCache}
   * without losing writes.
   */
  readonly #readCache: Map<string, StorageValue | Promise<StorageValue>> = new Map()
  readonly #keys: string[] = []
  readonly #deletedPrefix: string[] = []
  #parent?: StorageLayerProvider

  constructor(parent?: StorageLayerProvider) {
    this.#parent = parent
  }

  #addKey(key: string) {
    const idx = _.sortedIndex(this.#keys, key)
    const key2 = this.#keys[idx]
    if (key === key2) {
      return
    }
    this.#keys.splice(idx, 0, key)
  }

  #removeKey(key: string) {
    const idx = _.sortedIndex(this.#keys, key)
    const key2 = this.#keys[idx]
    if (key === key2) {
      this.#keys.splice(idx, 1)
    }
  }

  deleted(key: string): boolean {
    if (this.#store.has(key)) {
      return this.#store.get(key) === StorageValueKind.Deleted
    }

    if (this.#deletedPrefix.some((dp) => key.startsWith(dp))) {
      return true
    }

    if (this.#parent) {
      return this.#parent.deleted(key)
    }

    return false
  }

  async get(key: string, cache: boolean): Promise<StorageValue | undefined> {
    if (this.#store.has(key)) {
      return this.#store.get(key)
    }

    if (this.#readCache.has(key)) {
      return this.#readCache.get(key)
    }

    if (this.#deletedPrefix.some((dp) => key.startsWith(dp))) {
      return StorageValueKind.Deleted
    }

    if (this.#parent) {
      const val = this.#parent.get(key, false)
      if (cache) {
        this.#readCache.set(key, val)
      }
      return val
    }

    return undefined
  }

  async getMany(keys: string[], cache: boolean): Promise<StorageValue[]> {
    const result: StorageValue[] = []
    const pending: Array<{ key: string; idx: number }> = []

    const preloadedPromises = keys.map(async (key, idx) => {
      if (this.#store.has(key)) {
        result[idx] = await this.#store.get(key)
      } else if (this.#readCache.has(key)) {
        result[idx] = await this.#readCache.get(key)
      } else if (this.#deletedPrefix.some((dp) => key.startsWith(dp))) {
        result[idx] = StorageValueKind.Deleted
      } else {
        pending.push({ key, idx })
      }
    })

    if (pending.length && this.#parent) {
      const vals = await this.#parent.getMany(
        pending.map((p) => p.key),
        false,
      )
      vals.forEach((val, idx) => {
        if (cache) {
          this.#readCache.set(pending[idx].key, val)
        }
        result[pending[idx].idx] = val
      })
    }

    await Promise.all(preloadedPromises)
    return result
  }

  /**
   * Drop read-through cache entries. Writes are untouched. Called when the
   * owning block falls behind head so cached reads don't pin memory forever.
   */
  clearReadCache(): void {
    this.#readCache.clear()
  }

  set(key: string, value: StorageValue): void {
    this.#readCache.delete(key)
    switch (value) {
      case StorageValueKind.Deleted:
        this.#store.set(key, StorageValueKind.Deleted)
        this.#removeKey(key)
        break
      case StorageValueKind.DeletedPrefix:
        this.#deletedPrefix.push(key)
        for (const k of this.#readCache.keys()) {
          if (k.startsWith(key)) {
            this.#readCache.delete(k)
          }
        }
        for (const k of this.#keys) {
          if (k.startsWith(key)) {
            this.#store.set(k, StorageValueKind.Deleted)
            this.#removeKey(k)
          }
        }
        break
      case undefined:
        this.#store.delete(key)
        this.#removeKey(key)
        break
      default:
        this.#store.set(key, value)
        this.#addKey(key)
        break
    }
  }

  setAll(values: Record<string, StorageValue | null> | [string, StorageValue | null][]) {
    if (!Array.isArray(values)) {
      values = Object.entries(values)
    }
    for (const [key, value] of values) {
      this.set(key, value || StorageValueKind.Deleted)
    }
  }

  async findNextKey(prefix: string, startKey: string, knownBest?: string): Promise<string | undefined> {
    const maybeBest = this.#keys.find((key) => key.startsWith(prefix) && key > startKey)
    if (!knownBest) {
      knownBest = maybeBest
    } else if (maybeBest && maybeBest < knownBest) {
      knownBest = maybeBest
    }
    if (this.#parent && !this.#deletedPrefix.some((dp) => dp === prefix)) {
      const parentBest = await this.#parent.findNextKey(prefix, startKey, knownBest)
      if (parentBest) {
        if (!maybeBest) {
          return parentBest
        }
        if (parentBest < maybeBest) {
          return parentBest
        }
      }
    }
    return knownBest
  }

  async getKeysPaged(prefix: string, pageSize: number, startKey: string): Promise<string[]> {
    if (pageSize > BATCH_SIZE) throw new Error(`pageSize must be less or equal to ${BATCH_SIZE}`)

    if (!startKey || startKey === '0x') {
      startKey = prefix
    }

    const keys: string[] = []
    while (keys.length < pageSize) {
      const next = await this.findNextKey(prefix, startKey, undefined)
      if (!next) break
      startKey = next
      if (this.deleted(next)) continue
      keys.push(next)
    }
    return keys
  }

  /**
   * Merge the storage layer into the given object, can be used to get sotrage diff.
   */
  async mergeInto(into: Record<string, string | null>) {
    for (const [key, maybeValue] of this.#store) {
      const value = await maybeValue
      if (value === StorageValueKind.Deleted) {
        into[key] = null
      } else {
        into[key] = value as string
      }
    }
  }
}
