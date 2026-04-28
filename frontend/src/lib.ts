// Pure helpers, kept dependency-free so tests can import them without
// pulling in the wallet kit or Stellar SDK (both have CJS interop quirks).

import { STROOPS_PER_XLM } from './config';

export type ContractErrorCategory =
  | 'simulation'
  | 'submission'
  | 'rejected'
  | 'rpc'
  | 'validation';

export class ContractError extends Error {
  category: ContractErrorCategory;

  constructor(message: string, category: ContractErrorCategory) {
    super(message);
    this.name = 'ContractError';
    this.category = category;
  }
}

/** Convert a user-facing XLM string ("1.5") into stroops as bigint. */
export function xlmToStroops(xlm: string): bigint {
  const trimmed = xlm.trim();
  if (!/^-?\d+(\.\d{1,7})?$/.test(trimmed)) {
    throw new ContractError(
      'Amount must be a number with up to 7 decimals.',
      'validation',
    );
  }
  const negative = trimmed.startsWith('-');
  const body = negative ? trimmed.slice(1) : trimmed;
  const [whole, frac = ''] = body.split('.');
  const padded = (frac + '0000000').slice(0, 7);
  const magnitude = BigInt(whole) * STROOPS_PER_XLM + BigInt(padded || '0');
  const stroops = negative ? -magnitude : magnitude;
  if (stroops <= 0n) {
    throw new ContractError('Amount must be greater than 0.', 'validation');
  }
  return stroops;
}

export function stroopsToXlm(stroops: bigint | number | string): string {
  const value = typeof stroops === 'bigint' ? stroops : BigInt(stroops);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / STROOPS_PER_XLM;
  const frac = (magnitude % STROOPS_PER_XLM)
    .toString()
    .padStart(7, '0')
    .replace(/0+$/, '');
  const formatted = frac ? `${whole}.${frac}` : whole.toString();
  return negative ? `-${formatted}` : formatted;
}

/**
 * Translate a raw Soroban simulation error into something a user can act on.
 * Falls back to a truncated raw message if no rule matches.
 */
export function decodeSimError(raw: string): string {
  if (raw.includes('amount must be positive')) return 'Amount must be greater than 0.';
  if (raw.includes('message too long')) return 'Message must be 140 characters or fewer.';
  if (raw.toLowerCase().includes('insufficient')) return 'Insufficient balance to send this tip.';
  if (raw.includes('TrustLine')) return 'Sender or recipient is missing the trustline.';
  if (raw.includes('Account_does_not_exist')) {
    return 'Sender account does not exist on testnet (fund it first).';
  }
  return `Simulation failed: ${raw.slice(0, 240)}`;
}
