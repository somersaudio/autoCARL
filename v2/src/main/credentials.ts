import keytar from 'keytar';

// keytar service strings — v2-prefixed so we don't collide with v1 entries.
const SVC = {
  carlPassword: 'AUTOcarl2-carl-password',
  sswPassword: 'AUTOcarl2-ssw-password',
  icalUrl: 'AUTOcarl2-ical-url',
};

const ACC_ICAL = 'ical-url';

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
