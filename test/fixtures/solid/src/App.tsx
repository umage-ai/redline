import { createSignal, type JSX } from 'solid-js';
import { EditZone } from './EditZone';

function Card(props: { title: string; children: JSX.Element }) {
  return (
    <section class="card">
      <h2>{props.title}</h2>
      {props.children}
    </section>
  );
}

export function App() {
  const [n, setN] = createSignal(0);
  return (
    <main>
      <h1>Solid fixture</h1>
      <Card title="Counter">
        <button data-testid="card-action" onClick={() => setN(n() + 1)}>Clicked {n()}</button>
      </Card>
      <EditZone />
    </main>
  );
}
