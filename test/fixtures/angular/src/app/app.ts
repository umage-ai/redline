import { Component, signal } from '@angular/core';
import { Card } from './card';
import { EditZone } from './edit-zone';

@Component({
  selector: 'app-root',
  imports: [Card, EditZone],
  templateUrl: './app.html',
})
export class App {
  n = signal(0);
}
