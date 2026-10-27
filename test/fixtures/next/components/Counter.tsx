'use client';
import { useState } from 'react';

// A Client Component: stamped in both the server render and the browser bundle.
export function Counter() {
  const [n, setN] = useState(0);
  return <button data-testid="client-action" onClick={() => setN(n + 1)}>Clicked {n}</button>;
}
