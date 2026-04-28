# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Stellar Tip Jar — multi-belt submission shipping L1 + L2 + L3 + L4:

- `frontend/` — React 19 + TypeScript + Vite dApp. Uses **`@creit.tech/stellar-wallets-kit`** (multi-wallet picker) and **`@stellar/stellar-sdk`** v15. Talks to **Soroban RPC** (`https://soroban-testnet.stellar.org`) for contract calls + events, and Horizon (`https://horizon-testnet.stellar.org`) only for the wallet's XLM balance. Vitest test suite under `src/lib.test.ts`.
- `contracts/` — Soroban Rust workspace.
  - `hello-world/` — original scaffold from L1, unused at runtime.
  - `tip-jar/` — L2/L4 contract: `tip()` transfers native XLM via the SAC, records on-chain stats, **calls `SupporterToken.mint()` via `env.invoke_contract` (L4 inter-contract call)**, and emits `(symbol_short!("tip"), creator)` events. View functions: `total_received`, `tip_count_for`, `recent_tips`, `global_count`, `native_token`, `supporter_token`. Constructor takes `(native_token, supporter_token)` — both must be set before deploy.
  - `supporter-token/` — L4 minimal SEP-41 token (`mint`, `transfer`, `approve/allowance`, `transfer_from`, `burn/burn_from`, `set_admin`, `total_supply`). Implements `TokenInterface` so `token::Client` works for reads.
- `.github/workflows/ci.yml` — runs `cargo test --workspace` and `npm test && npm run build` on push/PR.

**Deployed testnet contracts:**

| Belt | Contract | Address |
| --- | --- | --- |
| L4 active | TipJar v2 | `CCJ62UKISYB5I5UIPIRHVO7YZ4BZVB7F2UY4NZDC6ILNEHRWIMFT4PCS` |
| L4 active | SupporterToken (SEP-41) | `CBNWKE6TH6MGAKIGJFWOT6ZXGXA5PK6GOYGVVP3W7VVK2PPCV5TZY7F4` (admin = TipJar v2) |
| L2 reference | TipJar v1 (no supporter mint) | `CBAZVLIITFNYXSIBCWGKDZ2JESTWIB4ZWAWXLKVP2TY2DTSUL5DMQMWL` |
| Network | Native XLM SAC | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |

The frontend defaults to TipJar v2 + SupporterToken; override locally with `VITE_CONTRACT_ID=…` and `VITE_SUPPORTER_TOKEN_ID=…` in `frontend/.env` if you redeploy.

**Inter-contract auth gotcha**: when writing tests for `tip()` (which sub-invokes `mint`), use `env.mock_all_auths_allowing_non_root_auth()` — plain `mock_all_auths()` only mocks the root call and the inner SAC admin auth check fails with "authorization not tied to the root contract invocation".

## Commands

### Frontend (run from `frontend/`)

- Install: `npm install`
- Dev server: `npm run dev` (default port 5173)
- Production build: `npm run build` (outputs to `frontend/dist`; runs `tsc -b` first, so type errors fail the build)
- Preview built bundle: `npm run preview`
- Lint: `npm run lint`
- Tests: `npm test` (one-off) or `npm run test:watch` — runs Vitest in Node mode against `src/lib.test.ts`

Optional `frontend/.env` (copied from `.env.example`) supports `VITE_CREATOR_ADDRESS=G...`, `VITE_CONTRACT_ID=C...`, `VITE_SUPPORTER_TOKEN_ID=C...`.

### Contracts

Run from the repo root or from a specific contract directory (each contract has its own `Makefile` mirroring these targets):

- Build all contracts to Wasm: `stellar contract build` — output lands in `target/wasm32v1-none/release/*.wasm`.
- Run tests: `cargo test` (the contract `Makefile` runs `build` first; plain `cargo test` works for unit tests since they use the `testutils` feature).
- Run a single test: `cargo test -p <contract-name> <test_name>` (e.g. `cargo test -p hello-world test`).
- Format: `cargo fmt --all`.
- Clean: `cargo clean`.

The `stellar` CLI must be installed; `cargo build` alone won't produce a valid contract Wasm because the release profile and target triple are configured for Soroban.

## Architecture

### Frontend

Split into five modules under `frontend/src/`:

