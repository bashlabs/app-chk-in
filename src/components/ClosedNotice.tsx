import type { AccessStatus } from '../lib/api';

export function ClosedNotice({ status, onRetry }: { status: AccessStatus; onRetry: () => void }) {
  return (
    <div className="state" aria-live="polite">
      <div className="badge lock" aria-hidden="true">
        🔒
      </div>
      <h2>Check-in is closed</h2>
      <p className="message">{status.message}</p>

      {status.nextOpenDate && (
        <p className="muted">
          Opens again on <strong>{formatNextOpen(status.nextOpenDate)}</strong>.
        </p>
      )}

      {!status.nextOpenDate && status.reason === 'disabled' && (
        <p className="muted small">An administrator has paused check-in.</p>
      )}

      <button className="secondary" onClick={onRetry}>
        Refresh
      </button>
    </div>
  );
}

function formatNextOpen(date: string) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
}
