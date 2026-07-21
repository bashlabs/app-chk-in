import { useCallback, useEffect, useRef, useState } from 'react';

import { normalizeIdentifier } from '../../shared/identity.js';
import {
  accessDetailsFrom,
  checkIn,
  errorMessage,
  getAccessStatus,
  type AccessStatus,
  type CheckInResult,
} from '../lib/api';
import { recaptchaToken } from '../lib/recaptcha';
import { ClosedNotice } from '../components/ClosedNotice';

type View =
  | { kind: 'loading' }
  | { kind: 'form' }
  | { kind: 'result'; result: CheckInResult }
  | { kind: 'closed'; status: AccessStatus };

export function CheckIn() {
  const [status, setStatus] = useState<AccessStatus | null>(null);
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [identifier, setIdentifier] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadStatus = useCallback(async () => {
    try {
      const data = await getAccessStatus();
      setStatus(data);
      setView(data.open ? { kind: 'form' } : { kind: 'closed', status: data });
    } catch (err) {
      setError(errorMessage(err));
      // Let them try anyway — the server is the one that decides.
      setView({ kind: 'form' });
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (view.kind === 'form') inputRef.current?.focus();
  }, [view.kind]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!normalizeIdentifier(identifier)) {
      setError('Enter your email address or phone number, e.g. 08031234567 or you@example.com');
      inputRef.current?.focus();
      return;
    }

    setBusy(true);
    try {
      const data = await checkIn(identifier, await recaptchaToken());
      setView({ kind: 'result', result: data });
      setIdentifier('');
    } catch (err) {
      // The window can close between page load and submit.
      const closed = accessDetailsFrom(err);
      if (closed) {
        setStatus(closed);
        setView({ kind: 'closed', status: closed });
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setError(null);
    setIdentifier('');
    setView({ kind: 'form' });
  }

  return (
    <main className="page">
      <div className="card">
        <header className="card-head">
          <img
            className="brand-logo"
            src="/logo-crest.png"
            alt="The Covenant Nation, Abule Egba"
            width={76}
            height={76}
          />
          <p className="church-name">The Covenant Nation · Abule Egba</p>
          <h1>Service Check-In</h1>
          {status?.open && <p className="sub">{formatServiceDate(status.serviceDate)}</p>}
        </header>

        {view.kind === 'loading' && (
          <div className="state" aria-live="polite">
            <div className="spinner" />
            <p className="muted">Checking if check-in is open…</p>
          </div>
        )}

        {view.kind === 'closed' && <ClosedNotice status={view.status} onRetry={loadStatus} />}

        {view.kind === 'form' && (
          <form onSubmit={onSubmit} noValidate>
            <label htmlFor="identifier">Email address or phone number</label>
            <input
              ref={inputRef}
              id="identifier"
              className={error ? 'invalid' : undefined}
              value={identifier}
              onChange={(e) => {
                setIdentifier(e.target.value);
                if (error) setError(null);
              }}
              placeholder="08031234567 or you@example.com"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="done"
              aria-describedby="hint"
              aria-invalid={Boolean(error)}
              disabled={busy}
            />
            <p id="hint" className="hint">
              Any format works — 08031234567, +234 803 123 4567 or 234 803 123 4567.
            </p>

            {error && (
              <p className="alert error" role="alert">
                {error}
              </p>
            )}

            <button type="submit" className="primary" disabled={busy || !identifier.trim()}>
              {busy ? 'Checking…' : 'Check in'}
            </button>
          </form>
        )}

        {view.kind === 'result' && <Result result={view.result} onDone={reset} />}
      </div>
    </main>
  );
}

function Result({ result, onDone }: { result: CheckInResult; onDone: () => void }) {
  if (!result.found) {
    return (
      <div className="state" aria-live="polite">
        <div className="badge warn" aria-hidden="true">
          ?
        </div>
        <h2>We don't have your record yet</h2>
        <p className="muted">{result.message}</p>
        <button className="secondary" onClick={onDone}>
          Try another number
        </button>
      </div>
    );
  }

  return (
    <div className="state" aria-live="polite">
      <div className="badge ok" aria-hidden="true">
        ✓
      </div>
      <h2>{result.name ? `Welcome, ${result.name.split(' ')[0]}!` : 'You’re checked in!'}</h2>
      <p className="message">{result.message}</p>
      {result.alreadyCheckedIn && (
        <p className="muted small">You were already checked in for today — we only count you once.</p>
      )}
      <button className="secondary" onClick={onDone}>
        Check in someone else
      </button>
    </div>
  );
}

function formatServiceDate(date: string) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
