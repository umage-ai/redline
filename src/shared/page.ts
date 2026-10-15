// The page key notes are grouped by (one notes file and one pin set per key). Shared so the
// unit tests can check it without a browser.

export type PageKeyMode = 'route' | 'path';
export type PageLocation = Pick<Location, 'pathname' | 'hash'>;

/**
 * 'route' (default): the decoded path, `/index.html` folded into `/`, plus the hash when it
 * is a hash route (`#/settings`, query dropped). 'path': the path only, every hash ignored.
 */
export function pageKey(loc: PageLocation, mode: PageKeyMode = 'route'): string {
  let p = loc.pathname;
  try { p = decodeURI(p); } catch { /* keep raw */ }
  p = p.replace(/\/index\.html?$/, '/').replace(/\/+$/, '') || '/';
  if (mode === 'route' && loc.hash.startsWith('#/')) p += loc.hash.split('?')[0];
  return p;
}
