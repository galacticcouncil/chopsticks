import threads from 'node:worker_threads'
import { wrap } from 'comlink'
import nodeEndpoint from 'comlink/dist/umd/node-adapter.js'

export const startWorker = async <T>() => {
  const worker = new threads.Worker(new URL('node-wasm-executor.js', import.meta.url), {
    name: 'chopsticks-wasm-executor',
  })

  // Some wasm traps (e.g. `unreachable`) surface asynchronously outside the
  // normal Comlink request/response cycle and reach the worker thread as an
  // uncaught exception. Without a listener here, Node's default behaviour for
  // an unhandled `error` event on a Worker is to rethrow on `process.nextTick`,
  // crashing the whole host process (galacticcouncil/chopsticks#6). Listening
  // here turns that into a rejected promise instead.
  let terminating = false
  const crashed = new Promise<never>((_resolve, reject) => {
    worker.once('error', (err) => {
      reject(err instanceof Error ? err : new Error(String(err)))
    })
    worker.once('exit', (code) => {
      // `worker.terminate()` always reports exit code 1, even on a clean shutdown,
      // so only treat an unexpected exit (one we didn't request) as a crash.
      if (!terminating && code !== 0) {
        reject(new Error(`chopsticks executor worker exited unexpectedly with code ${code}`))
      }
    })
  })
  crashed.catch(() => {}) // this rejection is always consumed via Promise.race by callers; silence the default unhandledRejection warning

  return {
    remote: wrap<T>((nodeEndpoint as any)(worker)),
    crashed,
    terminate: async () => {
      terminating = true
      await worker.terminate()
    },
  }
}
