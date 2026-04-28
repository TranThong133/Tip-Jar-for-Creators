import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { StrKey } from '@stellar/stellar-sdk';
import './App.css';
import { CONTRACT_ID, DEFAULT_RECIPIENT, NETWORK_PASSPHRASE } from './config';
import { disconnectWallet, pickWallet } from './wallet';
import {
  ContractError,
  fetchRecentTipEvents,
  fetchXlmBalance,
  getSupporterBalance,
  getTipCount,
  getTotalReceived,
  sendTip,
  stroopsToXlm,
  xlmToStroops,
  type TipRecord,
} from './contract';

type SendStage = 'preparing' | 'signing' | 'submitting' | 'confirming';

type TxStatus =
  | { kind: 'idle' }
  | { kind: 'sending'; stage: SendStage }
  | { kind: 'success'; hash: string }
  | { kind: 'error'; message: string };

const STAGE_LABEL: Record<SendStage, string> = {
  preparing: 'Building & simulating…',
  signing: 'Waiting for wallet signature…',
  submitting: 'Submitting to the network…',
  confirming: 'Waiting for ledger confirmation…',
};

function shortenAddress(addr: string): string {
  if (!addr) return '';
  return `${addr.slice(0, 6)}…${addr.slice(-6)}`;
}

function relativeTime(unixSeconds: bigint): string {
  const diff = Math.floor(Date.now() / 1000) - Number(unixSeconds);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function App() {
  const [address, setAddress] = useState<string | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [funded, setFunded] = useState<boolean>(true);
  const [creatorTotal, setCreatorTotal] = useState<bigint | null>(null);
  const [creatorCount, setCreatorCount] = useState<number | null>(null);
  const [recipient, setRecipient] = useState(DEFAULT_RECIPIENT);
  const [amount, setAmount] = useState('');
  const [message, setMessage] = useState('');
  const [txStatus, setTxStatus] = useState<TxStatus>({ kind: 'idle' });
  const [tips, setTips] = useState<TipRecord[]>([]);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [feedLoading, setFeedLoading] = useState<boolean>(true);
  const [statsLoading, setStatsLoading] = useState<boolean>(false);
  const [supporterBalance, setSupporterBalance] = useState<bigint | null>(null);

  const tipsRef = useRef<TipRecord[]>([]);
  tipsRef.current = tips;

  const refreshBalance = useCallback(async (publicKey: string) => {
    try {
      const { balance, funded } = await fetchXlmBalance(publicKey);
      setBalance(balance);
      setFunded(funded);
    } catch {
      setBalance(null);
      setFunded(true);
    }
  }, []);

  const refreshSupporterBalance = useCallback(async (publicKey: string) => {
    try {
      const value = await getSupporterBalance(publicKey);
      setSupporterBalance(value);
    } catch {
      setSupporterBalance(null);
    }
  }, []);

  const refreshCreatorStats = useCallback(async (creator: string) => {
    if (!StrKey.isValidEd25519PublicKey(creator)) {
      setCreatorTotal(null);
      setCreatorCount(null);
      setStatsLoading(false);
      return;
    }
    setStatsLoading(true);
    try {
      const [total, count] = await Promise.all([
        getTotalReceived(creator),
        getTipCount(creator),
      ]);
      setCreatorTotal(total);
      setCreatorCount(count);
    } catch {
      setCreatorTotal(null);
      setCreatorCount(null);
    } finally {
      setStatsLoading(false);
    }
  }, []);

  const refreshTips = useCallback(async () => {
    try {
      const events = await fetchRecentTipEvents();
      const previousIds = new Set(tipsRef.current.map((t) => t.id));
      const hasNew = events.some((t) => !previousIds.has(t.id));
      setTips(events);
      setFeedError(null);
      return hasNew;
    } catch (err) {
      setFeedError((err as Error)?.message ?? 'Could not load events.');
      return false;
    } finally {
      setFeedLoading(false);
    }
  }, []);

  // Initial event fetch + 5s polling for the live feed.
  useEffect(() => {
    refreshTips();
    const id = setInterval(() => {
      refreshTips();
    }, 5000);
    return () => clearInterval(id);
  }, [refreshTips]);

  // Refresh creator stats when the recipient changes.
  useEffect(() => {
    if (recipient) refreshCreatorStats(recipient);
  }, [recipient, refreshCreatorStats]);

  const onConnect = async () => {
    setTxStatus({ kind: 'idle' });
    try {
      const picked = await pickWallet();
      setAddress(picked);
      refreshBalance(picked);
      refreshSupporterBalance(picked);
    } catch (err) {
      const msg = (err as Error)?.message || 'Wallet connection cancelled.';
      // Cancellation is not a hard error worth shouting about.
      if (!/cancel|close/i.test(msg)) {
        setTxStatus({ kind: 'error', message: msg });
      }
    }
  };

  const onDisconnect = async () => {
    await disconnectWallet();
    setAddress(null);
    setBalance(null);
    setSupporterBalance(null);
    setTxStatus({ kind: 'idle' });
  };

  const onSendTip = async (e: FormEvent) => {
    e.preventDefault();
    if (!address) return;

    if (!StrKey.isValidEd25519PublicKey(recipient)) {
      setTxStatus({ kind: 'error', message: 'Recipient is not a valid Stellar address.' });
      return;
    }
    if (recipient === address) {
      setTxStatus({ kind: 'error', message: 'Cannot tip your own wallet.' });
      return;
    }

    let amountStroops: bigint;
    try {
      amountStroops = xlmToStroops(amount);
    } catch (err) {
      const msg = err instanceof ContractError ? err.message : 'Invalid amount.';
      setTxStatus({ kind: 'error', message: msg });
      return;
    }

    if (balance !== null) {
      const balanceStroops = xlmToStroops(balance);
      // Leave 0.5 XLM headroom for fees + base reserve.
      if (balanceStroops < amountStroops + 5_000_000n) {
        setTxStatus({
          kind: 'error',
          message: 'Insufficient XLM balance (account also needs reserve + fees).',
        });
        return;
      }
    }

    const trimmedMessage = message.trim();
    if (new TextEncoder().encode(trimmedMessage).length > 140) {
      setTxStatus({ kind: 'error', message: 'Message is too long (max 140 bytes).' });
      return;
    }

    setTxStatus({ kind: 'sending', stage: 'preparing' });
    try {
      const hash = await sendTip({
        sender: address,
        creator: recipient,
        amountStroops,
        message: trimmedMessage,
        onStatus: (stage) => setTxStatus({ kind: 'sending', stage }),
      });
      setTxStatus({ kind: 'success', hash });
      setAmount('');
      setMessage('');
      refreshBalance(address);
      refreshSupporterBalance(address);
      refreshCreatorStats(recipient);
      // Pull events a few times — the RPC needs a moment to surface them
      // even though the transaction is already confirmed.
      setTimeout(() => refreshTips(), 2000);
      setTimeout(() => refreshTips(), 6000);
      setTimeout(() => refreshTips(), 12000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Transaction failed.';
      setTxStatus({ kind: 'error', message: msg });
    }
  };

  return (
    <main className="app">
      <header className="app__header">
        <div>
          <h1>Stellar Tip Jar</h1>
          <p className="muted">
            Multi-wallet tipping powered by a Soroban contract on testnet.
          </p>
        </div>
        {address ? (
          <button className="btn btn--ghost" onClick={onDisconnect}>
            Disconnect
          </button>
        ) : (
          <button className="btn" onClick={onConnect}>
            Connect Wallet
          </button>
        )}
      </header>

      {address ? (
        <section className="card">
          <div className="row row--between">
            <h2>Wallet</h2>
            <span className="pill">Testnet</span>
          </div>
          <p className="mono small" title={address}>
            {shortenAddress(address)}
          </p>
          <p className="balance">
            {balance === null ? '—' : `${Number(balance).toFixed(4)} XLM`}
          </p>
          <div className="supporter-row">
            <span className="muted small">Supporter tokens (TJS)</span>
            <strong>
              {supporterBalance === null ? '—' : stroopsToXlm(supporterBalance)}
            </strong>
          </div>
          {!funded && (
            <p className="warn small">
              Account not funded.{' '}
              <a
                href={`https://friendbot.stellar.org/?addr=${address}`}
                target="_blank"
                rel="noreferrer"
              >
                Fund with Friendbot
              </a>
            </p>
          )}
        </section>
      ) : (
        <section className="card">
          <h2>Connect a wallet</h2>
          <p className="muted">
            Pick from Freighter, xBull, Albedo, LOBSTR, Hana, or any other Stellar wallet
            supported by{' '}
            <a
              href="https://github.com/Creit-Tech/Stellar-Wallets-Kit"
              target="_blank"
              rel="noreferrer"
            >
              StellarWalletsKit
            </a>
            . Make sure your wallet is set to Testnet.
          </p>
        </section>
      )}

      {address && (
        <form className="card" onSubmit={onSendTip} noValidate>
          <h2>Send a tip</h2>
          <label>
            Creator address
            <input
              type="text"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="G..."
              autoComplete="off"
              spellCheck={false}
              required
            />
          </label>

          {recipient && StrKey.isValidEd25519PublicKey(recipient) && (
            <div className="creator-stats">
              <div>
                <span className="muted small">Total received</span>
                {statsLoading && creatorTotal === null ? (
                  <span className="skeleton skeleton--text" />
                ) : (
                  <strong>
                    {creatorTotal === null ? '—' : `${stroopsToXlm(creatorTotal)} XLM`}
                  </strong>
                )}
              </div>
              <div>
                <span className="muted small">Tip count</span>
                {statsLoading && creatorCount === null ? (
                  <span className="skeleton skeleton--text" />
                ) : (
                  <strong>{creatorCount === null ? '—' : creatorCount}</strong>
                )}
              </div>
            </div>
          )}

          <label>
            Amount (XLM)
            <input
              type="number"
              min="0"
              step="0.0000001"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="1.0"
              required
            />
          </label>
          <label>
            Message (optional, max 140 chars)
            <input
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={140}
              placeholder="Thanks for the great content!"
              autoComplete="off"
            />
          </label>
          <button className="btn" type="submit" disabled={txStatus.kind === 'sending'}>
            {txStatus.kind === 'sending' ? STAGE_LABEL[txStatus.stage] : 'Send tip'}
          </button>

          {txStatus.kind === 'sending' && (
            <div className="status status--pending">
              <p className="status__title">Transaction in flight</p>
              <p className="small">{STAGE_LABEL[txStatus.stage]}</p>
            </div>
          )}
          {txStatus.kind === 'success' && (
            <div className="status status--success">
              <p className="status__title">Tip recorded on-chain.</p>
              <a
                href={`https://stellar.expert/explorer/testnet/tx/${txStatus.hash}`}
                target="_blank"
                rel="noreferrer"
              >
                View on Stellar Expert →
              </a>
              <p className="mono small status__hash">{txStatus.hash}</p>
            </div>
          )}
          {txStatus.kind === 'error' && (
            <div className="status status--error">
              <p className="status__title">Transaction failed</p>
              <p className="small">{txStatus.message}</p>
            </div>
          )}
        </form>
      )}

      <section className="card">
        <div className="row row--between">
          <h2>Live tip feed</h2>
          <div className="row" style={{ gap: 12 }}>
            <span className="muted small">refreshes every 5s</span>
            <button
              type="button"
              className="btn btn--ghost"
              style={{ padding: '4px 10px', fontSize: 12 }}
              onClick={() => refreshTips()}
            >
              Refresh now
            </button>
          </div>
        </div>
        {feedError && (
          <div className="status status--error">
            <p className="status__title">Could not load events</p>
            <p className="small">{feedError}</p>
          </div>
        )}
        {feedLoading && tips.length === 0 && !feedError && (
          <ul className="feed">
            {[0, 1, 2].map((i) => (
              <li key={i} className="feed__item feed__item--skeleton">
                <div className="feed__row">
                  <span className="skeleton skeleton--amount" />
                  <span className="skeleton skeleton--time" />
                </div>
                <span className="skeleton skeleton--line" />
              </li>
            ))}
          </ul>
        )}
        {!feedLoading && tips.length === 0 && !feedError && (
          <p className="muted small">
            No tips yet. Send one above and it will appear here within ~5–10 seconds.
          </p>
        )}
        {tips.length > 0 && (
          <ul className="feed">
            {tips.slice(0, 20).map((tip) => (
              <li key={tip.id} className="feed__item">
                <div className="feed__row">
                  <span className="feed__amount">
                    +{stroopsToXlm(tip.amount)} XLM
                  </span>
                  <span className="feed__time muted small">
                    {relativeTime(tip.timestamp)}
                  </span>
                </div>
                <p className="mono small">
                  {shortenAddress(tip.sender)} → {shortenAddress(tip.creator)}
                </p>
                {tip.message && <p className="feed__message">“{tip.message}”</p>}
                {tip.txHash && (
                  <a
                    className="small"
                    href={`https://stellar.expert/explorer/testnet/tx/${tip.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    tx ↗
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="muted small center">
        Contract:{' '}
        <a
          href={`https://stellar.expert/explorer/testnet/contract/${CONTRACT_ID}`}
          target="_blank"
          rel="noreferrer"
          className="mono"
        >
          {shortenAddress(CONTRACT_ID)}
        </a>{' '}
        · Network passphrase: {NETWORK_PASSPHRASE}
      </footer>
    </main>
  );
}

export default App;
