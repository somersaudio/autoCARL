// The phone and email that go on a timesheet. Each can carry an override in
// Settings, set there or by tapping it at the bottom of the Timesheet tab. A
// save writes the override, else the week's own value, else the newest
// timesheet that has one (see recoverContact in src/main/ssw.ts).
//
// These cleaners decide what an override may hold. Each returns the cleaned
// value, '' for a blank entry (no override), or null when the entry can't be
// used. Mirrored in worker-api/src/ssw.ts; keep them identical.

export const TIMESHEET_EMAIL_MAX = 120;

export function cleanTimesheetEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const e = raw.trim();
  if (!e) return '';
  // Control and invisible characters (a zero-width space pasted from an email
  // signature, say) would land in SSW looking just like the real address.
  if (e.length > TIMESHEET_EMAIL_MAX || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(e)) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

// SSW keeps phone numbers as bare digits with the country code, 11 of them for
// a US number, so an entry is saved the same way: "(512) 555-0123" becomes
// 15125550123, the same as what SSW already holds. It needs 10 to 15 digits,
// with nothing around them but spaces and + ( ) - .
export function cleanTimesheetPhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const p = raw.trim();
  if (!p) return '';
  if (p.length > 40 || !/^\+?[\d\s().-]+$/.test(p)) return null;
  const digits = p.replace(/\D/g, '');
  if (/^[2-9]\d{9}$/.test(digits)) return `1${digits}`;
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}
