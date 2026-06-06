import type { HexString } from '@polkadot/util/types'
import { hexToU8a, u8aToHex } from '@polkadot/util'
import { parseTransaction } from 'viem'

import type { Handler } from '../shared.js'
import { ResponseError } from '../shared.js'
import {
  decodeAccountBasic,
  decodeCallResult,
  decodeCreateResult,
  decodeU64LE,
  decodeU256LE,
  decodeVec,
  encodeCallParams,
  encodeCreateParams,
  encodeH160,
  encodeH256,
  resolveBlock,
  toEthQuantity,
} from './eth-utils.js'

/**
 * Returns the chain ID used for signing replay-protected transactions.
 */
export const eth_chainId: Handler<[], string> = async (context) => {
  const block = context.chain.head
  const result = await block.call('EthereumRuntimeRPCApi_chain_id', ['0x'])
  return toEthQuantity(decodeU64LE(result.result as HexString))
}

/**
 * Returns the number of the most recent block.
 */
export const eth_blockNumber: Handler<[], string> = async (context) => {
  const block = context.chain.head
  return toEthQuantity(BigInt(block.number))
}

/**
 * Returns the balance of the account at the given address.
 */
export const eth_getBalance: Handler<[string, string?], string> = async (context, [address, blockTag]) => {
  const block = await resolveBlock(context, blockTag)
  const params = encodeH160(address)
  const result = await block.call('EthereumRuntimeRPCApi_account_basic', [params])
  const { balance } = decodeAccountBasic(result.result as HexString)
  return toEthQuantity(balance)
}

/**
 * Returns the number of transactions sent from an address.
 */
export const eth_getTransactionCount: Handler<[string, string?], string> = async (context, [address, blockTag]) => {
  const block = await resolveBlock(context, blockTag)
  const params = encodeH160(address)
  const result = await block.call('EthereumRuntimeRPCApi_account_basic', [params])
  const { nonce } = decodeAccountBasic(result.result as HexString)
  return toEthQuantity(nonce)
}

/**
 * Returns the code at a given address.
 */
export const eth_getCode: Handler<[string, string?], string> = async (context, [address, blockTag]) => {
  const block = await resolveBlock(context, blockTag)
  const params = encodeH160(address)
  const result = await block.call('EthereumRuntimeRPCApi_account_code_at', [params])
  // Result is a Vec<u8>
  const vec = decodeVec(result.result as string)
  return '0x' + vec.data
}

/**
 * Returns the value from a storage position at a given address.
 */
export const eth_getStorageAt: Handler<[string, string, string?], string> = async (
  context,
  [address, position, blockTag],
) => {
  const block = await resolveBlock(context, blockTag)
  // Encode (H160, H256) tuple — address + storage slot, no length prefix
  const params = (encodeH160(address) + encodeH256(position).replace(/^0x/, '')) as HexString
  const result = await block.call('EthereumRuntimeRPCApi_storage_at', [params])
  // Result is H256 (32 bytes) — return as-is
  return result.result
}

/**
 * Executes a new message call immediately without creating a transaction on the block chain.
 */
