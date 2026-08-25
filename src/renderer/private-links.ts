// Personal links pinned to a single login. They render only for the account
// named here — every other user's install shows nothing at all.
//
// NOTE: this is UI gating, not a secret. The renderer bundle ships to every
// user, so someone reading the JavaScript could find these URLs. That's fine
// for a personal convenience link; never put a credential or a private
// document here.

export type PrivateLink = {
  owner: string;     // the C.A.R.L. login this link belongs to, lowercased
  label: string;
  href: string;
  note?: string;
};

const PRIVATE_LINKS: PrivateLink[] = [
  {
    owner: 'john@teamsomo.com',
    label: 'Time Off Request Form',
    href: 'https://stjamesaustin.breezechms.com/form/8a83b2',
    note: 'Your own form — nobody else’s AUTOcarl shows this.',
  },
];

// `email` must be the SAVED account address, not a value the user can type
// into a field — otherwise the gate is one keystroke wide.
export function privateLinksFor(email: string | null | undefined): PrivateLink[] {
  const who = (email || '').trim().toLowerCase();
  if (!who) return [];
  return PRIVATE_LINKS.filter((l) => l.owner === who);
}
