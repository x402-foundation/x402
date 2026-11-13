// The Cardano paywall bundles its brand SVGs as raw text (esbuild "text" loader).
declare module "*.svg" {
  const markup: string;
  export default markup;
}
