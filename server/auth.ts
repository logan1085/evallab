/**
 * Accounts, sessions and workspace membership.
 *
 * The product now serves several teams from one instance, which makes tenancy a
 * correctness problem rather than a feature: every read has to be scoped by
 * membership, and the failure mode is one customer seeing another's traces.
 *
 * Passwords use scrypt from node's own crypto, so there is still no native
 * dependency. Sessions are opaque random tokens stored server-side rather than
 * signed cookies, because that makes them revocable — signing out, or removing
 * someone from a workspace, has to actually take effect.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';

export const SESSION_COOKIE = 'gr_session';
const SESSION_DAYS = 30;
const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, expected] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;
  const actual = scryptSync(password, salt, SCRYPT_KEYLEN);
  const expectedBuf = Buffer.from(expected, 'hex');
  // Length check first: timingSafeEqual throws on a mismatch rather than
  // returning false, and a thrown error here would read as a server fault.
  if (expectedBuf.length !== actual.length) return false;
  return timingSafeEqual(actual, expectedBuf);
}

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sessionExpiry(): string {
  return new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/** Parses exactly the one cookie we set. Avoids a dependency for five lines. */
export function readSessionCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function setSessionCookie(res: Response, token: string, secure: boolean): void {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_DAYS * 24 * 60 * 60}`,
  ];
  if (secure) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

export function clearSessionCookie(res: Response): void {
  res.append('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Deliberately mild. A password rule nobody can satisfy is its own security problem. */
export function passwordProblem(password: string): string | null {
  if (password.length < 10) return 'Use at least 10 characters.';
  if (password.length > 200) return 'That password is too long.';
  return null;
}

export type Role = 'owner' | 'member';

/** Owners manage the corpus, the rubric and rounds. Members grade. */
export function canManage(role: Role | null): boolean {
  return role === 'owner';
}

export function canGrade(role: Role | null): boolean {
  return role === 'owner' || role === 'member';
}
