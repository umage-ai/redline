// The demo's one real route (/drivers), without a router: pushState and an event the root listens to.
// It lets reviewers try Redline's notes per page; the other sidebar links stay dummies.
import { useEffect, useState } from 'react';

export const PAGES: Record<string, string> = { Overview: '/', Drivers: '/drivers' };

export function navigate(to: string) {
  if (to === location.pathname) return;
  history.pushState(null, '', to);
  dispatchEvent(new PopStateEvent('popstate'));
}

export function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    addEventListener('popstate', on);
    return () => removeEventListener('popstate', on);
  }, []);
  return path;
}