export const eth_call: Handler<[Record<string, any>, string?], string> = async (context, [txObject, blockTag]) => {
  const block = await resolveBlock(context, blockTag)

  // Contract-creation simulation: `to` missing/null → route to Frontier `create`.
  // Returns the deployed contract address (uncommon for eth_call, but spec-valid).
  if (!txObject.to) {
    const initCode = txObject.data || txObject.input
    if (!initCode) {
      throw new ResponseError(-32602, 'Missing required field: data (init code) for contract creation')
    }
    const params = encodeCreateParams({
      from: txObject.from,
      data: initCode,
      value: txObject.value ? BigInt(txObject.value) : undefined,
      gasLimit: txObject.gas ? BigInt(txObject.gas) : undefined,
      maxFeePerGas: txObject.maxFeePerGas ? BigInt(txObject.maxFeePerGas) : undefined,
      accessList: txObject.accessList,
      estimate: false,
    })
    const result = await block.call('EthereumRuntimeRPCApi_create', [params])
    const decoded = decodeCreateResult(result.result as HexString)
    if (!decoded.success) {
      throw new ResponseError(3, `execution reverted (contract creation)`)
    }
    return decoded.contractAddress
  }

  const params = encodeCallParams({
    from: txObject.from,
    to: txObject.to,
    data: txObject.data || txObject.input,
    value: txObject.value ? BigInt(txObject.value) : undefined,
    gasLimit: txObject.gas ? BigInt(txObject.gas) : undefined,
    maxFeePerGas: txObject.maxFeePerGas ? BigInt(txObject.maxFeePerGas) : undefined,
    accessList: txObject.accessList,
    estimate: false,
  })

  const result = await block.call('EthereumRuntimeRPCApi_call', [params])
  const decoded = decodeCallResult(result.result as HexString)

  if (!decoded.success) {
    throw new ResponseError(3, `execution reverted: ${decoded.returnData}`)
  }

  return decoded.returnData
}

/**
 * Generates and returns an estimate of how much gas is necessary to allow the transaction to complete.
 */
export const eth_estimateGas: Handler<[Record<string, any>, string?], string> = async (
  context,
  [txObject, blockTag],
) => {
  const block = await resolveBlock(context, blockTag)

  // Contract-creation gas estimate: `to` missing/null → route to Frontier `create`.
  if (!txObject.to) {
    const initCode = txObject.data || txObject.input
    if (!initCode) {
      throw new ResponseError(-32602, 'Missing required field: data (init code) for contract creation')
    }
    const params = encodeCreateParams({
      from: txObject.from,
      data: initCode,
      value: txObject.value ? BigInt(txObject.value) : undefined,
      gasLimit: txObject.gas ? BigInt(txObject.gas) : undefined,
      estimate: true,
    })
    const result = await block.call('EthereumRuntimeRPCApi_create', [params])
    const decoded = decodeCreateResult(result.result as HexString)
    if (!decoded.success) {
      throw new ResponseError(3, `gas estimation failed: contract creation would revert`)
    }
    return toEthQuantity(decoded.gasUsed)
  }

  const params = encodeCallParams({
    from: txObject.from,
    to: txObject.to,
    data: txObject.data || txObject.input,
    value: txObject.value ? BigInt(txObject.value) : undefined,
    gasLimit: txObject.gas ? BigInt(txObject.gas) : undefined,
    estimate: true,
  })

  const result = await block.call('EthereumRuntimeRPCApi_call', [params])
  const decoded = decodeCallResult(result.result as HexString)
  return toEthQuantity(decoded.gasUsed)
}

/**
 * Returns a synthetic Ethereum block object for a given block number or tag.
 * Since chopsticks doesn't store full Ethereum blocks, we construct a minimal
 * block object from Substrate block data to satisfy wallet queries.
 */
export const eth_getBlockByNumber: Handler<[string, boolean?], Record<string, any> | null> = async (
  context,
  [blockTag, _fullTransactions],
) => {
  const block = await resolveBlock(context, blockTag)
  if (!block) return null

  const blockNumber = toEthQuantity(BigInt(block.number))
  const blockHash = block.hash

  return {
    number: blockNumber,
    hash: blockHash,
    parentHash: (await block.parentBlock)?.hash ?? '0x' + '00'.repeat(32),
    nonce: '0x0000000000000000',
    sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
    logsBloom: '0x' + '00'.repeat(256),
    transactionsRoot: '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
    stateRoot: '0x' + '00'.repeat(32),
    receiptsRoot: '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
    miner: '0x' + '00'.repeat(20),
    difficulty: '0x0',
    totalDifficulty: '0x0',
    extraData: '0x',
    size: '0x0',
    gasLimit: '0x1312d00',
    gasUsed: '0x0',
    timestamp: '0x0',
    transactions: [],
    uncles: [],
    baseFeePerGas: '0x0',
  }
}

