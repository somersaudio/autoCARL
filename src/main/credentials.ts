import keytar from 'keytar';

const SVC = {
  carlPassword: 'AUTOcarl-carl-password',
  sswPassword: 'AUTOcarl-ssw-password',
  icalUrl: 'AUTOcarl-ical-url',
};

// Previous service names, from when this app shipped alongside its predecessor
// and prefixed everything to avoid clashing with it. migrateCredentials() below
// lifts entries across on first run; this table can go once everyone has
// launched the app at least once.
const LEGACY_SVC: Record<keyof typeof SVC, string> = {
  carlPassword: 'AUTOcarl2-carl-password',
  sswPassword: 'AUTOcarl2-ssw-password',
  icalUrl: 'AUTOcarl2-ical-url',
};

const ACC_ICAL = 'ical-url';

/**
 * Copy any credentials still stored under the old service names across to the
 * current ones. Safe to call on every launch: it only writes when the new
 * service has no entry, and it never deletes the old one — so a failure
 * halfway through leaves the originals intact and re-running just finishes
 * the job. Deliberately never throws; a keychain hiccup should degrade to
 * "log in again", not stop the app booting.
 */
export async function migrateCredentials(): Promise<void> {
  for (const key of Object.keys(SVC) as Array<keyof typeof SVC>) {
    try {
      const current = await keytar.findCredentials(SVC[key]);
      if (current.length > 0) continue;            // already migrated
      const legacy = await keytar.findCredentials(LEGACY_SVC[key]);
      for (const { account, password } of legacy) {
        await keytar.setPassword(SVC[key], account, password);
      }
    } catch {
      /* keychain unavailable — fall through, the user can re-enter creds */
    }
  }
}

export async function saveCarlPassword(email: string, password: string): Promise<void> {
  await keytar.setPassword(SVC.carlPassword, email, password);
}
export async function findStoredCarlEmail(): Promise<string | null> {
  const creds = await keytar.findCredentials(SVC.carlPassword);
  return creds[0]?.account || null;
}
export async function findStoredSswEmail(): Promise<string | null> {
  const creds = await keytar.findCredentials(SVC.sswPassword);
  return creds[0]?.account || null;
}
export async function getCarlPassword(email: string): Promise<string | null> {
  return keytar.getPassword(SVC.carlPassword, email);
}
export async function clearCarlPassword(email: string): Promise<void> {
  await keytar.deletePassword(SVC.carlPassword, email);
}

export async function saveSswPassword(email: string, password: string): Promise<void> {
  await keytar.setPassword(SVC.sswPassword, email, password);
}
export async function getSswPassword(email: string): Promise<string | null> {
  return keytar.getPassword(SVC.sswPassword, email);
}
export async function clearSswPassword(email: string): Promise<void> {
  await keytar.deletePassword(SVC.sswPassword, email);
}

export async function saveIcalUrl(url: string): Promise<void> {
  await keytar.setPassword(SVC.icalUrl, ACC_ICAL, url);
}
export async function getIcalUrl(): Promise<string | null> {
  return keytar.getPassword(SVC.icalUrl, ACC_ICAL);
}
export async function clearIcalUrl(): Promise<void> {
  await keytar.deletePassword(SVC.icalUrl, ACC_ICAL);
}
