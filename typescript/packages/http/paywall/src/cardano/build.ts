import esbuild from "esbuild";
import { htmlPlugin } from "@craftamap/esbuild-plugin-html";
import fs from "fs";
import path from "path";
import { getBaseTemplate } from "../baseTemplate";
import { formatTypeScript } from "../genHelpers";

// Cardano-specific build. TypeScript template only: the Go and Python SDKs have
// no Cardano mechanism, so their servers cannot advertise cardano:* routes.
const DIST_DIR = "src/cardano/dist";
const OUTPUT_HTML = path.join(DIST_DIR, "cardano-paywall.html");
const OUTPUT_TS = path.join("src/cardano/gen", "template.ts");
const ENTRY_POINTS = ["src/cardano/entry.tsx", "src/styles.css", "src/cardano/styles.css"];

const options: esbuild.BuildOptions = {
  entryPoints: ENTRY_POINTS,
  bundle: true,
  metafile: true,
  outdir: DIST_DIR,
  treeShaking: true,
  minify: true,
  format: "iife",
  sourcemap: false,
  platform: "browser",
  target: "es2020",
  jsx: "automatic",
  // Brand SVGs are imported as text and rendered as data: URIs; the font is
  // inlined into the CSS so the page makes no third-party requests.
  loader: { ".svg": "text", ".woff2": "dataurl" },
  define: {
    "process.env.NODE_ENV": '"production"',
    global: "globalThis",
    Buffer: "globalThis.Buffer",
  },
  mainFields: ["browser", "module", "main"],
  conditions: ["browser"],
  plugins: [
    htmlPlugin({
      files: [
        {
          entryPoints: ENTRY_POINTS,
          filename: "cardano-paywall.html",
          title: "Payment Required",
          scriptLoading: "module",
          inline: {
            css: true,
            js: true,
          },
          htmlTemplate: getBaseTemplate(),
        },
      ],
    }),
  ],
  inject: ["./src/buffer-polyfill.ts"],
  external: ["crypto"],
};

/**
 * Builds the Cardano paywall HTML template with bundled JS and CSS.
 */
async function build() {
  try {
    fs.mkdirSync(DIST_DIR, { recursive: true });
    fs.mkdirSync(path.dirname(OUTPUT_TS), { recursive: true });

    await esbuild.build(options);
    console.log("[Cardano] Build completed successfully!");

    if (!fs.existsSync(OUTPUT_HTML)) {
      throw new Error(`Cardano bundled HTML not found at ${OUTPUT_HTML}`);
    }
    const html = fs.readFileSync(OUTPUT_HTML, "utf8");
    const rawTsContent = `// THIS FILE IS AUTO-GENERATED - DO NOT EDIT
/**
 * The pre-built Cardano paywall template with inlined CSS and JS
 */
export const CARDANO_PAYWALL_TEMPLATE = ${JSON.stringify(html)};
`;
    fs.writeFileSync(OUTPUT_TS, await formatTypeScript(OUTPUT_TS, rawTsContent));
    console.log(`[Cardano] Generated template.ts (${(html.length / 1024 / 1024).toFixed(2)} MB)`);
  } catch (error) {
    console.error("[Cardano] Build failed:", error);
    process.exit(1);
  }
}

build();
