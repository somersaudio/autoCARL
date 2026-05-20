import keytar from 'keytar';
import type { CredService } from '../shared/types';

function serviceKey(s: CredService): string {
  return s === 'carl' ? 'AUTOcarl-carl' : 'AUTOcarl-ssw';
}

export async function saveCredential(service: CredService, username: string, password: string): Promise<void> {
  await keytar.setPassword(serviceKey(service), username, password);
}

export async function getCredential(service: CredService, username: string): Promise<string | null> {
  return keytar.getPassword(serviceKey(service), username);
}

export async function hasCredential(service: CredService, username: string): Promise<boolean> {
  return (await keytar.getPassword(serviceKey(service), username)) !== null;
}

export async function clearCredential(service: CredService, username: string): Promise<void> {
  await keytar.deletePassword(serviceKey(service), username);
}
