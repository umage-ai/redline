// Every word the overlay shows (D50). mount's `strings` option (or the config's) replaces any of
// them; `{name}` placeholders are filled in. Keys stay stable across releases: new text gets a
// new key, so a translation that lacks it falls back to English.

export const STRINGS = {
  // toolbar
  brand: 'Redline',
  launcherTitle: 'Redline ({hotkey})',
  comment: 'Comment',
  commentHow: 'click an element. Alt+click picks its parent, Shift+click the whole page.',
  text: 'Text',
  textHow: 'click any text and rewrite it in place; Enter keeps it.',
  sketch: 'Sketch',
  sketchHow: 'draw boxes, arrows, lines and labels. Ctrl+Z undoes, Enter finishes.',
  notes: 'Notes',
  notesTitle: 'Notes (N)',
  close: 'Close ({hotkey})',
  dragLauncher: 'drag to move',
  dragBar: 'Drag to move · double-click to put back',
  // gate
  gateFirst: 'Finish the step above first',
  gateFailed: 'Could not continue: {error}',
  // panel
  closePanel: 'Close panel (N)',
  thisPage: 'This page ({n})',
  all: 'All ({n})',
  showDone: 'Show done',
  thisPageGroup: '{label}  (this page)',
  emptyPage: 'No notes on this page yet. Press C to comment.',
  emptyPageDone: 'All notes on this page are done.',
  emptyAll: 'No notes yet.',
  wholePage: 'whole page',
  showOnPage: 'Show on page',
  openPage: 'Open page',
  openIn: 'Open in {dir}',
  markDone: 'Mark done',
  reopen: 'Reopen',
  status: 'Status',
  edit: 'Edit',
  delete: 'Delete',
  deleteConfirm: 'Delete?',
  label: 'Label',
  seeSketch: 'See the sketch.',
  screenshotAlt: 'screenshot',
  staleTitle: '{at} · open for over {days} days; the UI may have changed since',
  notFoundOnPage: '⚠ element not found on page',
  elementNotFound: 'Element not found on this page',
  agent: 'Agent',
  replyPlaceholder: 'Reply…',
  send: 'Send',
  updateFailed: 'Update failed: {error}',
  deleteFailed: 'Delete failed: {error}',
  sendFailed: 'Could not send: {error}',
  copyPrompt: 'Copy prompt for your agent',
  promptCopied: 'Prompt copied — paste it into your coding agent',
  tabCapture: 'Pixel-perfect screenshots (tab capture)',
  tabCaptureTitle: 'Capture the real pixels of this tab (needed for WebGL/maps/video). Chrome asks for permission once per page load.',
  tabCaptureDenied: 'Tab capture was not allowed',
  // the prompt copied for an agent (the server's `prompt` option replaces it whole)
  promptGuide: 'Follow {guide} (the redline skill).',
  promptHow: 'For each open "### [ ]" note: make the change, tick it "### [x]" and add a one-line "> " reply saying what changed (or a question, leaving it open). Never edit the <!-- redline … --> lines.',
  promptPage: 'Apply the open Redline notes in {file} ({n} open). {how}',
  promptAll: 'Apply the open Redline UI feedback in {dir}/INDEX.md ({n} open). {how}',
  // the popover
  placeholderComment: 'What should change here?',
  placeholderText: 'Optional: why / anything else…',
  placeholderSketch: 'What does the sketch mean? (optional)',
  parent: '↑ Parent',
  parentTitle: 'Comment on the parent element instead',
  page: 'Page',
  pageTitle: 'Comment on the whole page',
  sketchOf: 'sketch · {what}',
  sketchPage: 'page',
  labelTitle: 'Label: {name} (or type #{tag} )',
  screenshot: 'Screenshot',
  screenshotTitle: 'Attach a screenshot with the target outlined',
  cancel: 'Cancel',
  save: 'Save',
  saveNote: 'Save note',
  applyToFile: 'Apply to file',
  applyChecking: 'Checking whether this text is written in source…',
  applyTitle: 'Write the new text into {file}',
  applyRefusedTitle: "Can't apply to source: {reason}",
  applyRefused: "Can't apply to the file: {reason}. Save it as a note for your agent.",
  written: 'Written to {file}',
  writeFirst: 'Write a comment first',
  saved: 'Saved → {file}',
  saveFailed: 'Could not save: {error}',
  saving: 'Saving…',
  savingLarge: 'Large pages take a little longer to screenshot. Hold on…',
  wantedSource: 'Wanted source (keeps the markup): `{html}`',
  // sketch
  box: '▭ Box',
  arrow: '→ Arrow',
  pen: '✎ Pen',
  sketchText: 'T Text',
  colour: 'Colour',
  colourTitle: 'Colour: {name} (C cycles)',
  colorRed: 'Red', colorAmber: 'Amber', colorBlue: 'Blue', colorGreen: 'Green', colorBlack: 'Black', colorWhite: 'White',
  undo: '↶ Undo',
  undoTitle: 'Undo (Ctrl+Z)',
  clear: 'Clear',
  cancelTitle: 'Cancel (Esc)',
  done: 'Done',
  nothingDrawn: 'Nothing drawn',
  sketchLabel: 'Label…',
  // extensions
  extensionFailed: 'Extension failed to load: {url}',
};

export type RedlineStrings = typeof STRINGS;
export type StringKey = keyof RedlineStrings;
export type Translate = (key: StringKey, vars?: Record<string, string | number>) => string;

/** `t(key, vars)` over the defaults with `overrides` on top. A placeholder without a value stays as written. */
export function translator(...overrides: (Partial<RedlineStrings> | undefined)[]): Translate {
  const table: Record<string, string> = { ...STRINGS };
  for (const o of overrides) for (const [k, v] of Object.entries(o ?? {})) if (typeof v === 'string') table[k] = v;
  return (key, vars) => {
    const s = table[key] ?? key;
    return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
  };
}
