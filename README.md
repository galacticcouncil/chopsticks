# Chopsticks · Galactic Council edition

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/chopsticks-logo-white.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/chopsticks-logo-dark.svg">
  <img width="100%" alt="chopsticks logo" src="docs/chopsticks-logo-dark.svg">
</picture>

Fork any Substrate chain into a local parallel reality — then point a real dApp at it.

This is the [Galactic Council](https://github.com/galacticcouncil) fork of
[AcalaNetwork/chopsticks](https://github.com/AcalaNetwork/chopsticks), tuned for
**Hydration**: it speaks Ethereum JSON-RPC to Frontier chains, survives long-running
sessions under sustained dApp load, and ships ready-made Hydration configs.

## Quick start

```bash
# fork Hydration mainnet
npx @galacticcouncil/chopsticks@latest -c configs/hydradx.yml

# or any endpoint directly
npx @galacticcouncil/chopsticks@latest --endpoint=wss://hydration-rpc.n.dwellir.com
```

The fork listens on `ws://localhost:8000` (and HTTP on the same port). Point polkadot.js
apps, a wallet, or your dApp at it and go.

## Why this fork

Advantages over upstream `@acala-network/chopsticks`:

- **Ethereum JSON-RPC surface** → upstream has none; here Frontier chains (Hydration,
  Acala EVM+, Moonbeam-alikes) answer `eth_*`/`net_*`/`web3_*`, so MetaMask, viem,
  ethers, and dApp EVM code paths work against the fork unmodified:
  - reads: `eth_call`, `eth_getBalance`, `eth_getCode`, `eth_getStorageAt`,
    `eth_getTransactionCount`, `eth_getBlockByNumber`/`ByHash`, `eth_getLogs`
  - writes: `eth_sendRawTransaction` (Frontier `Ethereum.transact` with real EVM
    signature validation), `eth_estimateGas` incl. contract creation
  - receipts & fees: `eth_getTransactionByHash`, `eth_getTransactionReceipt`,
    `eth_gasPrice`, `eth_feeHistory`, `eth_maxPriorityFeePerGas`
  - wallet-probe stubs: `eth_chainId`, `eth_accounts`, `eth_syncing`, `net_version`, …
- **Long-running forks don't OOM** → upstream pins every storage read forever (per-block
  read caches, subscription state, per-block decorated metadata), so a fork serving a
  dApp while producing blocks dies with a V8 heap OOM after a few hundred blocks. Here
  read caches are evicted as head advances, block diffs contain only real writes, and
  metadata is decorated once per runtime version. Memory plateaus instead of climbing.
- **Bounded remote-storage cache** → values fetched from the upstream node land in a
  shared LRU (`CHOPSTICKS_STORAGE_CACHE_MB`, default 128) instead of growing without limit.
- **Configurable `eth_getLogs` range** → `eth-get-logs-max-range` (default 10000,
  `0` = unlimited) instead of upstream-style hardcoded caps; wide scans stream block by
  block instead of pinning the whole range in memory.
- **Fast full-map iteration** → `state_getKeysPaged` prefetches each key page's values
  in a single upstream round-trip, so `.entries()` over Hydration's ~1450-asset
  registry takes ~1s cold / ~10ms warm instead of 13s+ of key-by-key fetches.
- **Runtime-call result cache** → runtime execution is deterministic per block state,
  so repeated `state_call`s (dApp boot retries, router-graph rebuilds, wallet polling)
  return from cache in ~1ms instead of re-executing wasm. Invalidated on any storage
  mutation (`dev_setStorage`, block building, snapshot restore); sized with
  `runtime-call-cache-mb` (default 6400, `0` disables).
- **Head progression under load** → block building jumps the wasm-executor queue ahead
  of queued RPC traffic and batch-prefetches the previous build's storage read-set, so
  empty blocks build in ~2s idle and ~5s under a full dApp boot storm instead of 40s+.
  Anti-starvation aging guarantees reads still get through under continuous Instant-mode
  block production. (First build on a fresh fork point is still slow — its read-set is
  unknowable.)
- **Executor hardening** → zstd-compressed runtimes are decompressed once on the main
  thread (no ruzstd OOM panics), executor worker errors no longer crash the whole
  process, and concurrent wasm calls are serialized instead of racing.
- **No silent drops** → extrinsics that fail at `apply_extrinsic` during block building
  are logged with the decoded call and error; upstream swallows them.
- **`npx` actually works** → the published package resolves `@acala-network/chopsticks-db`
  correctly (upstream's bin was broken for a while).
- **Hydration configs** → [`configs/hydradx.yml`](configs/hydradx.yml) (funded dev
  accounts, mock signatures), [`configs/hydradx-mainnet.yml`](configs/hydradx-mainnet.yml)
  (mainnet-fork dry-runs).

Everything else — XCM multichain setups, `run-block`, `try-runtime`, storage overrides,
time travel — works as documented upstream.

## Using the EVM RPC

```bash
# fork with a persistent db so storage reads are cached across restarts
npx @galacticcouncil/chopsticks@latest -c configs/hydradx.yml

# then, e.g.
curl -s http://localhost:8000 -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
```

Notes:

- `eth_sendRawTransaction` accepts legacy / EIP-2930 / EIP-1559 raw transactions,
  wraps them in an unsigned `Ethereum.transact`, and returns the Ethereum tx hash.
  Frontier's `ValidateUnsigned` checks the embedded EVM signature — rejections
  (bad nonce, insufficient balance, wrong chainId) surface as JSON-RPC errors.
  Poll `eth_getTransactionReceipt` for inclusion, as wallets already do.
- `eth_getLogs` scans Frontier's per-block transaction statuses. Cap the range per
  query with `eth-get-logs-max-range` (YAML or CLI flag).
- Blocks are synthetic on the Substrate side; Ethereum state/receipt/tx roots in
  `eth_getBlockBy*` are stubbed — consensus-grade fields are not reconstructed.

## Configuration

YAML config file (see [configs/](configs/) for examples), every key doubles as a CLI flag:

```yaml
endpoint: wss://hydration-rpc.n.dwellir.com # or a list for failover
port: 8000
block: ${env.HYDRADX_BLOCK_NUMBER} # env templating supported
db: ./hydradx.db.sqlite # persistent storage cache
mock-signature-host: true # accept 0xdeadbeef... fake signatures
build-block-mode: Batch # Batch | Instant | Manual
eth-get-logs-max-range: 10000 # 0 = unlimited
runtime-call-cache-mb: 6400 # 0 = disabled
max-memory-block-count: 500
runtime-log-level: 0
wasm-override: ./runtime.compact.compressed.wasm
import-storage: # storage overrides at fork point
  System:
    Account: [[['5Grwva...'], { providers: 1, data: { free: '1000000000000000' } }]]
resume: true # resume from latest block in db
```

Environment variables:

- `CHOPSTICKS_STORAGE_CACHE_MB` — shared remote-storage LRU size, default 128.
  Process-global (all chains in an XCM setup share it), hence env rather than YAML.
- `LOG_LEVEL` — `trace|debug|info|warn|error`.
- `http_proxy` / `https_proxy` are respected.

Useful dev RPCs once running: `dev_newBlock` (`{count, transactions, unsafeBlockHeight}`),
`dev_setStorage`, `dev_timeTravel`, `dev_dryRun`, `dev_setHead`.

## Install from source

Rust ≥ 1.64 required for the wasm executor.

```bash
git clone --recurse-submodules https://github.com/galacticcouncil/chopsticks.git && cd chopsticks
yarn
yarn build-wasm # don't use IDE built-in wasm build tools
yarn build
npx tsx packages/chopsticks/src/cli.ts -c configs/hydradx.yml # run from source
```

Note: `bun` is not recommended — its WASM support can hang the instance.

## Upstream documentation

Unchanged upstream features are documented in the
[upstream wiki](https://github.com/AcalaNetwork/chopsticks/wiki) and repo:

- [XCM multichain testing & `@acala-network/chopsticks-testing`](https://github.com/AcalaNetwork/chopsticks#testing-with-acala-networkchopsticks-testing)
- [run-block / storage-diff plugins](packages/chopsticks/src/plugins/run-block/)
- [EVM+ transaction tracing](packages/chopsticks/src/plugins/trace-transaction/README.md)
- [try-runtime CLI](packages/chopsticks/src/plugins/try-runtime/README.md)
- [fetch-storages / prefetching big migrations](https://github.com/AcalaNetwork/chopsticks#testing-big-migrations)

## FAQ

- **What is mocked?** Tx pool, inherents, block finalization, and XCM channels are
  simulated — anything beyond the onchain state transition `new_state = f(old_state)`
  may behave differently in production.
- **Change a pallet constant?** Not possible at runtime — build a new wasm and use
  `wasm-override`.
- **The fork OOMs anyway?** Raise `NODE_OPTIONS=--max-old-space-size=...` and lower
  `CHOPSTICKS_STORAGE_CACHE_MB` / `max-memory-block-count`, then open an issue with the
  workload — bounded memory under sustained load is a feature of this fork, regressions
  are bugs.
- **dApp boot is still slow on first load?** A cold fork of a large-state chain pays
  one upstream round-trip per key page plus wasm execution per runtime call. Use a
  persistent `db:` (second boot reads from sqlite), consider `prefetch-storages:` for
  hot prefixes (e.g. `[AssetRegistry, Omnipool, XYK, Stableswap]`), and bump your
  client's RPC timeout above the default 60s for the first cold pass.
