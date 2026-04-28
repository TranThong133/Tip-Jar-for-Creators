import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Horizon,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';

import {
  CONTRACT_ID,
  HORIZON_URL,
  NETWORK_PASSPHRASE,
  RPC_URL,
  SUPPORTER_TOKEN_ID,
} from './config';
import { ContractError, decodeSimError } from './lib';
import { signXdr } from './wallet';

export {
  ContractError,
  type ContractErrorCategory,
  decodeSimError,
  stroopsToXlm,
  xlmToStroops,
} from './lib';

export const sorobanServer = new rpc.Server(RPC_URL);
export const horizonServer = new Horizon.Server(HORIZON_URL);

const tipContract = () => new Contract(CONTRACT_ID);
const supporterContract = () => new Contract(SUPPORTER_TOKEN_ID);

/**
 * Source account used only as a placeholder for read-only simulations.
 * RPC doesn't actually charge or commit anything for sims, so any structurally
 * valid Stellar address works. We default to the contract deployer.
 */
const READ_ONLY_SOURCE = 'GCVNQZPI76QNMDKFC5DVDXHUXFVM3ABHARWJ4DOFFACQ4F2E6KYYH63A';

export type TipRecord = {
  id: string;
  ledger: number;
  ledgerClosedAt: string;
  sender: string;
  creator: string;
  amount: bigint;
  message: string;
  timestamp: bigint;
  txHash?: string;
};


async function simulate(
  contract: Contract,
  fnName: string,
  args: xdr.ScVal[],
  source = READ_ONLY_SOURCE,
): Promise<rpc.Api.SimulateTransactionResponse> {
  const dummy = new Account(source, '0');
  const tx = new TransactionBuilder(dummy, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(fnName, ...args))
    .setTimeout(0)
    .build();
  return sorobanServer.simulateTransaction(tx);
}

async function readView<T>(
  contract: Contract,
  fnName: string,
  args: xdr.ScVal[] = [],
): Promise<T> {
  const sim = await simulate(contract, fnName, args);
  if (rpc.Api.isSimulationError(sim)) {
    throw new ContractError(`Read failed: ${sim.error}`, 'simulation');
  }
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) {
    throw new ContractError('Read returned no result.', 'simulation');
  }
  return scValToNative(sim.result.retval) as T;
}

// ──────────────────────────────────────────────────────────────────────────
// Read cache
//
// Soroban RPC reads are cheap but not free, and the UI calls them on every
// recipient-field keystroke + every feed poll. A short TTL cache keeps perceived
// latency low and avoids burning RPC budget. Successful tips invalidate the
// affected entries so stats appear fresh immediately.
// ──────────────────────────────────────────────────────────────────────────

type CacheEntry = { value: unknown; expiresAt: number };
const readCache = new Map<string, CacheEntry>();

async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const entry = readCache.get(key);
  if (entry && entry.expiresAt > Date.now()) {
    return entry.value as T;
  }
  const value = await fn();
  readCache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

/** Drop cache entries whose key starts with `prefix`. Use after a write. */
export function invalidateReads(prefix?: string): void {
  if (!prefix) {
    readCache.clear();
    return;
  }
  for (const key of readCache.keys()) {
    if (key.startsWith(prefix)) readCache.delete(key);
  }
}

const CREATOR_TTL_MS = 10_000; // creator stats: stable enough for 10s
const EVENTS_TTL_MS = 4_000;   // tip feed polled at 5s; 4s TTL dedupes overlap
const GLOBAL_TTL_MS = 15_000;

export async function getTotalReceived(creator: string): Promise<bigint> {
  return cached(`total:${creator}`, CREATOR_TTL_MS, async () => {
    const value = await readView<bigint | number>(tipContract(), 'total_received', [
      Address.fromString(creator).toScVal(),
    ]);
    return typeof value === 'bigint' ? value : BigInt(value);
  });
}

export async function getTipCount(creator: string): Promise<number> {
  return cached(`count:${creator}`, CREATOR_TTL_MS, async () => {
    const value = await readView<number | bigint>(tipContract(), 'tip_count_for', [
      Address.fromString(creator).toScVal(),
    ]);
    return Number(value);
  });
}

export async function getGlobalCount(): Promise<bigint> {
  return cached('global', GLOBAL_TTL_MS, async () => {
    const value = await readView<bigint | number>(tipContract(), 'global_count');
    return typeof value === 'bigint' ? value : BigInt(value);
  });
}

/** Read the supporter-token balance for `id` on the deployed L4 token. */
export async function getSupporterBalance(id: string): Promise<bigint> {
  return cached(`supporter:${id}`, CREATOR_TTL_MS, async () => {
    const value = await readView<bigint | number>(supporterContract(), 'balance', [
      Address.fromString(id).toScVal(),
    ]);
    return typeof value === 'bigint' ? value : BigInt(value);
  });
}

/**
 * Send a tip via the contract: simulate → assemble → sign → submit → poll.
 * Returns the transaction hash on success.
 */
