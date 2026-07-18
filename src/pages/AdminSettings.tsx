import { useEffect, useState } from 'react';
import { doc, getDoc, setDoc, Timestamp } from 'firebase/firestore';

import { db } from '../firebase';
import { COLLECTIONS } from '../../shared/collections.js';
import { getAccessStatus, errorMessage, type AccessStatus } from '../lib/api';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

type Mode = 'schedule' | 'open' | 'closed';

type Form = {
  mode: Mode;
  allowedDays: number[];
  start: string;
  end: string;
  timezone: string;
  overrideUntil: string;
  closedMessage: string;
  successMessage: string;
  unknownMessage: string;
};

const DEFAULTS: Form = {
  mode: 'schedule',
  allowedDays: [0],
  start: '',
  end: '',
  timezone: 'Africa/Lagos',
  overrideUntil: '',
  closedMessage: 'Check-in is closed right now. It opens for Sunday service — please come back then.',
  successMessage:
    'Thanks for coming to church today, this will help us to identify those that are not in church today',
  unknownMessage:
    "We couldn't find your record. Please stop by the welcome desk so we can get you registered.",
};

export function AdminSettings() {
  const [form, setForm] = useState<Form>(DEFAULTS);
  const [status, setStatus] = useState<AccessStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const snap = await getDoc(doc(db, COLLECTIONS.config, 'access'));
        if (snap.exists()) setForm(fromDoc(snap.data()));
        await refreshStatus();
      } catch (err) {
        setBanner({ kind: 'error', text: errorMessage(err) });
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function refreshStatus() {
    try {
      setStatus(await getAccessStatus());
    } catch {
      setStatus(null);
    }
  }

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setBanner(null);
    try {
      await setDoc(doc(db, COLLECTIONS.config, 'access'), toDoc(form), { merge: true });
      await refreshStatus();
      setBanner({ kind: 'ok', text: 'Saved.' });
    } catch (err) {
      setBanner({ kind: 'error', text: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setBanner(null);
  }

  if (loading) return <div className="spinner" />;

  return (
    <form className="stack" onSubmit={onSave}>
      <div className="panel-head">
        <h2>Access control</h2>
        <p className="muted small">
          Decides when the public check-in page accepts entries. Enforced on the server, so changing
          a phone’s clock won’t get around it.
        </p>
      </div>

      {status && (
        <div className={`status-strip ${status.open ? 'open' : 'closed'}`}>
          <strong>{status.open ? 'Check-in is OPEN' : 'Check-in is CLOSED'}</strong>
          <span className="muted small">
            {status.open
              ? `Recording attendance for ${status.serviceDate}`
              : status.nextOpenDate
                ? `Next opens ${status.nextOpenDay}, ${status.nextOpenDate}`
                : 'No upcoming open day'}
          </span>
        </div>
      )}

      <fieldset>
        <legend>Mode</legend>
        {(
          [
            ['schedule', 'Follow the schedule', 'Open only on the days and times set below.'],
            ['open', 'Force open', 'Accept check-ins now, regardless of the schedule.'],
            ['closed', 'Force closed', 'Reject everyone — use this to stop abuse immediately.'],
          ] as const
        ).map(([value, label, help]) => (
          <label key={value} className="choice">
            <input
              type="radio"
              name="mode"
              value={value}
              checked={form.mode === value}
              onChange={() => set('mode', value)}
            />
            <span>
              <strong>{label}</strong>
              <span className="muted small">{help}</span>
            </span>
          </label>
        ))}

        {form.mode === 'open' && (
          <div className="indent">
            <label htmlFor="overrideUntil">Force open until (optional)</label>
            <input
              id="overrideUntil"
              type="datetime-local"
              value={form.overrideUntil}
              onChange={(e) => set('overrideUntil', e.target.value)}
            />
            <p className="hint">
              Leave blank to stay open indefinitely. After this time it reverts to the schedule —
              handy so you don’t forget to close it again.
            </p>
          </div>
        )}
      </fieldset>

      <fieldset disabled={form.mode !== 'schedule'}>
        <legend>Schedule</legend>

        <label>Open on</label>
        <div className="days">
          {DAYS.map((day, i) => (
            <label key={day} className={`day ${form.allowedDays.includes(i) ? 'on' : ''}`}>
              <input
                type="checkbox"
                checked={form.allowedDays.includes(i)}
                onChange={(e) =>
                  set(
                    'allowedDays',
                    e.target.checked
                      ? [...form.allowedDays, i].sort()
                      : form.allowedDays.filter((d) => d !== i),
                  )
                }
              />
              {day.slice(0, 3)}
            </label>
          ))}
        </div>
        {form.allowedDays.length === 0 && (
          <p className="alert warn">No days selected — check-in will never open.</p>
        )}

        <div className="row">
          <div>
            <label htmlFor="start">Opens at</label>
            <input
              id="start"
              type="time"
              value={form.start}
              onChange={(e) => set('start', e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="end">Closes at</label>
            <input id="end" type="time" value={form.end} onChange={(e) => set('end', e.target.value)} />
          </div>
        </div>
        <p className="hint">
          Leave both blank for all day. A tight window around service time is the simplest way to
          stop people checking in from home.
        </p>

        <label htmlFor="timezone">Timezone</label>
        <input
          id="timezone"
          value={form.timezone}
          onChange={(e) => set('timezone', e.target.value)}
          placeholder="Africa/Lagos"
        />
      </fieldset>

      <fieldset>
        <legend>Messages</legend>

        <label htmlFor="successMessage">After a successful check-in</label>
        <textarea
          id="successMessage"
          rows={3}
          value={form.successMessage}
          onChange={(e) => set('successMessage', e.target.value)}
        />

        <label htmlFor="unknownMessage">When the person isn’t in the database</label>
        <textarea
          id="unknownMessage"
          rows={2}
          value={form.unknownMessage}
          onChange={(e) => set('unknownMessage', e.target.value)}
        />

        <label htmlFor="closedMessage">When check-in is closed</label>
        <textarea
          id="closedMessage"
          rows={2}
          value={form.closedMessage}
          onChange={(e) => set('closedMessage', e.target.value)}
        />
      </fieldset>

      {banner && <p className={`alert ${banner.kind === 'ok' ? 'ok' : 'error'}`}>{banner.text}</p>}

      <button type="submit" className="primary" disabled={saving}>
        {saving ? 'Saving…' : 'Save changes'}
      </button>
    </form>
  );
}

// --------------------------------------------------------------- conversions

const toTime = (m: unknown) =>
  typeof m === 'number'
    ? `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
    : '';

function fromTime(value: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Firestore Timestamp -> the `YYYY-MM-DDTHH:mm` that datetime-local wants. */
function toLocalInput(ts: unknown): string {
  if (!ts || typeof (ts as Timestamp)?.toDate !== 'function') return '';
  const d = (ts as Timestamp).toDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromDoc(data: Record<string, unknown>): Form {
  return {
    mode: (['schedule', 'open', 'closed'] as const).includes(data.mode as Mode)
      ? (data.mode as Mode)
      : DEFAULTS.mode,
    allowedDays: Array.isArray(data.allowedDays) ? (data.allowedDays as number[]) : DEFAULTS.allowedDays,
    start: toTime(data.startMinutes),
    end: toTime(data.endMinutes),
    timezone: (data.timezone as string) || DEFAULTS.timezone,
    overrideUntil: toLocalInput(data.overrideUntil),
    closedMessage: (data.closedMessage as string) ?? DEFAULTS.closedMessage,
    successMessage: (data.successMessage as string) ?? DEFAULTS.successMessage,
    unknownMessage: (data.unknownMessage as string) ?? DEFAULTS.unknownMessage,
  };
}

function toDoc(form: Form) {
  return {
    mode: form.mode,
    allowedDays: form.allowedDays,
    startMinutes: fromTime(form.start),
    endMinutes: fromTime(form.end),
    timezone: form.timezone.trim() || DEFAULTS.timezone,
    overrideUntil:
      form.mode === 'open' && form.overrideUntil
        ? Timestamp.fromDate(new Date(form.overrideUntil))
        : null,
    closedMessage: form.closedMessage.trim(),
    successMessage: form.successMessage.trim(),
    unknownMessage: form.unknownMessage.trim(),
  };
}
