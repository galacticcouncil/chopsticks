import { wrap } from 'comlink'

export const startWorker = async <T>() => {
  const worker = new Worker(new URL('browser-wasm-executor.js', import.meta.url), {
    type: 'module',
    name: 'chopsticks-wasm-executor',
  })

  const crashed = new Promise<never>((_resolve, reject) => {
    worker.addEventListener('error', (event) => {
      reject(
        event.error instanceof Error ? event.error : new Error(event.message || 'chopsticks executor worker crashed'),
      )
    })
  })
  crashed.catch(() => {}) // this rejection is always consumed via Promise.race by callers; silence the default unhandledRejection warning

  return {
    remote: wrap<T>(worker),
    crashed,
    terminate: async () => {
      worker.terminate()
    },
  }
}
