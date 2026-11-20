import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "tsup";
import { expect, it } from "vitest";

it("excludes Solana runtime dependencies from the EVM entry", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "x402-siwx-bundle-"));
  const inputs = new Map<string, string[]>();
  try {
    for (const entry of ["evm/index", "index"]) {
      await build({
        entry: [resolve("src/sign-in-with-x", `${entry}.ts`)],
        outDir,
        config: false,
        dts: false,
        format: "esm",
        platform: "node",
        noExternal: [/.*/],
        silent: true,
        metafile: true,
        esbuildPlugins: [
          {
            name: "record-runtime-inputs",
            setup(build) {
              build.onEnd(result => {
                inputs.set(entry, Object.keys(result.metafile?.inputs ?? {}));
              });
            },
          },
        ],
      });
    }
    const evmInputs = inputs.get("evm/index");
    const mixedInputs = inputs.get("index");
    expect(evmInputs).toBeDefined();
    expect(mixedInputs).toBeDefined();
    for (const dependency of [/tweetnacl/, /@noble\/curves\/.*ed25519/, /sign-in-with-x\/solana/]) {
      expect(mixedInputs?.some(path => dependency.test(path))).toBe(true);
      expect(evmInputs?.some(path => dependency.test(path))).toBe(false);
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}, 30_000);
