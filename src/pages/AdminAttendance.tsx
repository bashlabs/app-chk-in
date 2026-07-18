import { useEffect, useMemo, useState } from 'react';
import { collection, getDocs, orderBy, query, where } from 'firebase/firestore';

import { db } from '../firebase';
import { COLLECTIONS } from '../../shared/collections.js';
import { errorMessage } from '../lib/api';
import { formatPhone } from '../../shared/identity.js';
import {
  labelFor,
  mostRecentSunday,
  rangeFor,
  shift,
  today,
  type PeriodMode,
} from '../lib/period';

type Member = {
  id: string;
  name: string;
  email: string | null;
  phoneE164: string | null;
};

/** What one member did across the selected period. */
type Visits = {
  dates: string[];
  /** Only meaningful in day mode, where there's a single visit. */
  firstTime: Date | null;
};

const MODES: { value: PeriodMode; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
];

export function AdminAttendance() {
  const [mode, setMode] = useState<PeriodMode>('day');
  const [anchor, setAnchor] = useState(mostRecentSunday);
  const [members, setMembers] = useState<Member[]>([]);
  const [records, setRecords] = useState<Map<string, Visits>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'absent' | 'present'>('absent');
  const [search, setSearch] = useState('');

  const range = useMemo(() => rangeFor(mode, anchor), [mode, anchor]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const [memberSnap, attendanceSnap] = await Promise.all([
          getDocs(query(collection(db, COLLECTIONS.members), orderBy('name'))),
          getDocs(
            query(
              collection(db, COLLECTIONS.attendance),
              where('serviceDate', '>=', range.start),
              where('serviceDate', '<=', range.end),
            ),
          ),
        ]);
        if (cancelled) return;

        setMembers(
          memberSnap.docs.map((d) => ({
            id: d.id,
            name: d.get('name') ?? '(no name)',
            email: d.get('email') ?? null,
            phoneE164: d.get('phoneE164') ?? null,
          })),
        );

        const byMember = new Map<string, Visits>();
        for (const d of attendanceSnap.docs) {
          const memberId = d.get('memberId') as string;
          const entry = byMember.get(memberId) ?? { dates: [], firstTime: null };
          entry.dates.push(d.get('serviceDate'));
          entry.firstTime ??= d.get('checkedInAt')?.toDate() ?? null;
          byMember.set(memberId, entry);
        }
        for (const entry of byMember.values()) entry.dates.sort();
        setRecords(byMember);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [range.start, range.end]);

  /** Services actually held = the distinct dates anyone checked in on. */
  const serviceDates = useMemo(() => {
    const all = new Set<string>();
    for (const r of records.values()) for (const d of r.dates) all.add(d);
    return [...all].sort();
  }, [records]);

  const { presentList, absentList } = useMemo(() => {
    const p: Member[] = [];
    const a: Member[] = [];
    for (const m of members) (records.has(m.id) ? p : a).push(m);
    return { presentList: p, absentList: a };
  }, [members, records]);

  const rows = tab === 'present' ? presentList : absentList;
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((m) => [m.name, m.email, m.phoneE164].some((v) => v?.toLowerCase().includes(q)));
  }, [rows, search]);

  const rate = members.length ? Math.round((presentList.length / members.length) * 100) : 0;
  const multi = mode !== 'day';
  // Don't let an admin page forward past today into empty periods.
  const atPresent = rangeFor(mode, anchor).end >= rangeFor(mode, today()).end;

  return (
    <div className="stack">
      <div className="panel-head">
        <h2>Attendance</h2>
        <p className="muted small">
          {multi
            ? 'Across the period, “not in church” means they didn’t come to a single service — the people worth a call.'
            : 'Who came, and — the point of all this — who didn’t.'}
        </p>
      </div>

      <div className="period">
        <div className="segmented" role="group" aria-label="Period">
          {MODES.map((m) => (
            <button
              key={m.value}
              className={mode === m.value ? 'on' : ''}
              aria-pressed={mode === m.value}
              onClick={() => setMode(m.value)}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div className="pager">
          <button
            className="secondary icon"
            onClick={() => setAnchor(shift(mode, anchor, -1))}
            aria-label={`Previous ${mode}`}
          >
            ‹
          </button>
          <span className="period-label">{labelFor(mode, anchor)}</span>
          <button
            className="secondary icon"
            onClick={() => setAnchor(shift(mode, anchor, 1))}
            disabled={atPresent}
            aria-label={`Next ${mode}`}
          >
            ›
          </button>
        </div>

        <input
          type="date"
          aria-label="Jump to date"
          value={anchor}
          max={today()}
          onChange={(e) => e.target.value && setAnchor(e.target.value)}
        />
      </div>

      <div className="stats">
        <Stat label={multi ? 'Came' : 'Present'} value={presentList.length} tone="ok" />
        <Stat label={multi ? 'Never came' : 'Absent'} value={absentList.length} tone="warn" />
        <Stat label="Turnout" value={`${rate}%`} />
        {multi && <Stat label={serviceDates.length === 1 ? 'Service' : 'Services'} value={serviceDates.length} />}
      </div>

      {error && <p className="alert error">{error}</p>}

      <div className="tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'absent'}
          className={tab === 'absent' ? 'on' : ''}
          onClick={() => setTab('absent')}
        >
          Not in church ({absentList.length})
        </button>
        <button
          role="tab"
          aria-selected={tab === 'present'}
          className={tab === 'present' ? 'on' : ''}
          onClick={() => setTab('present')}
        >
          Checked in ({presentList.length})
        </button>
      </div>

      <div className="row tight">
        <input
          type="search"
          placeholder="Search name, email or phone"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button
          className="secondary"
          onClick={() => downloadCsv({ tab, mode, anchor, rows: filtered, records, serviceDates })}
          disabled={!filtered.length}
        >
          Export CSV
        </button>
      </div>

      {loading ? (
        <div className="spinner" />
      ) : !members.length ? (
        <p className="empty">No members yet. Add them under the Members tab.</p>
      ) : !filtered.length ? (
        <p className="empty">{emptyMessage(tab, search, multi, serviceDates.length)}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Contact</th>
              {multi ? <th>Attended</th> : tab === 'present' ? <th>Time</th> : null}
            </tr>
          </thead>
          <tbody>
            {filtered.map((m) => (
              <tr key={m.id}>
                <td>{m.name}</td>
                <td className="muted small">{m.email ?? (m.phoneE164 ? formatPhone(m.phoneE164) : '—')}</td>
                {multi ? (
                  <td>
                    <AttendedCell record={records.get(m.id)} total={serviceDates.length} />
                  </td>
                ) : tab === 'present' ? (
                  <td className="muted small">
                    {records.get(m.id)?.firstTime?.toLocaleTimeString(undefined, {
                      hour: '2-digit',
                      minute: '2-digit',
                    }) ?? '—'}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AttendedCell({ record, total }: { record: Visits | undefined; total: number }) {
  const count = record?.dates.length ?? 0;

  return (
    <div className="attended">
      <span className={`count ${count === 0 ? 'none' : count === total ? 'full' : ''}`}>
        {count} of {total}
      </span>
      {count > 0 && (
        <span className="date-chips">
          {record!.dates.map((d) => (
            <span key={d} className="chip" title={d}>
              {d.slice(8)}/{d.slice(5, 7)}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: 'ok' | 'warn' }) {
  return (
    <div className={`stat ${tone ?? ''}`}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function emptyMessage(tab: 'absent' | 'present', search: string, multi: boolean, services: number) {
  if (search) return 'Nothing matches that search.';
  if (!services) return multi ? 'No services recorded in this period.' : 'Nobody checked in on this date.';
  if (tab === 'absent') return multi ? 'Everyone came at least once. 🎉' : 'Everyone showed up. 🎉';
  return 'Nobody has checked in yet.';
}

// --------------------------------------------------------------------- export

function csvCell(value: string) {
  // Guard against a name like "=cmd|..." being run by a spreadsheet.
  const escaped = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${escaped.replace(/"/g, '""')}"`;
}

function downloadCsv({
  tab,
  mode,
  anchor,
  rows,
  records,
  serviceDates,
}: {
  tab: 'absent' | 'present';
  mode: PeriodMode;
  anchor: string;
  rows: Member[];
  records: Map<string, Visits>;
  serviceDates: string[];
}) {
  const multi = mode !== 'day';

  // In week/month mode, give one column per service date so the office can see
  // the pattern — three missed Sundays in a row reads very differently to three
  // scattered ones.
  const header = [
    'Name',
    'Email',
    'Phone',
    ...(multi ? ['Attended', 'Of', ...serviceDates] : tab === 'present' ? ['Checked in at'] : []),
  ];

  const body = rows.map((m) => {
    const record = records.get(m.id);
    const cells = [m.name, m.email ?? '', m.phoneE164 ?? ''];

    if (multi) {
      cells.push(
        String(record?.dates.length ?? 0),
        String(serviceDates.length),
        ...serviceDates.map((d) => (record?.dates.includes(d) ? 'Y' : 'N')),
      );
    } else if (tab === 'present') {
      cells.push(record?.firstTime?.toLocaleString() ?? '');
    }

    return cells.map(csvCell).join(',');
  });

  const { start, end } = rangeFor(mode, anchor);
  const period = mode === 'day' ? start : `${start}_to_${end}`;

  const blob = new Blob([[header.map(csvCell).join(','), ...body].join('\r\n')], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${tab}-${period}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
