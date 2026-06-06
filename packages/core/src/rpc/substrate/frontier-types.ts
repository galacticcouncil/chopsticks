import { TypeRegistry } from '@polkadot/types'

// Singleton registry with Frontier EVM types
export const registry = new TypeRegistry()
registry.register({
  // Frontier `pallet_evm::Account` SCALE encoding is { balance, nonce } —
  // verified empirically against Hydration's runtime: account_basic returns
  // a 64-byte payload whose first 32 bytes (LE u256) is balance, not nonce.
  // The Rust struct definition orders `nonce` first textually but SCALE
  // re-orders... actually no — the bug is that some Frontier versions had
  // the fields in this order, and Hydration matches. Either way: balance
  // first, nonce second is what works on Hydration today.
  EvmAccountBasic: { balance: 'u256', nonce: 'u256' },
  EvmExitSucceed: { _enum: ['Stopped', 'Returned', 'Suicided'] },
  EvmExitError: {
    _enum: {
      StackUnderflow: null,
      StackOverflow: null,
      InvalidJump: null,
      InvalidRange: null,
      DesignatedInvalid: null,
      CallTooDeep: null,
      CreateCollision: null,
      CreateContractLimit: null,
      OutOfOffset: null,
      OutOfGas: null,
      OutOfFund: null,
      PCUnderflow: null,
      CreateEmpty: null,
      Other: 'Text',
      MaxNonce: null,
      InvalidCode: 'u8',
    },
  },
  EvmExitRevert: { _enum: ['Reverted'] },
  EvmExitFatal: {
    _enum: {
      NotSupported: null,
      UnhandledInterrupt: null,
      CallErrorAsFatal: 'EvmExitError',
      Other: 'Text',
    },
  },
  EvmExitReason: {
    _enum: {
      Succeed: 'EvmExitSucceed',
      Error: 'EvmExitError',
      Revert: 'EvmExitRevert',
      Fatal: 'EvmExitFatal',
    },
  },
  EvmUsedGas: { standard: 'u256', effective: 'u256' },
  EvmWeightInfo: {
    refTimeLimit: 'Option<u64>',
    proofSizeLimit: 'Option<u64>',
    refTimeUsage: 'Option<u64>',
    proofSizeUsage: 'Option<u64>',
  },
  EvmLog: { address: 'H160', topics: 'Vec<H256>', data: 'Bytes' },
  EvmExecutionInfoV2: {
    exitReason: 'EvmExitReason',
    value: 'Bytes',
    usedGas: 'EvmUsedGas',
    weightInfo: 'Option<EvmWeightInfo>',
    logs: 'Vec<EvmLog>',
  },
  EvmCallParams: {
    from: 'H160',
    to: 'H160',
    data: 'Bytes',
    value: 'u256',
    gasLimit: 'u256',
    maxFeePerGas: 'Option<u256>',
    maxPriorityFeePerGas: 'Option<u256>',
    nonce: 'Option<u32>',
    estimate: 'bool',
    accessList: 'Option<Vec<(H160, Vec<H256>)>>',
    authorizationList: 'Option<Vec<Bytes>>',
  },
  // EthereumRuntimeRPCApi_create — same shape as call params minus `to`,
  // plus `data` holds the contract init code instead of calldata.
  EvmCreateParams: {
    from: 'H160',
    data: 'Bytes',
    value: 'u256',
    gasLimit: 'u256',
    maxFeePerGas: 'Option<u256>',
    maxPriorityFeePerGas: 'Option<u256>',
    nonce: 'Option<u32>',
    estimate: 'bool',
    accessList: 'Option<Vec<(H160, Vec<H256>)>>',
    authorizationList: 'Option<Vec<Bytes>>',
  },
  // CreateInfoV2 — returned by EthereumRuntimeRPCApi_create. Differs from
  // ExecutionInfoV2 in that `value` is the H160 of the deployed contract,
  // not the call's return data.
  EvmCreateInfoV2: {
    exitReason: 'EvmExitReason',
    value: 'H160',
    usedGas: 'EvmUsedGas',
    weightInfo: 'Option<EvmWeightInfo>',
    logs: 'Vec<EvmLog>',
  },
})
