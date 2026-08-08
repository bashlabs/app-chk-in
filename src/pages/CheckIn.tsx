import { useCallback, useEffect, useRef, useState } from 'react';

import { formatPhone, normalizeIdentifier } from '../../shared/identity.js';
import {
  accessDetailsFrom,
  checkIn,
  errorMessage,
  getAccessStatus,
  register,
  reportWrongName,
  type AccessStatus,
  type CheckInResult,
} from '../lib/api';
import { recaptchaToken } from '../lib/recaptcha';
import { ClosedNotice } from '../components/ClosedNotice';

type View =
  | { kind: 'loading' }
  | { kind: 'form' }
  /** `identifier` is kept so the result screen can register or correct without re-typing. */
  | { kind: 'result'; result: CheckInResult; identifier: string }
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
      setView({ kind: 'result', result: data, identifier });
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

        {view.kind === 'result' && (
          <Result
            result={view.result}
            identifier={view.identifier}
            onDone={reset}
            onResult={(result) => setView({ kind: 'result', result, identifier: view.identifier })}
          />
        )}
      </div>
    </main>
  );
}

function Result({
  result,
  identifier,
  onDone,
  onResult,
}: {
  result: CheckInResult;
  identifier: string;
  onDone: () => void;
  onResult: (result: CheckInResult) => void;
}) {
  if (!result.found) {
    return <Register identifier={identifier} message={result.message} onDone={onDone} onResult={onResult} />;
  }

  return (
    <div className="state" aria-live="polite">
      <div className="badge ok" aria-hidden="true">
        ✓
      </div>
      <h2>{result.name ? `Welcome, ${result.name.split(' ')[0]}!` : 'You’re checked in!'}</h2>
      <p className="message">{result.message}</p>
      {result.created && (
        <p className="muted small">We’ve added you to the register — welcome to the family.</p>
      )}
      {result.alreadyCheckedIn && (
        <p className="muted small">You were already checked in for today — we only count you once.</p>
      )}
      <button className="secondary" onClick={onDone}>
        Check in someone else
      </button>
      {/* The 21 July import mispaired a run of names against phone numbers, so
          the person holding the phone is the only one who can tell us it's
          wrong — and they're right here, at the moment it happens. Pointless
          when they just typed the name themselves. */}
      {result.name && !result.created && <WrongName identifier={identifier} shownName={result.name} />}
    </div>
  );
}

/** Unknown number: take a name and check them in, rather than a dead end. */
function Register({
  identifier,
  message,
  onDone,
  onResult,
}: {
  identifier: string;
  message: string;
  onDone: () => void;
  onResult: (result: CheckInResult) => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => nameRef.current?.focus(), []);

  // Show the number we actually looked for.
  //
  // Elijah was told "we don't have your record" for a number that was on file,
  // which means what he typed wasn't the number he meant — and nothing on the
  // screen let him see that. A miss has two causes that look identical to the
  // person holding the phone: they aren't registered, or they mistyped. Echoing
  // the number back separates them at the door, in the second it takes to read.
  //
  // This leaks nothing: it's their own input, normalised, not anything on file.
  const identity = normalizeIdentifier(identifier);
  const attempted = identity?.type === 'phone' ? formatPhone(identity.value) : identity?.value;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      onResult(await register(identifier, name, await recaptchaToken()));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="state" aria-live="polite">
      <div className="badge warn" aria-hidden="true">
        ?
      </div>
      <h2>We don't have your record yet</h2>
      {attempted && (
        <p className="muted">
          We looked for <strong className="attempted">{attempted}</strong>. If that isn’t right, go
          back and check it.
        </p>
      )}
      <p className="muted">{message}</p>

      <form onSubmit={onSubmit} noValidate className="register">
        <label htmlFor="new-name">Your full name</label>
        <input
          ref={nameRef}
          id="new-name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (error) setError(null);
          }}
          placeholder="Ada Obi"
          autoComplete="name"
          autoCapitalize="words"
          enterKeyHint="done"
          aria-invalid={Boolean(error)}
          disabled={busy}
        />
        <p className="hint">We’ll add you to the register and check you in for today.</p>

        {error && (
          <p className="alert error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="primary" disabled={busy || name.trim().length < 2}>
          {busy ? 'Adding…' : 'Add me and check in'}
        </button>
      </form>

      <button className="link" onClick={onDone} disabled={busy}>
        Try another number
      </button>
    </div>
  );
}

/**
 * "This isn't me."
 *
 * Records the correction for an admin rather than applying it. A wrong name is
 * a two-sided claim — the other person may be the real owner of the number —
 * so letting this screen rewrite the directory would turn one bad row into two.
 */
function WrongName({ identifier, shownName }: { identifier: string; shownName: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (done) return <p className="muted small">{done}</p>;

  if (!open) {
    return (
      <button className="link" onClick={() => setOpen(true)}>
        This isn’t me
      </button>
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await reportWrongName(identifier, name, await recaptchaToken());
      setDone(res.message);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="register">
      <label htmlFor="real-name">You’re checked in, but what’s your name?</label>
      <input
        id="real-name"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          if (error) setError(null);
        }}
        placeholder="Your full name"
        autoComplete="name"
        autoCapitalize="words"
        enterKeyHint="done"
        disabled={busy}
      />
      <p className="hint">
        We have this number under “{shownName}”. Tell us the right name and the office will fix it.
      </p>

      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}

      <button type="submit" className="secondary" disabled={busy || name.trim().length < 2}>
        {busy ? 'Sending…' : 'Send correction'}
      </button>
    </form>
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
