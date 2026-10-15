import { Component } from '@angular/core';

// Direct-edit fixture (D20): test/e2e/extend.spec.ts edits edit-zone.html and restores it.
@Component({ selector: 'app-edit-zone', templateUrl: './edit-zone.html' })
export class EditZone {
  n = 2;
}
