import { useEffect, useMemo, useState } from 'react';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore';

import { db } from '../firebase';
import { COLLECTIONS } from '../../shared/collections.js';
import { errorMessage } from '../lib/api';
import { formatPhone, normalizeEmail, normalizePhone } from '../../shared/identity.js';

type Member = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  phoneE164: string | null;
};

const PAGE_SIZE = 25;

export function AdminMembers() {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [banner, setBanner] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [saving, setSaving] = useState(false);

  const [csv, setCsv] = useState('');
  const [importing, setImporting] = useState(false);

  const [page, setPage] = useState(1);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const snap = await getDocs(query(collection(db, COLLECTIONS.members), orderBy('name')));
      setMembers(
        snap.docs.map((d) => ({
          id: d.id,
          name: d.get('name') ?? '(no name)',
          email: d.get('email') ?? null,
          phone: d.get('phone') ?? null,
          phoneE164: d.get('phoneE164') ?? null,
        })),
      );
    } catch (err) {
      setBanner({ kind: 'error', text: errorMessage(err) });
    } finally {
      setLoading(false);
    }
  }

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    setBanner(null);

    const record = buildMember(name, email, phone);
    if ('error' in record) {
      setBanner({ kind: 'error', text: record.error });
      return;
    }

    setSaving(true);
    try {
      await addDoc(collection(db, COLLECTIONS.members), { ...record.value, createdAt: serverTimestamp() });
      setName('');
      setEmail('');
      setPhone('');
      setBanner({ kind: 'ok', text: `Added ${record.value.name}.` });
      await load();
    } catch (err) {
      setBanner({ kind: 'error', text: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  async function onImport() {
    setBanner(null);
    setImporting(true);
    try {
      const { records, errors } = parseCsv(csv);
      if (!records.length) {
        setBanner({ kind: 'error', text: errors[0] ?? 'Nothing to import.' });
        return;
      }

      // Firestore caps a batch at 500 writes.
      for (let i = 0; i < records.length; i += 400) {
        const batch = writeBatch(db);
        for (const record of records.slice(i, i + 400)) {
          batch.set(doc(collection(db, COLLECTIONS.members)), { ...record, createdAt: serverTimestamp() });
        }
        await batch.commit();
      }

      setCsv('');
      setBanner({
        kind: 'ok',
        text: `Imported ${records.length} member${records.length === 1 ? '' : 's'}.${
          errors.length ? ` Skipped ${errors.length}: ${errors.slice(0, 3).join('; ')}` : ''
        }`,
      });
      await load();
    } catch (err) {
      setBanner({ kind: 'error', text: errorMessage(err) });
    } finally {
      setImporting(false);
    }
  }

  async function onDelete(m: Member) {
    if (!confirm(`Remove ${m.name}? Their past attendance records stay.`)) return;
    try {
      await deleteDoc(doc(db, COLLECTIONS.members, m.id));
      await load();
    } catch (err) {
      setBanner({ kind: 'error', text: errorMessage(err) });
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return members;
    return members.filter((m) => [m.name, m.email, m.phoneE164].some((v) => v?.toLowerCase().includes(q)));
  }, [members, search]);

  // A new search changes what "page 1" means, so jump back to the top.
  useEffect(() => setPage(1), [search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  // Derived, not stored: after a delete shrinks the list the old page number
  // may overshoot, so clamp on every render rather than tracking it separately.
  const currentPage = Math.min(page, totalPages);
  const paged = useMemo(
    () => filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filtered, currentPage],
  );
  const firstShown = filtered.length ? (currentPage - 1) * PAGE_SIZE + 1 : 0;
  const lastShown = Math.min(currentPage * PAGE_SIZE, filtered.length);

  return (
    <div className="stack">
      <div className="panel-head">
        <h2>Members</h2>
        <p className="muted small">
          Only people listed here can check in. Phone numbers are stored as +234… so any format they
          type still matches.
        </p>
      </div>

      {banner && <p className={`alert ${banner.kind === 'ok' ? 'ok' : 'error'}`}>{banner.text}</p>}

      <form className="add-member" onSubmit={onAdd}>
        <div className="row">
          <div>
            <label htmlFor="m-name">Name</label>
            <input id="m-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div>
            <label htmlFor="m-email">Email</label>
            <input id="m-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <label htmlFor="m-phone">Phone</label>
            <input
              id="m-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="08031234567"
            />
          </div>
        </div>
        <button type="submit" className="primary" disabled={saving || !name.trim()}>
          {saving ? 'Adding…' : 'Add member'}
        </button>
      </form>

      <details className="import">
        <summary>Bulk import from CSV</summary>
        <p className="hint">
          One person per line: <code>name, email, phone</code>. A header row is ignored. Email or
          phone — at least one is required.
        </p>
        <textarea
          rows={5}
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          placeholder={'Ada Obi, ada@example.com, 08031234567\nTunde Bello,, +234 703 123 4567'}
        />
        <div className="row tight">
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) setCsv(await file.text());
            }}
          />
          <button className="secondary" onClick={onImport} disabled={importing || !csv.trim()}>
            {importing ? 'Importing…' : 'Import'}
          </button>
        </div>
      </details>

      <input
        type="search"
        placeholder={`Search ${members.length} member${members.length === 1 ? '' : 's'}`}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {loading ? (
        <div className="spinner" />
      ) : !filtered.length ? (
        <p className="empty">{search ? 'Nothing matches that search.' : 'No members yet.'}</p>
      ) : (
        <>
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Phone</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {paged.map((m) => (
                <tr key={m.id}>
                  <td>{m.name}</td>
                  <td className="muted small">{m.email ?? '—'}</td>
                  <td className="muted small">{m.phoneE164 ? formatPhone(m.phoneE164) : '—'}</td>
                  <td>
                    <button className="link danger" onClick={() => onDelete(m)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="row tight pagination">
            <span className="muted small">
              Showing {firstShown}–{lastShown} of {filtered.length}
            </span>
            {totalPages > 1 && (
              <div className="pager">
                <button
                  className="secondary icon"
                  onClick={() => setPage(currentPage - 1)}
                  disabled={currentPage <= 1}
                  aria-label="Previous page"
                >
                  ‹
                </button>
                <span className="period-label">
                  Page {currentPage} of {totalPages}
                </span>
                <button
                  className="secondary icon"
                  onClick={() => setPage(currentPage + 1)}
                  disabled={currentPage >= totalPages}
                  aria-label="Next page"
                >
                  ›
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- parsing

type NewMember = {
  name: string;
  email: string | null;
  emailLower: string | null;
  phone: string | null;
  phoneE164: string | null;
};

/**
 * Builds the stored shape. `emailLower`/`phoneE164` are what check-in queries
 * against; `email`/`phone` keep whatever the office typed, for display.
 */
function buildMember(
  name: string,
  email: string,
  phone: string,
): { value: NewMember } | { error: string } {
  const trimmedName = name.trim();
  if (!trimmedName) return { error: 'Name is required.' };
  if (!email.trim() && !phone.trim()) return { error: 'Give an email address or a phone number.' };

  const emailLower = email.trim() ? normalizeEmail(email) : null;
  if (email.trim() && !emailLower) return { error: `"${email}" isn’t a valid email address.` };

  const phoneE164 = phone.trim() ? normalizePhone(phone) : null;
  if (phone.trim() && !phoneE164) {
    return { error: `"${phone}" isn’t a valid Nigerian phone number.` };
  }

  return {
    value: {
      name: trimmedName,
      email: emailLower,
      emailLower,
      phone: phone.trim() || null,
      phoneE164,
    },
  };
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseCsv(text: string): { records: NewMember[]; errors: string[] } {
  const records: NewMember[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  const lines = text.split(/\r?\n/).filter((l) => l.trim());

  lines.forEach((line, index) => {
    const [name = '', email = '', phone = ''] = splitCsvLine(line);

    // Skip a header row.
    if (index === 0 && /^name$/i.test(name)) return;

    const built = buildMember(name, email, phone);
    if ('error' in built) {
      errors.push(`line ${index + 1}: ${built.error}`);
      return;
    }

    // Don't import the same person twice within one paste.
    const key = built.value.emailLower ?? built.value.phoneE164 ?? '';
    if (seen.has(key)) {
      errors.push(`line ${index + 1}: duplicate of an earlier row`);
      return;
    }
    seen.add(key);
    records.push(built.value);
  });

  return { records, errors };
}
