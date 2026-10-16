import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { EditZone } from './EditZone';

function Card({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <section class="card">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function App() {
  const [n, setN] = useState(0);
  return (
    <main>
      <h1>Preact fixture</h1>
      <Card title="Counter">
        <button data-testid="card-action" onClick={() => setN(n + 1)}>Clicked {n}</button>
      </Card>
      <EditZone />
    </main>
  );
}
