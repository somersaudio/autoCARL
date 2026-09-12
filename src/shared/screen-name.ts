// A screen name is what buddies see beside your icon. The friends service is
// the authority (friends-worker/src/index.ts applies the same rule on sign-on
// and rename); the apps check it first so the Sign On and Screen Name boxes
// can explain a problem before sending anything. Whitespace is tidied,
// "Last, First" is flipped the way timesheets store names, and an email is
// refused, because an email is what people type into a box labelled Screen
// Name that sits next to a login.

export const SCREEN_NAME_MAX = 40;

export function normalizeScreenName(raw: string): { name: string } | { error: string } {
  const tidy = Array.from(String(raw ?? ''))
    .filter((ch) => { const code = ch.charCodeAt(0); return code >= 32 && code !== 127; })
    .join('').replace(/\s+/g, ' ').trim();
  if (!tidy) return { error: 'Enter the name your coworkers know you by.' };
  if (tidy.includes('@')) return { error: 'That looks like an email. Use your name, the way coworkers know you.' };
  const lastFirst = tidy.match(/^([^,]+),\s*([^,]+)$/);
  const name = lastFirst ? `${lastFirst[2].trim()} ${lastFirst[1].trim()}` : tidy;
  if (!/[A-Za-z]/.test(name) && !/[^ -~]/.test(name)) return { error: 'A screen name needs at least one letter.' };
  if (name.length < 2) return { error: 'That screen name is too short.' };
  if (name.length > SCREEN_NAME_MAX) return { error: `Keep your screen name under ${SCREEN_NAME_MAX} characters.` };
  return { name };
}
