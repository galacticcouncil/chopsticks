import threads from 'node:worker_threads'
import { describe, expect, it } from 'vitest'

import { startWorker } from './node-worker.js'

// Regression tests for galacticcouncil/chopsticks#6: an exception thrown
// asynchronously inside the executor worker thread (e.g. a wasm `unreachable`
// trap escaping outside the normal Comlink request/response cycle) surfaces as
// an unhandled 'error' event on the Worker. Node's default behaviour for that
// is to rethrow on process.nextTick and kill the whole host process. If any of
// these tests crash the process, the test run itself dies rather than failing
// a single case.
describe('executor worker crash handling', () => {
  it('an error listener stops an async worker-thread exception from crashing the process', async () => {
    const worker = new threads.Worker(
      `
      setTimeout(() => {
        throw new Error('simulated unreachable trap')
      }, 10)
      `,
      { eval: true },
    )

    const crashed = new Promise((_resolve, reject) => {
      worker.once('error', (err) => reject(err instanceof Error ? err : new Error(String(err))))
    })
    crashed.catch(() => {})

    await expect(crashed).rejects.toThrow('simulated unreachable trap')
    await worker.terminate()
  })

  it('graceful termination does not reject the crashed promise', async () => {
    const worker = await startWorker()
    let sawCrash = false
    worker.crashed.catch(() => {
      sawCrash = true
    })

    await worker.terminate()
    // give the 'exit' listener a tick to run before asserting
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(sawCrash).toBe(false)
  })
})
