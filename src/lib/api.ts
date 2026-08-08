/**
 * The public check-in API, served by Netlify Functions.
 *
 * Plain fetch against our own origin — no Firebase SDK on this path at all,
 * which is why the check-in page stays small. Only the admin screens load
 * Firestore and Auth.
 */

export type AccessReason = 'override' | 'schedule' | 'day' | 'time' | 'disabled';

export type AccessStatus = {
  open: boolean;
  reason: AccessReason;
  serviceDate: string;
  nextOpenDate: string | null;
  nextOpenDay: string | null;
  message: string | null;
  openDays: string[];
};

export type CheckInResult =
  | { found: false; message: string }
  | {
      found: true;
      alreadyCheckedIn: boolean;
      name: string | null;
      serviceDate: string;
      message: string;
      /** Present only on /api/register: true when this created the member. */
      created?: boolean;
    };

/** An error the server described well enough to show the user as-is. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    /** Present on a `closed` error: the fresh access state to re-render with. */
    readonly accessStatus: AccessStatus | null = null,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError('Network problem — check your connection and try again.', 'offline', 0);
  }

  let body: any = null;
  try {
    body = await res.json();
  } catch {
    // A non-JSON body means something upstream broke (a proxy, a 502 page).
  }

  if (!res.ok) {
    throw new ApiError(
      body?.message ?? 'Something went wrong. Please try again.',
      body?.error ?? 'unknown',
      res.status,
      body?.status ?? null,
    );
  }

  return body as T;
}

export const getAccessStatus = () => request<AccessStatus>('/api/access-status');

export const checkIn = (identifier: string, recaptchaToken?: string) =>
  request<CheckInResult>('/api/check-in', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier, recaptchaToken }),
  });

/** Register someone who isn't on file yet, and check them in in the same step. */
export const register = (identifier: string, name: string, recaptchaToken?: string) =>
  request<CheckInResult>('/api/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier, name, recaptchaToken }),
  });

/** "That isn't my name." Recorded for an admin; never applied automatically. */
export const reportWrongName = (identifier: string, claimedName: string, recaptchaToken?: string) =>
  request<{ recorded: true; message: string }>('/api/dispute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier, claimedName, recaptchaToken }),
  });

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  // Firestore rejections still reach the admin screens.
  const e = err as { message?: string };
  return e?.message || 'Something went wrong. Please try again.';
}

/** The closed-page details ride along on a 403 `closed` error. */
export function accessDetailsFrom(err: unknown): AccessStatus | null {
  return err instanceof ApiError ? err.accessStatus : null;
}