/**
 * Returns a synthetic Ethereum block object for a given block hash.
 */
export const eth_getBlockByHash: Handler<[string, boolean?], Record<string, any> | null> = async (
  context,
  [blockHash, _fullTransactions],
) => {
  const block = await context.chain.getBlock(blockHash as HexString)
  if (!block) return null

  const blockNumber = toEthQuantity(BigInt(block.number))

  return {
    number: blockNumber,
    hash: block.hash,
    parentHash: (await block.parentBlock)?.hash ?? '0x' + '00'.repeat(32),
    nonce: '0x0000000000000000',
    sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
    logsBloom: '0x' + '00'.repeat(256),
    transactionsRoot: '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
    stateRoot: '0x' + '00'.repeat(32),
    receiptsRoot: '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
    miner: '0x' + '00'.repeat(20),
    difficulty: '0x0',
    totalDifficulty: '0x0',
    extraData: '0x',
    size: '0x0',
    gasLimit: '0x1312d00',
    gasUsed: '0x0',
    timestamp: '0x0',
    transactions: [],
    uncles: [],
    baseFeePerGas: '0x0',
  }
}

/**
 * Returns the current gas price in wei.
 */
export const eth_gasPrice: Handler<[], string> = async (context) => {
  const block = context.chain.head
  const result = await block.call('EthereumRuntimeRPCApi_gas_price', ['0x'])
  // Result is U256 LE (32 bytes)
  const price = decodeU256LE(result.result as string)
  return toEthQuantity(price)
}

/**
 * Returns the current network ID.
 */
export const net_version: Handler<[], string> = async (context) => {
  const block = context.chain.head
  const result = await block.call('EthereumRuntimeRPCApi_chain_id', ['0x'])
  const chainId = decodeU64LE(result.result as HexString)
  return chainId.toString()
}

/**
 * Returns the current client version.
 */
export const web3_clientVersion: Handler<[], string> = async () => {
  return 'chopsticks/v1'
}

/**
 * Returns an empty array for accounts (no wallet management).
 */
export const eth_accounts: Handler<[], string[]> = async () => {
  return []
}

/**
 * Returns true if the client is syncing.
 */
export const eth_syncing: Handler<[], false> = async () => {
  return false
}

/**
 * Returns "1" for mainnet (stub).
 */
export const net_listening: Handler<[], boolean> = async () => {
  return true
}

/**
 * Returns the number of peers (always 0 for chopsticks).
 */
export const net_peerCount: Handler<[], string> = async () => {
  return '0x0'
}

/**
 * Submit a raw (RLP-encoded, EVM-signed) Ethereum transaction to the chain.
 *
 * Only works on chains that include Frontier's `pallet-ethereum` (e.g.
 * Hydration, Acala/Karura, Moonbeam). Decodes the raw tx via viem, rebuilds
 * the Frontier `TransactionV2` SCALE-encoded payload, wraps it in an unsigned
 * `Ethereum::transact` extrinsic, and pushes it into the txpool. Frontier's
 * `ValidateUnsigned` verifies the embedded EVM signature.
 *
 * Returns the keccak256 hash of the raw transaction (the Ethereum tx hash
 * the client expects), not the substrate extrinsic hash.
 */
