import { describe, expect, it } from 'vitest';
import {
  ContractError,
  decodeSimError,
  stroopsToXlm,
  xlmToStroops,
} from './lib';

describe('xlmToStroops', () => {
  it('converts whole XLM amounts to stroops', () => {
    expect(xlmToStroops('1')).toBe(10_000_000n);
    expect(xlmToStroops('100')).toBe(1_000_000_000n);
  });

  it('converts fractional XLM up to 7 decimals', () => {
    expect(xlmToStroops('0.5')).toBe(5_000_000n);
    expect(xlmToStroops('1.2345678')).toBe(12_345_678n);
    expect(xlmToStroops('0.0000001')).toBe(1n);
  });

  it('trims whitespace', () => {
    expect(xlmToStroops('  2.5  ')).toBe(25_000_000n);
  });

  it('throws ContractError(validation) for non-numeric input', () => {
    expect(() => xlmToStroops('abc')).toThrow(ContractError);
    try {
      xlmToStroops('abc');
    } catch (err) {
      expect((err as ContractError).category).toBe('validation');
    }
  });

  it('throws for too many decimal places', () => {
    expect(() => xlmToStroops('1.12345678')).toThrow(ContractError);
  });

  it('throws for zero amount', () => {
    expect(() => xlmToStroops('0')).toThrow(/must be greater than 0/);
  });

  it('throws for negative amount', () => {
    expect(() => xlmToStroops('-1')).toThrow(ContractError);
  });
});

describe('stroopsToXlm', () => {
  it('formats whole-stroop amounts without trailing decimals', () => {
    expect(stroopsToXlm(10_000_000n)).toBe('1');
    expect(stroopsToXlm(1_000_000_000n)).toBe('100');
  });

  it('preserves fractional XLM and strips trailing zeros', () => {
    expect(stroopsToXlm(5_000_000n)).toBe('0.5');
    expect(stroopsToXlm(12_345_678n)).toBe('1.2345678');
    expect(stroopsToXlm(1n)).toBe('0.0000001');
  });

  it('round-trips with xlmToStroops for representative values', () => {
    for (const xlm of ['0.5', '1', '7.25', '0.0000001', '12345']) {
      expect(stroopsToXlm(xlmToStroops(xlm))).toBe(xlm);
    }
  });

  it('accepts numeric and string inputs', () => {
    expect(stroopsToXlm(10_000_000)).toBe('1');
    expect(stroopsToXlm('5000000')).toBe('0.5');
  });
});

describe('decodeSimError', () => {
  it('maps the contract panic for non-positive amounts', () => {
    expect(decodeSimError('Error: amount must be positive')).toMatch(
      /greater than 0/,
    );
  });

  it('maps the contract panic for oversized messages', () => {
    expect(decodeSimError('panic: message too long')).toMatch(
      /140 characters/,
    );
  });

  it('detects insufficient balance regardless of casing', () => {
    expect(decodeSimError('INSUFFICIENT funds for transfer')).toMatch(
      /Insufficient balance/,
    );
  });

  it('falls back to a truncated raw message when nothing matches', () => {
    const long = 'X'.repeat(500);
    const decoded = decodeSimError(long);
    expect(decoded.startsWith('Simulation failed: ')).toBe(true);
    expect(decoded.length).toBeLessThan(280);
  });
});

describe('ContractError', () => {
  it('captures category and message', () => {
    const err = new ContractError('invalid amount', 'validation');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('invalid amount');
    expect(err.category).toBe('validation');
    expect(err.name).toBe('ContractError');
  });

  it('is catchable as Error', () => {
    const fn = () => {
      throw new ContractError('boom', 'rpc');
    };
    expect(fn).toThrow(Error);
  });
});

