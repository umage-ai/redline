import { useState, type ReactNode } from 'react';

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function App() {
  const [n, setN] = useState(0);
  return (
    <main>
      <h1>React fixture</h1>
      <Card title="Counter">
        <button data-testid="card-action" onClick={() => setN(n + 1)}>Clicked {n}</button>
      </Card>
    </main>
  );
}
