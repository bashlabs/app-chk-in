import { useEffect, useMemo, useState } from 'react';
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
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
  /** 'self' when they registered themselves at the door. */
  source: string | null;
  createdAt: Date | null;
};

/** A "that isn't my name" report from the check-in screen. */
type Dispute = {
  id: string;
  shownName: string | null;
  shownMemberId: string | null;
  claimedName: string;
  phoneE164: string | null;
  serviceDate: string;
};

const PAGE_SIZE = 25;

export function AdminMembers() {
  const [members, setMembers] = useState<Member[]>([]);
  const [disputes, setDisputes] = useState<Dispute[]>([]);
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
  const [editing, setEditing] = useState<Member | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      // The disputes collection is newer than the deployed rules may be. A
      // permission error there must not take the members list down with it —
      // this page is how the office works on a Sunday.
      const [snap, disputeSnap] = await Promise.all([
        getDocs(query(collection(db, COLLECTIONS.members), orderBy('name'))),
        getDocs(query(collection(db, COLLECTIONS.disputes), where('resolved', '==', false))).catch(
          () => null,
        ),
      ]);
      setMembers(
        snap.docs.map((d) => ({
          id: d.id,
          name: d.get('name') ?? '(no name)',
          email: d.get('email') ?? null,
          phone: d.get('phone') ?? null,
          phoneE164: d.get('phoneE164') ?? null,
          source: d.get('source') ?? null,
          createdAt: d.get('createdAt')?.toDate?.() ?? null,
        })),
      );
      setDisputes(
        (disputeSnap?.docs ?? []).map((d) => ({
          id: d.id,
          shownName: d.get('shownName') ?? null,
          shownMemberId: d.get('shownMemberId') ?? null,
          claimedName: d.get('claimedName') ?? '',
          phoneE164: d.get('phoneE164') ?? null,
          serviceDate: d.get('serviceDate') ?? '',
        })),
      );
    } catch (err) {
      setBanner({ kind: 'error', text: errorMessage(err) });
    } finally {
      setLoading(false);
    }
  }

  /** Accept a member's own correction: rename them and close the report. */
  async function applyDispute(d: Dispute) {
    if (!d.shownMemberId) return;
    if (!confirm(`Rename "${d.shownName}" to "${d.claimedName}"? Their check-ins stay.`)) return;
    try {
      await updateDoc(doc(db, COLLECTIONS.members, d.shownMemberId), { name: d.claimedName });
      await updateDoc(doc(db, COLLECTIONS.disputes, d.id), { resolved: true });
      setBanner({ kind: 'ok', text: `Renamed to ${d.claimedName}.` });
      await load();
    } catch (err) {
      setBanner({ kind: 'error', text: errorMessage(err) });
    }
  }

  async function dismissDispute(d: Dispute) {
    try {
      await updateDoc(doc(db, COLLECTIONS.disputes, d.id), { resolved: true });
      await load();
    } catch (err) {
      setBanner({ kind: 'error', text: errorMessage(err) });
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
      // Two guards, because they catch different things. The query finds anyone
      // already on file under a legacy random id; the transaction on a
      // deterministic id is what stops two admins adding the same person at the
      // same moment, which no amount of reading-first can.
      const clash = await findByContact(record.value);
      if (clash) {
        setBanner({ kind: 'error', text: clashMessage(record.value, clash.name) });
        return;
      }

      await runTransaction(db, async (tx) => {
        const ref = doc(db, COLLECTIONS.members, memberId(record.value));
        const existing = await tx.get(ref);
        if (existing.exists()) throw new Error(clashMessage(record.value, existing.get('name')));
        tx.set(ref, { ...record.value, createdAt: serverTimestamp() });
      });

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

  /**
   * Save an edited member — name and email only.
   *
   * The phone number is deliberately not editable here. The document id is
   * derived from it and every attendance id embeds the member id
   * (`${serviceDate}_${memberId}`), so changing a number is a migration of the
   * person and their whole history, not a field edit. Someone who genuinely
   * changed number gets removed and added again, which keeps that decision
   * visible instead of hiding it behind a text box.
   *
   * This is the repair tool for the 21 July import, and what that needs is
   * exactly a name change against a number that is already correct.
   */
  async function onSaveEdit(member: Member, name: string, emailLower: string | null): Promise<void> {
    if (emailLower && emailLower !== member.email) {
      const snap = await getDocs(
        query(collection(db, COLLECTIONS.members), where('emailLower', '==', emailLower), limit(2)),
      );
      const clash = snap.docs.find((d) => d.id !== member.id);
      if (clash) {
        throw new Error(
          `${emailLower} is already on file as "${clash.get('name') ?? '(no name)'}". ` +
            'One contact can only belong to one person.',
        );
      }
    }

    await updateDoc(doc(db, COLLECTIONS.members, member.id), {
      name,
      email: emailLower,
      emailLower,
    });
    setBanner({ kind: 'ok', text: `Updated ${name}.` });
    await load();
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

      // Drop anyone whose email or phone is already on file. Read once for the
      // whole paste rather than a query per row — re-pasting last week's
      // spreadsheet is the normal way this screen gets used, and it has to be a
      // no-op rather than a second copy of the congregation.
      const onFile = await getDocs(collection(db, COLLECTIONS.members));
      const takenPhones = new Set<string>();
      const takenEmails = new Set<string>();
      for (const d of onFile.docs) {
        const p = d.get('phoneE164');
        const e = d.get('emailLower');
        if (p) takenPhones.add(p);
        if (e) takenEmails.add(e);
      }

      const fresh = records.filter((r) => {
        const taken =
          (r.phoneE164 && takenPhones.has(r.phoneE164)) || (r.emailLower && takenEmails.has(r.emailLower));
        if (taken) errors.push(`${r.name}: already on file`);
        return !taken;
      });

      // Firestore caps a batch at 500 writes.
      for (let i = 0; i < fresh.length; i += 400) {
        const batch = writeBatch(db);
        for (const record of fresh.slice(i, i + 400)) {
          // Deterministic id, same rule as scripts/migrate-members.mjs, so two
          // simultaneous imports overwrite one document instead of racing to
          // create two.
          batch.set(doc(db, COLLECTIONS.members, memberId(record)), {
            ...record,
            createdAt: serverTimestamp(),
          });
        }
        await batch.commit();
      }

      setCsv('');
      setBanner({
        kind: fresh.length ? 'ok' : 'error',
        text: `Imported ${fresh.length} member${fresh.length === 1 ? '' : 's'}.${
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

  // Anyone who arrived today — self-registered at the door, or typed in here.
  // Worth its own section: these are the rows nobody has checked yet.
  const joinedToday = useMemo(() => {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    return members
      .filter((m) => m.createdAt && m.createdAt >= midnight)
      .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  }, [members]);

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

      {editing && (
        <EditMember
          key={editing.id}
          member={editing}
          onSave={onSaveEdit}
          onDone={() => setEditing(null)}
        />
      )}

      {disputes.length > 0 && (
        <section className="panel warn-panel">
          <h3>
            Name corrections ({disputes.length})
          </h3>
          <p className="muted small">
            Sent by members from the check-in screen. Nothing has been changed — you decide.
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>We show</th>
                <th>They say</th>
                <th>Phone</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {disputes.map((d) => (
                <tr key={d.id}>
                  <td>{d.shownName ?? '—'}</td>
                  <td>
                    <strong>{d.claimedName}</strong>
                  </td>
                  <td className="muted small">{d.phoneE164 ? formatPhone(d.phoneE164) : '—'}</td>
                  <td className="actions">
                    <button className="link" onClick={() => applyDispute(d)} disabled={!d.shownMemberId}>
                      Use their name
                    </button>
                    <button className="link danger" onClick={() => dismissDispute(d)}>
                      Dismiss
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {joinedToday.length > 0 && (
        <details className="panel" open>
          <summary>Joined today ({joinedToday.length})</summary>
          <p className="muted small">
            Newly added members, most recent first. Anyone marked “at the door” added themselves from
            the check-in screen — worth a glance for typos and duplicates under a second number.
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Phone</th>
                <th>Added</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {joinedToday.map((m) => (
                <tr key={m.id}>
                  <td>{m.name}</td>
                  <td className="muted small">{m.phoneE164 ? formatPhone(m.phoneE164) : (m.email ?? '—')}</td>
                  <td className="muted small">
                    {m.source === 'self' ? 'at the door' : 'by an admin'}
                    {m.createdAt
                      ? ` · ${m.createdAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
                      : ''}
                  </td>
                  <td className="actions">
                    <button className="link" onClick={() => setEditing(m)}>
                      Edit
                    </button>
                    <button className="link danger" onClick={() => onDelete(m)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

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
                  <td className="actions">
                    <button className="link" onClick={() => setEditing(m)}>
                      Edit
                    </button>
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

// -------------------------------------------------------------------- editing

/**
 * Correct a member in place.
 *
 * This is the repair tool for the 21 July import, which paired a run of names
 * against the wrong phone numbers — so the common edit is a name, against a
 * number that is already right.
 */
function EditMember({
  member,
  onSave,
  onDone,
}: {
  member: Member;
  onSave: (member: Member, name: string, emailLower: string | null) => Promise<void>;
  onDone: () => void;
}) {
  const [name, setName] = useState(member.name);
  const [email, setEmail] = useState(member.email ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Name is required.');
      return;
    }

    const emailLower = email.trim() ? normalizeEmail(email) : null;
    if (email.trim() && !emailLower) {
      setError(`"${email}" isn’t a valid email address.`);
      return;
    }
    if (!emailLower && !member.phoneE164) {
      setError('This member has no phone number, so an email address is required.');
      return;
    }

    setBusy(true);
    try {
      await onSave(member, trimmedName, emailLower);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    // noValidate: this form does its own checking, and says why in a sentence
    // rather than a browser tooltip.
    <form className="panel add-member" onSubmit={onSubmit} noValidate>
      <h3>Editing {member.name}</h3>
      <div className="row">
        <div>
          <label htmlFor="e-name">Name</label>
          <input id="e-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </div>
        <div>
          <label htmlFor="e-email">Email</label>
          <input id="e-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <label htmlFor="e-phone">Phone</label>
          <input
            id="e-phone"
            value={member.phoneE164 ? formatPhone(member.phoneE164) : '—'}
            readOnly
            disabled
            aria-describedby="e-phone-hint"
          />
        </div>
      </div>
      <p className="hint" id="e-phone-hint">
        The phone number can’t be changed here — it’s what their check-ins are filed under. To move
        someone to a new number, remove them and add them again.
      </p>

      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}

      <div className="row tight form-actions">
        <button type="submit" className="primary" disabled={busy || !name.trim()}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
        <button type="button" className="secondary" onClick={onDone} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
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
 * The document id a member must live at.
 *
 * Derived from the contact details rather than random, so "one person, one
 * document" is a property of the database instead of something every write path
 * has to remember. Check-in resolves a phone with `.limit(1)`, which silently
 * picks one of a set — the only way it can never pick the wrong name is for the
 * set to be impossible to build.
 *
 * Phone digits match `scripts/migrate-members.mjs`, so the office adding someone
 * by hand and the import script landing the same person converge on one doc.
 */
function memberId(record: NewMember): string {
  if (record.phoneE164) return record.phoneE164.replace(/\D/g, '');
  // Emails contain no '/', so they are already valid ids. Prefixed so an
  // all-digit local part can't collide with a phone-derived id.
  return `e-${record.emailLower}`;
}

/** The contact details of a member, as the check-in endpoint would look them up. */
function contactKeys(record: NewMember): string[] {
  return [record.phoneE164, record.emailLower].filter((v): v is string => Boolean(v));
}

/**
 * Is this email or phone already on file — under any id, including the random
 * ones written before member ids became deterministic?
 *
 * @param exceptId the member being edited, who is allowed to keep their own
 *   contact details without that counting as a clash.
 */
async function findByContact(
  record: NewMember,
  exceptId?: string,
): Promise<{ id: string; name: string } | null> {
  for (const [field, value] of [
    ['phoneE164', record.phoneE164],
    ['emailLower', record.emailLower],
  ] as const) {
    if (!value) continue;
    const snap = await getDocs(
      query(collection(db, COLLECTIONS.members), where(field, '==', value), limit(2)),
    );
    const hit = snap.docs.find((d) => d.id !== exceptId);
    if (hit) return { id: hit.id, name: hit.get('name') ?? '(no name)' };
  }
  return null;
}

function clashMessage(record: NewMember, existingName: string): string {
  const what = record.phoneE164 ? formatPhone(record.phoneE164) : record.emailLower;
  return `${what} is already on file as "${existingName}". Correct or remove that record first — one contact can only belong to one person.`;
}

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

    // Don't import the same person twice within one paste. Every contact detail
    // counts, not just the first one present — otherwise a row with an email and
    // a row carrying only the phone slip past each other as two people.
    const keys = contactKeys(built.value);
    if (keys.some((k) => seen.has(k))) {
      errors.push(`line ${index + 1}: duplicate of an earlier row`);
      return;
    }
    for (const k of keys) seen.add(k);
    records.push(built.value);
  });

  return { records, errors };
}
