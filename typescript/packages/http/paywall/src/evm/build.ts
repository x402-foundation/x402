import esbuild from "esbuild";
import { htmlPlugin } from "@craftamap/esbuild-plugin-html";
import fs from "fs";
import path from "path";
import { DEFAULT_STABLECOINS } from "@x402/evm";
import { getBaseTemplate } from "../baseTemplate";
import { formatTypeScript, toPythonStringLiteral } from "../genHelpers";

// EVM-specific build - only bundles EVM dependencies
const DIST_DIR = "src/evm/dist";
const OUTPUT_HTML = path.join(DIST_DIR, "evm-paywall.html");
const OUTPUT_TS = path.join("src/evm/gen", "template.ts");
const OUTPUT_DECIMALS = path.join("src/evm/gen", "decimals.ts");

// Cross-language template output paths (relative to package root where build runs)
const PYTHON_DIR = path.join("..", "..", "..", "..", "python", "x402", "http", "paywall");
const GO_DIR = path.join("..", "..", "..", "..", "go", "http");
const OUTPUT_PY = path.join(PYTHON_DIR, "evm_paywall_template.py");
const OUTPUT_GO = path.join(GO_DIR, "evm_paywall_template.go");

const options: esbuild.BuildOptions = {
  entryPoints: ["src/evm/entry.tsx", "src/styles.css"],
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
          entryPoints: ["src/evm/entry.tsx", "src/styles.css"],
          filename: "evm-paywall.html",
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
 * Builds the EVM paywall HTML template with bundled JS and CSS.
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
    console.log("[EVM] Build completed successfully!");

    if (fs.existsSync(OUTPUT_HTML)) {
      const html = fs.readFileSync(OUTPUT_HTML, "utf8");

      const rawTsContent = `// THIS FILE IS AUTO-GENERATED - DO NOT EDIT
/**
 * The pre-built EVM paywall template with inlined CSS and JS
 */
export const EVM_PAYWALL_TEMPLATE = ${JSON.stringify(html)};
`;
      const tsContent = await formatTypeScript(OUTPUT_TS, rawTsContent);

      // Generate Python template file
      const pyContent = `# THIS FILE IS AUTO-GENERATED - DO NOT EDIT
EVM_PAYWALL_TEMPLATE = ${toPythonStringLiteral(html)}
`;

      // Generate Go template file
      const goContent = `// THIS FILE IS AUTO-GENERATED - DO NOT EDIT
package http

// EVMPaywallTemplate is the pre-built EVM paywall template with inlined CSS and JS
const EVMPaywallTemplate = ${JSON.stringify(html)}
`;

      fs.writeFileSync(OUTPUT_TS, tsContent);
      console.log(`[EVM] Generated template.ts (${(html.length / 1024 / 1024).toFixed(2)} MB)`);

      // Generate a runtime-dep-free decimals lookup sourced from @x402/evm's
      // DEFAULT_STABLECOINS. Keeps @x402/evm as a devDependency only while
      // preserving a single source of truth for per-network decimals (CI drift
      // check in check_paywall_template.yml covers regen correctness).
      const decimalsMap: Record<string, number> = Object.fromEntries(
        Object.entries(DEFAULT_STABLECOINS).map(([network, info]) => [network, info.decimals]),
      );
      const decimalsEntries = Object.entries(decimalsMap)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([network, decimals]) => `  ${JSON.stringify(network)}: ${decimals},`)
        .join("\n");
      const decimalsContent = `// THIS FILE IS AUTO-GENERATED - DO NOT EDIT
// Source: @x402/evm DEFAULT_STABLECOINS (decimals only).
// Regenerate via: pnpm --filter @x402/paywall run build:paywall

/**
 * Per-network default token decimals, keyed by CAIP-2 network identifier.
 * Mirrors the \`decimals\` field of \`DEFAULT_STABLECOINS\` from \`@x402/evm\`
 * and is emitted at build time so the paywall's runtime module graph does
 * not depend on \`@x402/evm\`.
 */
export const NETWORK_DECIMALS: Record<string, number> = {
${decimalsEntries}
};
`;
      fs.writeFileSync(OUTPUT_DECIMALS, decimalsContent);
      console.log(`[EVM] Generated decimals.ts (${Object.keys(decimalsMap).length} networks)`);

      // Write the Python template file
      if (fs.existsSync(PYTHON_DIR)) {
        fs.writeFileSync(OUTPUT_PY, pyContent);
        console.log(
          `[EVM] Generated Python evm_paywall_template.py (${(html.length / 1024 / 1024).toFixed(2)} MB)`,
        );
      } else {
        console.warn(`[EVM] Python directory not found: ${PYTHON_DIR}`);
      }

      // Write the Go template file
      if (fs.existsSync(GO_DIR)) {
        fs.writeFileSync(OUTPUT_GO, goContent);
        console.log(
          `[EVM] Generated Go evm_paywall_template.go (${(html.length / 1024 / 1024).toFixed(2)} MB)`,
        );
      } else {
        console.warn(`[EVM] Go directory not found: ${GO_DIR}`);
      }
    } else {
      throw new Error(`EVM bundled HTML not found at ${OUTPUT_HTML}`);
    }
  } catch (error) {
    console.error("[EVM] Build failed:", error);
    process.exit(1);
  }
}

build();
