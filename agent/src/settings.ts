// The viewer's agent settings (D59, D62), kept in this browser: the CLI the next prompt runs, and per
// CLI a model and an effort level. Shared by the toolbar (panel.ts) and the CLI window's Start
// (terminal.ts). Only values the server offered for that CLI are ever sent (it checks them again).

/** A model or effort level a CLI offers. */
export interface Choice { value: string; name?: string }
/** A CLI as /agent/info lists it (D59, D62). `pending`: an ACP agent whose lists are still being asked for. */
export interface Cli { id: string; name: string; command: string; models?: Choice[]; efforts?: Choice[]; pending?: boolean }
/** Per CLI id: the model and effort picked (none: the project's default). */
export type PerCli = Record<string, { model?: string; effort?: string }>;

/** Which open notes Apply hands over (D68): this app's on every page, or this page's only. */
export type Scope = 'app' | 'page';

export const CLI_KEY = 'redline.agent.cli';
export const SCOPE_KEY = 'redline.agent.scope';
export const SETTINGS_KEY = 'redline.agent.settings';
export const OFFER_KEY = 'redline.agent.offer';

// localStorage can be missing or throw (a private window, blocked site data): the choice then lasts this page only.
export const recallCli = () => { try { return localStorage.getItem(CLI_KEY); } catch { return null; } };
export const rememberCli = (id: string | null) => { try { if (id) localStorage.setItem(CLI_KEY, id); else localStorage.removeItem(CLI_KEY); } catch { /* this page only */ } };
export const recallScope = (): Scope | null => { try { const v = localStorage.getItem(SCOPE_KEY); return v === 'app' || v === 'page' ? v : null; } catch { return null; } };
export const rememberScope = (s: Scope | null) => { try { if (s) localStorage.setItem(SCOPE_KEY, s); else localStorage.removeItem(SCOPE_KEY); } catch { /* this page only */ } };
/** Whether a saved note offers to go to the agent (D69): on unless turned off in this browser. */
export const recallOffer = () => { try { return localStorage.getItem(OFFER_KEY) !== '0'; } catch { return true; } };
export const rememberOffer = (on: boolean | null) => { try { if (on === false) localStorage.setItem(OFFER_KEY, '0'); else localStorage.removeItem(OFFER_KEY); } catch { /* this page only */ } };
export function recallSettings(): PerCli {
  try {
    const v = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
export const rememberSettings = (p: PerCli | null) => { try { if (p && Object.keys(p).length) localStorage.setItem(SETTINGS_KEY, JSON.stringify(p)); else localStorage.removeItem(SETTINGS_KEY); } catch { /* this page only */ } };

/** The viewer's CLI (D59): the one remembered if it is still offered, else the server's default, else the first. */
export function pickCli(clis: Pick<Cli, 'id'>[], remembered: string | null | undefined, fallback?: string): string {
  return clis.find(c => c.id === remembered)?.id ?? clis.find(c => c.id === fallback)?.id ?? clis[0]?.id ?? '';
}

/** The model and effort to send for a CLI: the viewer's, only while the CLI still offers them. */
export function pickFor(cli: Pick<Cli, 'id' | 'models' | 'efforts'> | undefined, per: PerCli): { model?: string; effort?: string } {
  const mine = cli ? per[cli.id] : undefined;
  if (!cli || !mine) return {};
  const model = mine.model && cli.models?.some(m => m.value === mine.model) ? mine.model : undefined;
  const effort = mine.effort && cli.efforts?.some(m => m.value === mine.effort) ? mine.effort : undefined;
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}
