'use client';
import { useState } from 'react';

function RoundsTab() {
  const [n, setN] = useState(0);
  return <button data-testid="rounds-action" onClick={() => setN(n + 1)}>Rounds {n}</button>;
}

export function AdminClient() {
  return <RoundsTab />;
}