export const eth_sendRawTransaction: Handler<[HexString], HexString> = async (context, [rawTx]) => {
  // 1. Decode the raw RLP Ethereum transaction (legacy / EIP-2930 / EIP-1559).
  let parsed: ReturnType<typeof parseTransaction>
  try {
    parsed = parseTransaction(rawTx)
  } catch (e: any) {
    throw new ResponseError(-32602, `Invalid raw transaction: ${e?.message ?? e}`)
  }

  // 2. Check the chain has pallet-ethereum.
  const block = context.chain.head
  const registry = await block.registry
  const meta = await block.meta
  const ethereumTx = (meta.tx as any)?.ethereum?.transact
  if (!ethereumTx) {
    throw new ResponseError(-32601, 'eth_sendRawTransaction: chain does not expose Ethereum.transact (no pallet-ethereum)')
  }

  // 3. Build the TransactionV3 enum variant matching the parsed type.
  //    V3 (used by current Frontier / Hydration) groups signature components
  //    under a `signature` field; V2 (older Frontier) had them flat. Field
  //    names follow polkadot.js's snake_case→camelCase convention.
  //
  //    Note: the type name in the runtime is `EthereumTransactionTransactionV3`
  //    (Frontier crate path → polkadot.js camelCase). We let polkadot.js
  //    resolve it via the metadata-aware tx builder below — passing the
  //    structure directly to `meta.tx.ethereum.transact(...)` and letting
  //    the registry construct the correct typed payload.
  const toAction = parsed.to ? { Call: parsed.to } : { Create: null }
  let transactionPayload: any
  if (parsed.type === 'eip1559') {
    transactionPayload = {
      EIP1559: {
        chainId: parsed.chainId,
        nonce: parsed.nonce,
        maxPriorityFeePerGas: parsed.maxPriorityFeePerGas,
        maxFeePerGas: parsed.maxFeePerGas,
        gasLimit: parsed.gas,
        action: toAction,
        value: parsed.value ?? 0n,
        input: parsed.data ?? '0x',
        accessList: parsed.accessList ?? [],
        signature: {
          oddYParity: parsed.yParity === 1,
          r: parsed.r,
          s: parsed.s,
        },
      },
    }
  } else if (parsed.type === 'eip2930') {
    transactionPayload = {
      EIP2930: {
        chainId: parsed.chainId,
        nonce: parsed.nonce,
        gasPrice: parsed.gasPrice,
        gasLimit: parsed.gas,
        action: toAction,
        value: parsed.value ?? 0n,
        input: parsed.data ?? '0x',
        accessList: parsed.accessList ?? [],
        signature: {
          oddYParity: parsed.yParity === 1,
          r: parsed.r,
          s: parsed.s,
        },
      },
    }
  } else {
    // legacy — signature is { v, r, s } here, no oddYParity
    transactionPayload = {
      Legacy: {
        nonce: parsed.nonce,
        gasPrice: parsed.gasPrice,
        gasLimit: parsed.gas,
        action: toAction,
        value: parsed.value ?? 0n,
        input: parsed.data ?? '0x',
        signature: {
          v: parsed.v,
          r: parsed.r,
          s: parsed.s,
        },
      },
    }
  }

  // 4. Build the unsigned Substrate extrinsic for `Ethereum.transact(tx)`.
  //    Frontier requires this to be unsigned — its custom `ValidateUnsigned`
  //    impl recovers the EVM signer and authorises the call. Using the
  //    metadata-built call function so polkadot.js handles the typed
  //    encoding (TransactionV2 vs V3) per the runtime's actual signature.
  const call = ethereumTx(transactionPayload)
  const extrinsic = registry.createType('Extrinsic', call, { version: 4 })
  const extrinsicHex = extrinsic.toHex() as HexString

  // 5. Submit. Returns blake2 of the extrinsic; the Ethereum client expects
  //    keccak256 of the raw tx instead, so we compute and return that.
  await context.chain.submitExtrinsic(extrinsicHex).catch((err: any) => {
    throw new ResponseError(-32603, `Failed to submit Ethereum transaction: ${err?.toString?.() ?? err}`)
  })

  // keccak256(rawTx) — viem doesn't export keccak directly without context,
  // and Frontier exposes `EthereumRuntimeRPCApi_account_basic` etc. The tx
  // hash is deterministic from the raw bytes; compute it via @polkadot/util-crypto.
  const { keccak256AsU8a } = await import('@polkadot/util-crypto')
  const ethTxHash = u8aToHex(keccak256AsU8a(hexToU8a(rawTx)))
  return ethTxHash as HexString
}
