// Angular CLI dev-server builder (Angular 17+, the esbuild/Vite `@angular/build` dev server).
// Angular doesn't take Vite plugins, so this wraps its dev server (D23): same options,
// plus a `redline` block. In angular.json:
//
//   "serve": { "builder": "@umage.ai/redline:dev-server", "options": { "buildTarget": "app:build:development", "redline": { "directEdit": true } } }
//
// It adds the /__redline middleware and the script injector, and (dev only) turns on Angular's
// `enableTemplateSourceLocations`, which stamps every template element with
// data-ng-source-location="src/app/x.html@o:…,l:…,c:…" for the overlay. `ng build` is untouched.

import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { clientFile } from './vite.ts';
import { createHandler, type RedlineOptions } from './server/handler.ts';

/** The `redline` block in angular.json: the JSON-safe subset of the Vite plugin options. */
export interface RedlineAngularOptions extends Pick<RedlineOptions, 'dir' | 'hotkey' | 'launcher' | 'app' | 'extensions'> {
  /** Notes root, relative to the workspace. Default: nearest folder with .git. */
  root?: string;
  /** true = the built-in source writers (D20). Default false. */
  directEdit?: boolean;
  /** Stamp template elements with their file:line in dev (enableTemplateSourceLocations). Default true. */
  templateSourceLocations?: boolean;
}

type Json = Record<string, unknown>;
type Target = { project: string; target: string; configuration?: string };
interface Context {
  workspaceRoot: string;
  target?: Target;
  logger: { info(m: string): void; warn(m: string): void };
  getTargetOptions(t: Target): Promise<Json>;
  getProjectMetadata(p: string): Promise<Json>;
  validateOptions(o: Json, builder: string): Promise<Json>;
}
type Output = { success: boolean; baseUrl?: string; [k: string]: unknown };
type Middleware = (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void;
type Execute = (o: Json, c: Context, ext: { middleware?: Middleware[] }) => AsyncIterable<Output>;

// Angular's packages come from the workspace (they're not our dependencies; pnpm won't hoist them to us).
const fromWorkspace = (dir: string) => createRequire(path.join(dir, 'package.json'));
function load<T>(id: string, dir: string): T {
  try { return fromWorkspace(dir)(id) as T; } catch { return createRequire(import.meta.url)(id) as T; }
}

export async function* devServer(options: Json & { redline?: RedlineAngularOptions }, context: Context): AsyncIterable<Output> {
  const ws = context.workspaceRoot;
  const { redline: rl = {}, ...ngOptions } = options;
  const { executeDevServerBuilder } = load<{ executeDevServerBuilder: Execute }>('@angular/build', ws);
  const project = context.target?.project;
  const meta = project ? await context.getProjectMetadata(project).catch(() => ({} as Json)) : {};
  const serverRoot = path.resolve(ws, String(meta.root ?? ''));
  const { templateSourceLocations, root, directEdit, ...rest } = rl;

  const { api, inject, register } = createHandler({
    ...rest, directEdit: directEdit === true, root: root ? path.resolve(ws, root) : undefined, serverRoot, clientFile,
  });
  const ctx = templateSourceLocations === false ? context : withSourceLocations(context, project ?? 'app');
  const validated = await context.validateOptions(ngOptions, '@angular/build:dev-server');
  context.logger.info(`  \x1b[31m✎ redline\x1b[0m  notes → ${rl.dir ?? '.redline'}/  (toggle: ${rl.hotkey ?? 'alt+shift+r'})`);
  for await (const out of executeDevServerBuilder(validated, ctx, { middleware: [api, inject] })) {
    if (out.baseUrl) register(String(out.baseUrl).replace(/\/$/, ''));
    yield out;
  }
}

/**
 * The build target's options as Angular reads them, but with a generated tsconfig that extends
 * the app's and adds `enableTemplateSourceLocations` (dev server only; the file lives in
 * node_modules/.cache: Angular purges .angular/cache when it starts).
 */
function withSourceLocations(context: Context, project: string): Context {
  const getTargetOptions = async (t: Target) => {
    const o = await context.getTargetOptions(t);
    if (typeof o.tsConfig !== 'string') return o;
    const rel = path.join('node_modules', '.cache', 'redline', `tsconfig.${project.replace(/[^\w.-]/g, '_')}.json`);
    const abs = path.join(context.workspaceRoot, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, JSON.stringify({
      extends: path.resolve(context.workspaceRoot, o.tsConfig).replace(/\\/g, '/'),
      angularCompilerOptions: { enableTemplateSourceLocations: true },
    }, null, 2));
    return { ...o, tsConfig: rel.replace(/\\/g, '/') };
  };
  return new Proxy(context, {
    get(t, k) {
      if (k === 'getTargetOptions') return getTargetOptions;
      const v = Reflect.get(t, k, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

// What Angular's architect loads (`builders.json` → this file). createBuilder comes from the
// workspace's @angular-devkit/architect so the builder symbol matches the CLI's copy.
const architect = (() => {
  try { return load<{ createBuilder(fn: unknown): unknown }>('@angular-devkit/architect', process.cwd()); } catch { return null; }
})();

export default architect ? architect.createBuilder(devServer) : devServer;
