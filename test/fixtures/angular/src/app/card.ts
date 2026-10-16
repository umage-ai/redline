import { Component, input } from '@angular/core';

// Inline template: Redline reports src/app/card.ts:line for elements written here.
@Component({
  selector: 'app-card',
  template: `
    <section class="card">
      <h2 data-testid="card-title">{{ title() }}</h2>
      <ng-content />
    </section>
  `,
})
export class Card {
  title = input('');
}
