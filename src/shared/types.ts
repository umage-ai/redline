// The note model shared by the overlay (browser) and the store (Node).
// Everything in `Note` except body/reply/done is written into the anchor comment
// of the markdown file; body, reply and done live in the markdown itself so an
// agent (or a human) can edit them by hand.

export type NoteType = 'comment' | 'sketch' | 'text';

export interface SourceLoc {
  file: string;   // repo-relative where we can tell, otherwise as reported by the framework
  line?: number;
  col?: number;
}

/** CMS content an element's text comes from (CMS integrations, e.g. UmageAI.Redline.Optimizely). */
export interface CmsRef {
  content?: string;         // content id/reference, e.g. "5" or "5_12"
  property?: string;        // property name, e.g. "Heading"
  name?: string;            // content name, filled in by the server integration
  type?: string;            // content type name
  lang?: string;
  edit?: string;            // URL of the content in the CMS editor
}

export interface Target {
  selector?: string;        // best unique CSS selector we could build
  testid?: string;          // data-testid / data-test / data-cy
  id?: string;
  xpath?: string;
  tag?: string;
  text?: string;            // trimmed text snippet, used to re-find the element
  role?: string;
  name?: string;            // accessible name
  html?: string;            // outerHTML excerpt
  source?: SourceLoc;       // where the element is written in source (framework dev metadata)
  components?: string[];    // component chain, innermost first (React/Svelte where available)
  cms?: CmsRef;             // CMS content and property the element renders (CMS integrations)
  box?: [number, number, number, number]; // document coords x,y,w,h at capture time
  fx?: number;              // pin position as a fraction of the element box
  fy?: number;
}

export interface Note {
  id: string;
  type: NoteType;
  page: string;             // normalised pathname; one markdown file per page (per app)
  app?: string;             // monorepos: the dev server's folder relative to the root, e.g. "apps/web"
  url: string;
  title?: string;           // document.title
  at: string;               // 'YYYY-MM-DD HH:MM'
  whole?: boolean;          // note about the whole page, no element
  label?: string;           // the reviewer's tag, e.g. "Bug" or "UX" (the `labels` option, D46)
  target?: Target;
  viewport?: [number, number, number]; // width, height, devicePixelRatio
  scroll?: [number, number];
  theme?: 'light' | 'dark';
  from?: string;            // text notes: current text
  to?: string;              // text notes: wanted text
  screenshot?: string;      // path relative to the page file, e.g. ../assets/<id>.png
  sketch?: string;          // ../assets/<id>.svg
  errors?: string[];        // recent console errors at capture time
  author?: string;          // signed-in reviewer (online mode, or whoever a remote store's token belongs to); set by the server
  build?: string;           // the build the page was served from (the `build` option), so source lines are read at that revision
  // Set by a remote store (docs/PROTOCOL.md, D40-D42), never by the page, never written to markdown:
  resolvedAt?: string;      // ISO time it was resolved; the overlay shows it green while the store still lists it
  mine?: boolean;           // the caller is the note's author
  seen?: boolean;           // the author has seen it resolved
  href?: string;            // the note in the store's own UI
  // markdown-owned
  body: string;
  reply: string;
  done: boolean;
}

export interface NewNoteRequest {
  note: Omit<Note, 'reply' | 'done' | 'screenshot' | 'sketch' | 'at' | 'id'> & { id?: string };
  screenshot?: string;      // data:image/png;base64,...
  sketch?: string;          // raw SVG
}

export interface NotesResponse {
  version: string;
  root: string;             // folder (relative to project root) holding the notes
  notes: Note[];
}

/** Fields only a store sets: dropped from what a page sends, and never written into markdown. */
export const STORE_OWNED = ['author', 'resolvedAt', 'mine', 'seen', 'href'] as const;

export const API_BASE = '/__redline';
