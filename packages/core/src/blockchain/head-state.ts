import { defaultLogger } from '../logger.js'
import type { Block } from './block.js'

type Callback = (block: Block, pairs: [string, string | null][]) => void | Promise<void>

export const randomId = () => Math.random().toString(36).substring(2)

const logger = defaultLogger.child({ name: 'head-state' })

export class HeadState {
  #headListeners: Record<string, (block: Block) => void | Promise<void>> = {}
  #storageListeners: Record<string, [string[], Callback]> = {}
  #oldValues: Record<string, string | null> = {}

  #head: Block

  constructor(head: Block) {
    this.#head = head
  }

  subscribeHead(cb: (block: Block) => void) {
    const id = randomId()
    this.#headListeners[id] = cb
    return id
  }

  unsubscribeHead(id: string) {
    delete this.#headListeners[id]
  }

  async subscribeStorage(keys: string[], cb: Callback) {
    const id = randomId()
    this.#storageListeners[id] = [keys, cb]

    for (const key of keys) {
      this.#oldValues[key] = await this.#head.get(key).then((val) => val || null)
    }

    return id
  }

  unsubscribeStorage(id: string) {
    delete this.#storageListeners[id]
    // prune tracked values for keys no other subscription watches
    const watched = new Set<string>()
    for (const [keys] of Object.values(this.#storageListeners)) {
      for (const key of keys) watched.add(key)
    }
    for (const key of Object.keys(this.#oldValues)) {
      if (!watched.has(key)) delete this.#oldValues[key]
    }
  }

  async setHead(head: Block) {
    this.#head = head

    for (const cb of Object.values(this.#headListeners)) {
      try {
        await cb(head)
      } catch (error) {
        logger.error(error, 'setHead head callback error')
      }
    }

    const diff = await this.#head.storageDiff()

    const newValues: Record<string, string | null> = { ...diff }
    const watchedKeys = new Set<string>()
    for (const [keys] of Object.values(this.#storageListeners)) {
      for (const key of keys) watchedKeys.add(key)
    }
    for (const key of watchedKeys) {
      if (newValues[key] === undefined && this.#oldValues[key] !== undefined) {
        newValues[key] = (await head.get(key)) ?? null
      }
    }

    for (const [keys, cb] of Object.values(this.#storageListeners)) {
      const changes: [string, string | null][] = []
      for (const key of keys) {
        if (newValues[key] === undefined) continue
        if (newValues[key] !== this.#oldValues[key]) {
          changes.push([key, newValues[key]])
        }
      }
      if (changes.length > 0) {
        try {
          await cb(head, changes)
        } catch (error) {
          logger.error(error, 'setHead storage diff callback error')
        }
      }
    }

    // Only retain values for keys someone actually watches — merging every
    // block's whole diff here grows without bound on a long-running chain
    // (galacticcouncil/chopsticks#7). Newly subscribed keys are seeded by
    // subscribeStorage itself.
    for (const key of watchedKeys) {
      if (newValues[key] !== undefined) {
        this.#oldValues[key] = newValues[key]
      }
    }
  }
}
