import esbuild from "esbuild";
import { htmlPlugin } from "@craftamap/esbuild-plugin-html";
import fs from "fs";
import path from "path";
import { getBaseTemplate } from "../baseTemplate";
import { formatTypeScript, toPythonStringLiteral } from "../genHelpers";

// Stellar-specific build - only bundles Stellar dependencies
const DIST_DIR = "src/stellar/dist";
const OUTPUT_HTML = path.join(DIST_DIR, "stellar-paywall.html");
const OUTPUT_TS = path.join("src/stellar/gen", "template.ts");

// Cross-language template output paths (relative to package root where build runs)
const PYTHON_DIR = path.join("..", "..", "..", "..", "python", "x402", "http", "paywall");
const GO_DIR = path.join("..", "..", "..", "..", "go", "http");
const OUTPUT_PY = path.join(PYTHON_DIR, "stellar_paywall_template.py");
const OUTPUT_GO = path.join(GO_DIR, "stellar_paywall_template.go");

const options: esbuild.BuildOptions = {
  entryPoints: ["src/stellar/entry.tsx", "src/stellar/styles.css"],
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
          entryPoints: ["src/stellar/entry.tsx", "src/stellar/styles.css"],
          filename: "stellar-paywall.html",
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
 * Builds the Stellar paywall HTML template with bundled JS and CSS.
 * Also generates Python and Go template files for cross-language support.
 */
async function build() {
  try {
    if (!fs.existsSync(DIST_DIR)) {
      fs.mkdirSync(DIST_DIR, { recursive: true });
    }

    const genDir = path.dirname(OUTPUT_TS);
    if (!fs.existsSync(genDir)) {
      fs.mkdirSync(genDir, { recursive: true });
    }

    await esbuild.build(options);
    console.log("[Stellar] Build completed successfully!");

    if (fs.existsSync(OUTPUT_HTML)) {
      const html = fs.readFileSync(OUTPUT_HTML, "utf8");

      const rawTsContent = `// THIS FILE IS AUTO-GENERATED - DO NOT EDIT
/**
 * The pre-built Stellar paywall template with inlined CSS and JS
 */
export const STELLAR_PAYWALL_TEMPLATE = ${JSON.stringify(html)};
`;
      const tsContent = await formatTypeScript(OUTPUT_TS, rawTsContent);

      // Generate Python template file
      const pyContent = `# THIS FILE IS AUTO-GENERATED - DO NOT EDIT
STELLAR_PAYWALL_TEMPLATE = ${toPythonStringLiteral(html)}
`;

      // Generate Go template file
      const goContent = `// THIS FILE IS AUTO-GENERATED - DO NOT EDIT
package http

// StellarPaywallTemplate is the pre-built Stellar paywall template with inlined CSS and JS
const StellarPaywallTemplate = ${JSON.stringify(html)}
`;

      fs.writeFileSync(OUTPUT_TS, tsContent);
      console.log(`[Stellar] Generated template.ts (${(html.length / 1024 / 1024).toFixed(2)} MB)`);

      // Write the Python template file
      if (fs.existsSync(PYTHON_DIR)) {
        fs.writeFileSync(OUTPUT_PY, pyContent);
        console.log(
          `[Stellar] Generated Python stellar_paywall_template.py (${(html.length / 1024 / 1024).toFixed(2)} MB)`,
        );
      } else {
        console.warn(`[Stellar] Python directory not found: ${PYTHON_DIR}`);
      }

      // Write the Go template file
      if (fs.existsSync(GO_DIR)) {
        fs.writeFileSync(OUTPUT_GO, goContent);
        console.log(
          `[Stellar] Generated Go stellar_paywall_template.go (${(html.length / 1024 / 1024).toFixed(2)} MB)`,
        );
      } else {
        console.warn(`[Stellar] Go directory not found: ${GO_DIR}`);
      }
    } else {
      throw new Error(`Stellar bundled HTML not found at ${OUTPUT_HTML}`);
    }
  } catch (error) {
    console.error("[Stellar] Build failed:", error);
    process.exit(1);
  }
}

build();
