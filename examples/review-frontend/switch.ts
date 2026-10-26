// The reviewer's switch (setup 3, docs/SETUPS.md): who carries the review-mode cookie, and when
// the server-side flag is written. Your app owns both; the gateway only reads them (gateway.ts).
//
// - The switch lives on the user (a profile setting, say), for users allowed to review: QA,
//   customers in acceptance testing, content editors, partners.
// - Turning it on saves the setting, sets the cookie and writes the flag (short TTL). Turning it
//   off, or losing the right to review, deletes the flag; the cookie follows on the next page.
// - The flag's TTL is refreshed where your app already loads the current user, so a revoked
//   reviewer drops off the review frontend within the TTL, and the notes API refuses at once.

import { REVIEW_COOKIE, flagKey } from './gateway.ts';

export const FLAG_TTL_SECONDS = 15 * 60;

export interface Reviewer {
  id: string;
  /** Your rule: a role, a plan, a feature flag. */
  mayReview: boolean;
  /** The user's own switch. */
  reviewOn: boolean;
}

export const wantsReview = (u: Reviewer | null | undefined) => !!u && u.mayReview && u.reviewOn;

/**
 * What to do with the cookie, given the user and whether the request carried it; null = leave it.
 * Call it where the user is already loaded for a page (a layout), so it costs no extra round trip.
 * Only a signed-in user is judged: a lapsed session on its way to sign-in keeps its cookie, so
 * signing back in lands on the same frontend.
 */
export function cookieAction(user: Reviewer | null | undefined, hasCookie: boolean): 'set' | 'delete' | null {
  if (!user) return null;
  const wanted = wantsReview(user);
  if (wanted && !hasCookie) return 'set';
  if (!wanted && hasCookie) return 'delete';
  return null;
}

/** The cookie: httpOnly (scripts never need it), lax (top-level navigations carry it), secure on https. */
export const cookieOptions = (https: boolean) => ({ path: '/', httpOnly: true, sameSite: 'lax' as const, secure: https, maxAge: 60 * 60 * 24 * 365 });

/** Keep the flag in step with the user; `kv` is Redis or anything with set-with-TTL and delete. */
export async function syncFlag(user: Reviewer, kv: { set(key: string, ttlSeconds: number): Promise<void>; del(key: string): Promise<void> }) {
  if (wantsReview(user)) await kv.set(flagKey(user.id), FLAG_TTL_SECONDS);
  else await kv.del(flagKey(user.id));
}

export { REVIEW_COOKIE };
