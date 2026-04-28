import { Networks } from '@stellar/stellar-sdk';

// L4 (Green Belt) TipJar v2 — adds an inter-contract call that mints
// supporter tokens to every tipper. The L2 contract is preserved on-chain
// at CBAZVLIITFNYXSIBCWGKDZ2JESTWIB4ZWAWXLKVP2TY2DTSUL5DMQMWL.
export const CONTRACT_ID =
  (import.meta.env.VITE_CONTRACT_ID as string | undefined) ??
  'CCJ62UKISYB5I5UIPIRHVO7YZ4BZVB7F2UY4NZDC6ILNEHRWIMFT4PCS';

export const SUPPORTER_TOKEN_ID =
  (import.meta.env.VITE_SUPPORTER_TOKEN_ID as string | undefined) ??
  'CBNWKE6TH6MGAKIGJFWOT6ZXGXA5PK6GOYGVVP3W7VVK2PPCV5TZY7F4';

export const NETWORK_PASSPHRASE = Networks.TESTNET;
export const RPC_URL = 'https://soroban-testnet.stellar.org';
export const HORIZON_URL = 'https://horizon-testnet.stellar.org';
export const NATIVE_SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

export const DEFAULT_RECIPIENT =
  (import.meta.env.VITE_CREATOR_ADDRESS as string | undefined) ?? '';

// XLM is 7 decimals; user-facing amounts are XLM, on-chain amounts are stroops.
export const STROOPS_PER_XLM = 10_000_000n;
