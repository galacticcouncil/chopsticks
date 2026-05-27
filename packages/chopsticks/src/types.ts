/**
 * Chopsticks JSON RPC and CLI.
 *
 * @remarks
 * This package extends the `@galacticcouncil/chopsticks-core` package a with JSON RPC server and CLI support.
 *
 * @privateRemarks
 * Above is the package documentation for 'chopsticks' package.
 * `export` below is for tsdoc.
 *
 * @packageDocumentation
 */
export type {
  ChainProperties,
  Context,
  Handler,
  RuntimeVersion,
  SubscriptionManager,
} from '@galacticcouncil/chopsticks-core'
export * as DevRPC from '@galacticcouncil/chopsticks-core/rpc/dev/index.js'
export * from '@galacticcouncil/chopsticks-core/rpc/substrate/index.js'
export * from './plugins/types.js'