export async function sendTip(opts: {
  sender: string;
  creator: string;
  amountStroops: bigint;
  message: string;
  onStatus?: (status:
    | 'preparing'
    | 'signing'
    | 'submitting'
    | 'confirming') => void;
}): Promise<string> {
  const { sender, creator, amountStroops, message, onStatus } = opts;

  onStatus?.('preparing');

  let sourceAccount: Account;
  try {
    sourceAccount = await sorobanServer.getAccount(sender);
  } catch (err) {
    throw new ContractError(
      `Could not load account from RPC: ${(err as Error).message}`,
      'rpc',
    );
  }

  const args = [
    Address.fromString(sender).toScVal(),
    Address.fromString(creator).toScVal(),
    nativeToScVal(amountStroops, { type: 'i128' }),
    nativeToScVal(message, { type: 'string' }),
  ];

  const baseTx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(tipContract().call('tip', ...args))
    .setTimeout(60)
    .build();

  const sim = await sorobanServer.simulateTransaction(baseTx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new ContractError(decodeSimError(sim.error), 'simulation');
  }

  const prepared = rpc.assembleTransaction(baseTx, sim).build();

  onStatus?.('signing');
  let signedXdr: string;
  try {
    signedXdr = await signXdr(prepared.toXDR(), sender);
  } catch (err) {
    throw new ContractError(
      (err as Error)?.message || 'Signing was rejected.',
      'rejected',
    );
  }

  onStatus?.('submitting');
  const signedTx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  const sendRes = await sorobanServer.sendTransaction(signedTx);
  if (sendRes.status === 'ERROR') {
    throw new ContractError(
      `Submission rejected: ${sendRes.errorResult?.result().switch().name ?? 'unknown'}`,
      'submission',
    );
  }

  onStatus?.('confirming');
  let getRes = await sorobanServer.getTransaction(sendRes.hash);
  const start = Date.now();
  while (getRes.status === 'NOT_FOUND') {
    if (Date.now() - start > 30_000) {
      throw new ContractError(
        'Timed out waiting for confirmation.',
        'rpc',
      );
    }
    await new Promise((r) => setTimeout(r, 1500));
    getRes = await sorobanServer.getTransaction(sendRes.hash);
  }

  if (getRes.status !== 'SUCCESS') {
    throw new ContractError(
      `Transaction failed on-chain: ${getRes.status}`,
      'submission',
    );
  }

  // Invalidate cached reads so the UI reflects the new tip immediately.
  invalidateReads(`total:${creator}`);
  invalidateReads(`count:${creator}`);
  invalidateReads(`supporter:${sender}`);
  invalidateReads('global');
  invalidateReads('events:');

  return sendRes.hash;
}


/** Fetch recent `tip` events emitted by the contract. */
export async function fetchRecentTipEvents(opts: {
  ledgersBack?: number;
  limit?: number;
} = {}): Promise<TipRecord[]> {
  // ~7h of ledgers — stays well within Soroban testnet RPC retention.
  const { ledgersBack = 5_000, limit = 100 } = opts;
  return cached(`events:${ledgersBack}:${limit}`, EVENTS_TTL_MS, () =>
    fetchTipEventsFresh(ledgersBack, limit),
  );
}

async function fetchTipEventsFresh(
  ledgersBack: number,
  limit: number,
): Promise<TipRecord[]> {
  const latest = await sorobanServer.getLatestLedger();
  const startLedger = Math.max(latest.sequence - ledgersBack, 1);

  let result;
  try {
    result = await sorobanServer.getEvents({
      startLedger,
      filters: [
        {
          type: 'contract',
          contractIds: [CONTRACT_ID],
        },
      ],
      limit,
    });
  } catch (err) {
    console.error('[tipjar] getEvents failed', { startLedger, err });
    throw err;
  }

  console.debug('[tipjar] getEvents', {
    contractId: CONTRACT_ID,
    startLedger,
    latestLedger: latest.sequence,
    eventCount: result.events.length,
  });

  const records: TipRecord[] = [];
  for (const ev of result.events) {
    try {
      const value = scValToNative(ev.value) as
        | [string, bigint, string, bigint]
        | undefined;
      if (!value) continue;
      const topics = ev.topic.map((t) => scValToNative(t));
      // Topic[0] is the symbol "tip"; topic[1] is the creator address.
      // We don't gate on the symbol match (only one event type today) so a
      // future-rename-without-frontend-update doesn't silently empty the feed.
      const creator = String(topics[1] ?? '');
      const [senderRaw, amount, message, timestamp] = value;
      records.push({
        id: ev.id,
        ledger: ev.ledger,
        ledgerClosedAt: ev.ledgerClosedAt,
        sender: String(senderRaw),
        creator,
        amount:
          typeof amount === 'bigint' ? amount : BigInt(amount as unknown as string),
        message: String(message ?? ''),
        timestamp:
          typeof timestamp === 'bigint'
            ? timestamp
            : BigInt(timestamp as unknown as string),
        txHash: ev.txHash,
      });
    } catch (err) {
      console.warn('[tipjar] failed to decode event', ev, err);
    }
  }
  // Newest first.
  return records.reverse();
}

/** Fetch the user's native XLM balance from Horizon. */
export async function fetchXlmBalance(publicKey: string): Promise<{
  balance: string;
  funded: boolean;
}> {
  try {
    const account = await horizonServer.loadAccount(publicKey);
    const native = account.balances.find((b) => b.asset_type === 'native');
    return { balance: native?.balance ?? '0', funded: true };
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 404) return { balance: '0', funded: false };
    throw err;
  }
}
