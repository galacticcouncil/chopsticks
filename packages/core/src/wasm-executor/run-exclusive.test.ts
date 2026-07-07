import { describe, expect, it } from 'vitest'

import { runExclusive } from './index.js'

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Regression tests for the executor call serialization added after
// galacticcouncil/chopsticks#6: overlapping calls into the shared wasm executor
// instance were found to corrupt its JS-side glue state and crash it with an
// `unreachable` trap. runExclusive() is the primitive that prevents that by
// making sure only one call's lifetime is ever in flight, while still letting a
// call's own nested sub-calls (sharing its token) through so they don't
// deadlock against it.
describe('runExclusive', () => {
  it('serializes two concurrent calls without tokens so their lifetimes never overlap', async () => {
    let active = 0
    let maxActive = 0

    const task = async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await delay(20)
      active--
    }

    await Promise.all([runExclusive(task), runExclusive(task)])

    expect(maxActive).toBe(1)
  })

  it('runs queued calls in FIFO order', async () => {
    const order: number[] = []
    const task = (id: number) => async () => {
      order.push(id)
      await delay(10)
    }

    await Promise.all([runExclusive(task(1)), runExclusive(task(2)), runExclusive(task(3))])

    expect(order).toEqual([1, 2, 3])
  })

  it('lets a nested call sharing the current holder token bypass the queue instead of deadlocking', async () => {
    const token = Symbol('test-lock')
    let nestedRan = false

    await runExclusive(async () => {
      // this call is made while the outer call is still "in flight" — without
      // the reentrancy bypass this would deadlock forever awaiting itself
      await runExclusive(async () => {
        nestedRan = true
      }, token)
    }, token)

    expect(nestedRan).toBe(true)
  })

  it('does not let an unrelated token bypass a call it is not nested inside of', async () => {
    const tokenA = Symbol('a')
    const tokenB = Symbol('b')
    const order: string[] = []

    const holderA = runExclusive(async () => {
      order.push('a-start')
      await delay(20)
      order.push('a-end')
    }, tokenA)

    // give holderA a chance to acquire the lock first
    await delay(5)

    const callerB = runExclusive(async () => {
      order.push('b')
    }, tokenB)

    await Promise.all([holderA, callerB])

    expect(order).toEqual(['a-start', 'a-end', 'b'])
  })
})
