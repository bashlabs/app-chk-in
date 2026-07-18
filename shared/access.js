/**
 * Access rules for the check-in page.
 *
 * All of this is evaluated on the server against the server's clock. A device
 * clock is user-controlled, so a browser-side "is it Sunday?" check would be
 * trivially bypassed by changing the phone's date.
 */

/**
 * @typedef {'schedule'|'open'|'closed'} AccessMode
 * @typedef {'override'|'schedule'|'day'|'time'|'disabled'} AccessReason
 * @typedef {string|Date|{toMillis(): number}|null} TimestampLike
 *
 * @typedef {object} AccessConfig
 * @property {string} timezone IANA zone the schedule is read in.
 * @property {number[]} allowedDays 0 = Sunday … 6 = Saturday.
 * @property {number|null} startMinutes Minutes from midnight; null = no bound.
 * @property {number|null} endMinutes
 * @property {AccessMode} mode
 * @property {TimestampLike} overrideUntil
 * @property {string} closedMessage
 * @property {string} successMessage
 * @property {string} unknownMessage
 */

/** @type {AccessConfig} */
export const DEFAULT_CONFIG = {
  timezone: 'Africa/Lagos',
  /** 0 = Sunday … 6 = Saturday */
  allowedDays: [0],
  /** Minutes from midnight; null = no bound. */
  startMinutes: null,
  endMinutes: null,
  /** 'schedule' follows allowedDays; 'open'/'closed' are manual overrides. */
  mode: 'schedule',
  /** Optional expiry for mode === 'open'; after it, we fall back to schedule. */
  overrideUntil: null,
  closedMessage:
    'Check-in is closed right now. It opens for Sunday service — please come back then.',
  successMessage:
    'Thanks for coming to church today, this will help us to identify those that are not in church today',
  unknownMessage:
    "We couldn't find your record. Please stop by the welcome desk so we can get you registered.",
};

/** @type {Record<string, number>} */
const DAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/**
 * Wall-clock date/time in a given IANA timezone, without pulling in a date lib.
 *
 * @param {Date} date
 * @param {string} timeZone
 * @returns {{ date: string, dayOfWeek: number, minutes: number }}
 */
export function zonedNow(date, timeZone) {
  /** @type {Record<string, string>} */
  const parts = {};
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;

  // Throw rather than default a missing part. Intl always returns these for the
  // options above, but a silent fallback here would be dangerous: defaulting
  // the weekday to 0 means Sunday, which would *open* the gate on a Tuesday.
  const need = (/** @type {string} */ type) => {
    const value = parts[type];
    if (value === undefined) throw new Error(`Intl returned no "${type}" for ${timeZone}`);
    return value;
  };

  const weekday = need('weekday');
  const dayOfWeek = DAY_INDEX[weekday];
  if (dayOfWeek === undefined) throw new Error(`Unrecognised weekday "${weekday}"`);

  return {
    date: `${need('year')}-${need('month')}-${need('day')}`,
    dayOfWeek,
    minutes: Number(need('hour')) * 60 + Number(need('minute')),
  };
}

/** @param {string} dateStr YYYY-MM-DD @param {number} n */
export function addDays(dateStr, n) {
  // Anchor at noon UTC so DST shifts can never roll us onto the wrong day.
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** @param {string} dateStr YYYY-MM-DD */
export function dayOfWeekOf(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`).getUTCDay();
}

/**
 * @param {number} minutes
 * @param {number|null} start
 * @param {number|null} end
 */
function withinWindow(minutes, start, end) {
  if (start == null && end == null) return true;
  return minutes >= (start ?? 0) && minutes <= (end ?? 24 * 60 - 1);
}

/**
 * @param {AccessConfig} config
 * @param {Date} now
 * @returns {{
 *   open: boolean,
 *   reason: AccessReason,
 *   serviceDate: string,
 *   dayOfWeek: number,
 *   minutes: number,
 *   nextOpenDate: string|null,
 * }}
 */
export function evaluateAccess(config, now) {
  const z = zonedNow(now, config.timezone);

  /** @type {boolean} */
  let open;
  /** @type {AccessReason} */
  let reason;

  if (config.mode === 'closed') {
    open = false;
    reason = 'disabled';
  } else if (config.mode === 'open' && !overrideExpired(config, now)) {
    open = true;
    reason = 'override';
  } else {
    const dayOk = config.allowedDays.includes(z.dayOfWeek);
    const timeOk = withinWindow(z.minutes, config.startMinutes, config.endMinutes);
    open = dayOk && timeOk;
    reason = !dayOk ? 'day' : !timeOk ? 'time' : 'schedule';
  }

  return {
    open,
    reason,
    serviceDate: z.date,
    dayOfWeek: z.dayOfWeek,
    minutes: z.minutes,
    nextOpenDate: open ? null : nextOpenDate(config, z),
  };
}

/**
 * @param {AccessConfig} config
 * @param {Date} now
 */
function overrideExpired(config, now) {
  const until = config.overrideUntil;
  if (!until) return false; // open indefinitely

  // Firestore hands back a Timestamp; the admin form and tests send strings.
  const millis =
    typeof until === 'object' && 'toMillis' in until
      ? until.toMillis()
      : new Date(/** @type {string|Date} */ (until)).getTime();

  return now.getTime() >= millis;
}

/**
 * Next calendar date whose weekday is allowed. Null if no day is enabled.
 *
 * @param {AccessConfig} config
 * @param {ReturnType<typeof zonedNow>} z
 * @returns {string|null}
 */
function nextOpenDate(config, z) {
  if (config.mode === 'closed' || !config.allowedDays?.length) return null;

  // Today still counts if we're merely before the opening time.
  const start = config.allowedDays.includes(z.dayOfWeek) && z.minutes < (config.startMinutes ?? 0) ? 0 : 1;
  for (let i = start; i <= 7; i++) {
    const date = addDays(z.date, i);
    if (config.allowedDays.includes(dayOfWeekOf(date))) return date;
  }
  return null;
}

/**
 * Merges a stored config document over the defaults, dropping unknown or
 * malformed fields so a bad admin write can't wedge the check-in page.
 *
 * @param {Record<string, unknown>|undefined} stored
 * @returns {AccessConfig}
 */
export function resolveConfig(stored) {
  const c = /** @type {AccessConfig} */ ({ ...DEFAULT_CONFIG, ...(stored ?? {}) });

  if (!Array.isArray(c.allowedDays) || c.allowedDays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    c.allowedDays = DEFAULT_CONFIG.allowedDays;
  }
  if (!['schedule', 'open', 'closed'].includes(c.mode)) c.mode = DEFAULT_CONFIG.mode;

  const inRange = (/** @type {unknown} */ v) =>
    v == null || (Number.isInteger(v) && /** @type {number} */ (v) >= 0 && /** @type {number} */ (v) <= 1439);

  if (!inRange(c.startMinutes)) c.startMinutes = null;
  if (!inRange(c.endMinutes)) c.endMinutes = null;

  if (c.startMinutes != null && c.endMinutes != null && c.startMinutes > c.endMinutes) {
    c.startMinutes = null;
    c.endMinutes = null;
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: c.timezone });
  } catch {
    c.timezone = DEFAULT_CONFIG.timezone;
  }

  return c;
}
