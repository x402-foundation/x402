import esbuild from "esbuild";
import { htmlPlugin } from "@craftamap/esbuild-plugin-html";
import fs from "fs";
import path from "path";
import { getBaseTemplate } from "../baseTemplate";

// AVM-specific build - only bundles Algorand dependencies
const DIST_DIR = "src/avm/dist";
const OUTPUT_HTML = path.join(DIST_DIR, "avm-paywall.html");
const OUTPUT_TS = path.join("src/avm/gen", "template.ts");

// Cross-language template output paths (relative to package root where build runs)
const PYTHON_DIR = path.join("..", "..", "..", "..", "python", "x402", "http", "paywall");
const GO_DIR = path.join("..", "..", "..", "..", "go", "http");
const OUTPUT_PY = path.join(PYTHON_DIR, "avm_paywall_template.py");
const OUTPUT_GO = path.join(GO_DIR, "avm_paywall_template.go");

const options: esbuild.BuildOptions = {
  entryPoints: ["src/avm/entry.tsx", "src/styles.css"],
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
          entryPoints: ["src/avm/entry.tsx", "src/styles.css"],
          filename: "avm-paywall.html",
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
  external: [
    "crypto",
    // Mark unused wallet providers as external - we only use Pera, Defly, Lute
    "@algorandfoundation/liquid-auth-use-wallet-client",
    "@perawallet/connect-beta",
    "@agoralabs-sh/avm-web-provider",
    "@walletconnect/sign-client",
    "@walletconnect/modal",
  ],
};

/**
 * Builds the AVM paywall HTML template with bundled JS and CSS.
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
    console.log("[AVM] Build completed successfully!");

    if (fs.existsSync(OUTPUT_HTML)) {
      const html = fs.readFileSync(OUTPUT_HTML, "utf8");

      const tsContent = `// THIS FILE IS AUTO-GENERATED - DO NOT EDIT
/**
 * The pre-built AVM paywall template with inlined CSS and JS
 */
export const AVM_PAYWALL_TEMPLATE = ${JSON.stringify(html)};
`;

      // Generate Python template file
      const pyContent = `# THIS FILE IS AUTO-GENERATED - DO NOT EDIT
AVM_PAYWALL_TEMPLATE = ${JSON.stringify(html)}
`;

      // Generate Go template file
      const goContent = `// THIS FILE IS AUTO-GENERATED - DO NOT EDIT
package http

// AVMPaywallTemplate is the pre-built AVM paywall template with inlined CSS and JS
const AVMPaywallTemplate = ${JSON.stringify(html)}
`;

      fs.writeFileSync(OUTPUT_TS, tsContent);
      console.log(`[AVM] Generated template.ts (${(html.length / 1024 / 1024).toFixed(2)} MB)`);

      // Write the Python template file
      if (fs.existsSync(PYTHON_DIR)) {
        fs.writeFileSync(OUTPUT_PY, pyContent);
        console.log(
          `[AVM] Generated Python avm_paywall_template.py (${(html.length / 1024 / 1024).toFixed(2)} MB)`,
        );
      } else {
        console.warn(`[AVM] Python directory not found: ${PYTHON_DIR}`);
      }

      // Write the Go template file
      if (fs.existsSync(GO_DIR)) {
        fs.writeFileSync(OUTPUT_GO, goContent);
        console.log(
          `[AVM] Generated Go avm_paywall_template.go (${(html.length / 1024 / 1024).toFixed(2)} MB)`,
        );
      } else {
        console.warn(`[AVM] Go directory not found: ${GO_DIR}`);
      }
    } else {
      throw new Error(`AVM bundled HTML not found at ${OUTPUT_HTML}`);
    }
  } catch (error) {
    console.error("[AVM] Build failed:", error);
    process.exit(1);
  }
}

build();
