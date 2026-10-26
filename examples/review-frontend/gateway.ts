// The gateway's one decision: does this request go to the review frontend? (setup 3, docs/SETUPS.md)
//
// Runs in your gateway or reverse proxy, after authentication and before routing. The browser's
// cookie only *selects*: anyone can set a cookie, so a request carrying it is checked against a
// flag only your server can write. Without the cookie nothing is looked up, so normal traffic
// costs nothing. Shown as plain functions; the same rule fits YARP, Express, Fastify or Envoy.

export const REVIEW_COOKIE = 'review-mode';           // set by the app for reviewers who switched it on
export const REVIEW_HEADER = 'x-review-frontend';     // internal: set here, matched by the routing rule
export const flagKey = (userId: string) => `review:enabled:${userId}`;   // e.g. a Redis key with a 15 min TTL

export interface GatewayRequest {
  headers: Record<string, string | string[] | undefined>;
  cookies: Record<string, string | undefined>;
  /** The signed-in user's id, after your authentication ran; undefined when anonymous. */
  userId?: string;
}

/**
 * Strip any client-sent REVIEW_HEADER, then set it only for a signed-in user with the cookie and
 * a live flag. A failed lookup serves the normal frontend: Redline is a convenience, the app is not.
 * Route `REVIEW_HEADER: on` to the review frontend, everything else to the normal one.
 */
export async function chooseFrontend(
  req: GatewayRequest,
  flagExists: (key: string) => Promise<boolean>,
  log: (msg: string, err: unknown) => void = () => {},
): Promise<'review' | 'normal'> {
  delete req.headers[REVIEW_HEADER];
  if (req.cookies[REVIEW_COOKIE] !== 'on' || !req.userId) return 'normal';
  try {
    if (!(await flagExists(flagKey(req.userId)))) return 'normal';
  } catch (err) {
    log(`review flag lookup failed for ${req.userId}`, err);
    return 'normal';
  }
  req.headers[REVIEW_HEADER] = 'on';
  return 'review';
}
