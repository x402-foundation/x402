import esbuild from "esbuild";
import { htmlPlugin } from "@craftamap/esbuild-plugin-html";
import fs from "fs";
import path from "path";
import { getBaseTemplate } from "../baseTemplate";
import { formatTypeScript, toPythonStringLiteral } from "../genHelpers";

// SVM-specific build - only bundles Solana dependencies
const DIST_DIR = "src/svm/dist";
const OUTPUT_HTML = path.join(DIST_DIR, "svm-paywall.html");
const OUTPUT_TS = path.join("src/svm/gen", "template.ts");

// Cross-language template output paths (relative to package root where build runs)
const PYTHON_DIR = path.join("..", "..", "..", "..", "python", "x402", "http", "paywall");
const GO_DIR = path.join("..", "..", "..", "..", "go", "http");
const OUTPUT_PY = path.join(PYTHON_DIR, "svm_paywall_template.py");
const OUTPUT_GO = path.join(GO_DIR, "svm_paywall_template.go");

const options: esbuild.BuildOptions = {
  entryPoints: ["src/svm/entry.tsx", "src/styles.css"],
  bundle: true,
  metafile: true,
  outdir: DIST_DIR,
  treeShaking: true,
  minify: true,
  format: "iife",
  sourcemap: false,
  platform: "browser",
  target: "es2020",
  jsx: "transform",
  define: {
    "process.env.NODE_ENV": '"development"',
    global: "globalThis",
    Buffer: "globalThis.Buffer",
  },
  mainFields: ["browser", "module", "main"],
  conditions: ["browser"],
  plugins: [
    htmlPlugin({
      files: [
        {
          entryPoints: ["src/svm/entry.tsx", "src/styles.css"],
          filename: "svm-paywall.html",
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
 * Builds the SVM paywall HTML template with bundled JS and CSS.
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
    console.log("[SVM] Build completed successfully!");

    if (fs.existsSync(OUTPUT_HTML)) {
      const html = fs.readFileSync(OUTPUT_HTML, "utf8");

      const rawTsContent = `// THIS FILE IS AUTO-GENERATED - DO NOT EDIT
/**
 * The pre-built SVM paywall template with inlined CSS and JS
 */
export const SVM_PAYWALL_TEMPLATE = ${JSON.stringify(html)};
`;
      const tsContent = await formatTypeScript(OUTPUT_TS, rawTsContent);

      // Generate Python template file
      const pyContent = `# THIS FILE IS AUTO-GENERATED - DO NOT EDIT
SVM_PAYWALL_TEMPLATE = ${toPythonStringLiteral(html)}
`;

      // Generate Go template file
      const goContent = `// THIS FILE IS AUTO-GENERATED - DO NOT EDIT
package http

// SVMPaywallTemplate is the pre-built SVM paywall template with inlined CSS and JS
const SVMPaywallTemplate = ${JSON.stringify(html)}
`;

      fs.writeFileSync(OUTPUT_TS, tsContent);
      console.log(`[SVM] Generated template.ts (${(html.length / 1024 / 1024).toFixed(2)} MB)`);

      // Write the Python template file
      if (fs.existsSync(PYTHON_DIR)) {
        fs.writeFileSync(OUTPUT_PY, pyContent);
        console.log(
          `[SVM] Generated Python svm_paywall_template.py (${(html.length / 1024 / 1024).toFixed(2)} MB)`,
        );
      } else {
        console.warn(`[SVM] Python directory not found: ${PYTHON_DIR}`);
      }

      // Write the Go template file
      if (fs.existsSync(GO_DIR)) {
        fs.writeFileSync(OUTPUT_GO, goContent);
        console.log(
          `[SVM] Generated Go svm_paywall_template.go (${(html.length / 1024 / 1024).toFixed(2)} MB)`,
        );
      } else {
        console.warn(`[SVM] Go directory not found: ${GO_DIR}`);
      }
    } else {
      throw new Error(`SVM bundled HTML not found at ${OUTPUT_HTML}`);
    }
  } catch (error) {
    console.error("[SVM] Build failed:", error);
    process.exit(1);
  }
}

build();
