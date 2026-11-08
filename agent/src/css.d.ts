// esbuild loads .css as text for the agent terminal (scripts/build.mjs).
declare module '*.css' {
  const css: string;
  export default css;
}
