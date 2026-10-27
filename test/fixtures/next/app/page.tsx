import type { ReactNode } from 'react';
import { Counter } from '../components/Counter';
import { EditZone } from '../components/EditZone';

// A Server Component: its elements reach the browser as HTML only, stamps included.
function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export default function Page() {
  return (
    <main>
      <h1>Next fixture</h1>
      <Card title="Counter">
        <button data-testid="card-action">Static action</button>
        <Counter />
      </Card>
      <EditZone />
    </main>
  );
}
