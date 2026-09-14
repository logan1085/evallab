/**
 * Sealed secrets: how a company's own endpoint key rests in the database.
 *
 * AES-256-GCM under a key derived from GR_SECRET. The row holds the sealed
 * form and a four-character hint; the plain key exists only in memory, for
 * the length of one model call. With no GR_SECRET set the seal still works,
 * under a key derived from a fixed development phrase, and /api/health says
 * so: fine on a laptop, not what production should run on. Rotating
 * GR_SECRET invalidates every sealed key, which is the honest consequence
 * of a rotation, not a bug to paper over.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const DEV_PHRASE = 'grading-room-development-secret';

function keyMaterial(): Buffer {
  return createHash('sha256').update(process.env.GR_SECRET || DEV_PHRASE).digest();
}

/** 'env' when GR_SECRET is set, 'dev-default' when the fixed phrase is in use. */
export function secretsSource(): 'env' | 'dev-default' {
  return process.env.GR_SECRET ? 'env' : 'dev-default';
}

export function sealSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyMaterial(), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join(':');
}

export class SealError extends Error {}

export function openSecret(sealed: string): string {
  const [version, iv, tag, body] = sealed.split(':');
  if (version !== 'v1' || !iv || !tag || !body) throw new SealError('The sealed key is not in a form this server wrote.');
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyMaterial(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new SealError('The sealed key does not open under this GR_SECRET. It was sealed under another; add the key again.');
  }
}

/** The last four characters, for a person to recognise a key without seeing it. */
export function keyHint(plain: string): string {
  const tail = plain.trim().slice(-4);
  return tail ? `…${tail}` : '';
}
