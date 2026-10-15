import { useState } from 'preact/hooks';

// Direct-edit fixture (D20): test/e2e/extend.spec.ts edits this file and restores it.
export function EditZone() {
  const [n] = useState(2);
  return (
    <section class="edit-zone">
      <h2 data-testid="edit-heading">Static heading</h2>
      <p data-testid="edit-rich">Fish &amp; <b>chips</b> on the <a class="menu" href="#menu">menu</a> daily</p>
      <p data-testid="edit-dynamic">Count {n}</p>
    </section>
  );
}