- `config.ts` — single source of truth for `CONTRACT_ID`, `NETWORK_PASSPHRASE`, `RPC_URL`, `HORIZON_URL`, `NATIVE_SAC`, `STROOPS_PER_XLM`. Env-overridable via `VITE_CONTRACT_ID`, `VITE_CREATOR_ADDRESS`.
- `lib.ts` — **dependency-free** pure helpers (`xlmToStroops`, `stroopsToXlm`, `ContractError`, `decodeSimError`). Lives in its own file so `lib.test.ts` (Vitest) can import without pulling in the wallet kit (which has CJS/ESM interop issues under Vitest's Node mode). When adding new pure helpers that you'll want to test, put them here.
- `wallet.ts` — wraps `@creit.tech/stellar-wallets-kit` v2.x. The kit's API is **all static** — `StellarWalletsKit.init(...)` runs once at module load with `defaultModules()` (imported from `@creit.tech/stellar-wallets-kit/modules/utils`, NOT the package root) and `FREIGHTER_ID` (from `…/modules/freighter`). Exposes `pickWallet()` (returns address from `authModal()`), `signXdr()`, `disconnectWallet()`. Note: kit's exported `Networks` enum collides with `stellar-sdk`'s `Networks`; we alias it as `KitNetworks` here.
- `contract.ts` — Soroban call orchestration. Re-exports the pure helpers from `lib.ts` for backward compatibility. Read functions use `simulateTransaction` against a placeholder source (`READ_ONLY_SOURCE` = the deployer's address) and are wrapped in a small TTL cache (10 s for creator stats, 4 s for events, 15 s for global counter). `sendTip()` runs the full pipeline: `getAccount` → build `Contract.call('tip', …)` → `simulateTransaction` → `rpc.assembleTransaction(...).build()` → `signXdr` → `sendTransaction` → poll `getTransaction` until `SUCCESS` (30 s timeout) → `invalidateReads(...)` to flush relevant cache entries. Events are fetched via `getEvents` over the last ~7 h of ledgers (deliberately under the testnet retention window) and decoded with `scValToNative`. The decoder is intentionally lenient — it doesn't gate on `topic[0] === 'tip'` because Symbol→string conversion edge cases used to silently empty the feed.
- `App.tsx` — UI: connect/disconnect, wallet card, tip form with creator-stats card (live reads of `total_received` / `tip_count_for` whenever the recipient field holds a valid address), and a 5 s-polled tip feed with up to 20 entries. Skeleton placeholders render while initial data loads. Tx status is a discriminated union with stages `preparing → signing → submitting → confirming`.

The cache lives in a module-level `Map` in `contract.ts` — fine for a single-page app, but if you add SSR or worker contexts later, move it behind a request-scoped store.

Amount handling: user enters XLM, `xlmToStroops` converts to a `bigint` of stroops (1 XLM = 10⁷ stroops). The contract stores i128; the SDK's `nativeToScVal(amount, { type: 'i128' })` accepts bigints directly. Don't multiply with `Number` — use `bigint` arithmetic to avoid precision loss.

`tsconfig.app.json` has `erasableSyntaxOnly: true` and `verbatimModuleSyntax: true` set, so:
- No constructor parameter properties (write `class C extends Error { x: T; constructor(...) { ...; this.x = ... } }`).
- All type-only imports must use `import type`.

### Contracts

- **Workspace layout** (`Cargo.toml`): `members = ["contracts/*"]`, with `soroban-sdk = "25"` pinned as a workspace dependency. New contracts go under `contracts/<name>/` and inherit the SDK from the workspace.
- **Per-contract crate** (`contracts/<name>/Cargo.toml`): must declare `crate-type = ["lib", "cdylib"]` (cdylib for the Wasm artifact, lib so other crates and tests can link to it) and `doctest = false`. Pull `soroban-sdk` from `workspace = true`, and add it again under `[dev-dependencies]` with `features = ["testutils"]` to enable `Env::default()` and `env.register(...)` in tests.
- **Contract source** (`src/lib.rs`): `#![no_std]` is required. Define a unit struct annotated with `#[contract]`, then `#[contractimpl] impl ContractName { ... }`. Public methods on that impl take `env: Env` as the first argument and become the contract's externally callable entry points. The macro generates `ContractNameClient` (e.g. `ContractClient`) used in tests.
- **Tests** (`src/test.rs`, gated by `#![cfg(test)]`): build an `Env::default()`, register the contract via `env.register(Contract, ())`, construct the generated client (`ContractClient::new(&env, &contract_id)`), then call methods. Pass Soroban types (`String::from_str(&env, "...")`, `vec![&env, ...]`) — not stdlib equivalents.
- **Release profile**: tuned for tiny Wasm (`opt-level = "z"`, `lto = true`, `panic = "abort"`, `strip = "symbols"`, `codegen-units = 1`). A `release-with-logs` profile inherits from `release` but re-enables `debug-assertions` for on-chain logging during development.

## Adding a new contract

Create `contracts/<name>/` with a `Cargo.toml` matching the `hello-world` pattern (workspace SDK, `lib`+`cdylib`, `testutils` dev-dep) and `src/lib.rs` with `#![no_std]` plus `#[contract]`/`#[contractimpl]`. The workspace globs members from `contracts/*`, so no top-level edit is needed.
