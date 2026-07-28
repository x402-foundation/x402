# Casper Speculative Execution Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional Casper speculative execution to exact facilitator `verify()` when the facilitator signer is configured with a dedicated speculative RPC endpoint.

**Architecture:** Keep the existing targeted preflight checks, then add speculative execution as the final optional verification gate. The signer owns standard and speculative RPC clients; the facilitator scheme builds and signs the same `transfer_with_authorization` call it would settle, using `.buildFor1_5()` only for simulation because `SpeculativeClient` requires a legacy deploy.

**Tech Stack:** TypeScript, `casper-js-sdk@5.0.12`, Vitest, x402 TypeScript monorepo package `@x402/casper`.

## Global Constraints

- Do not use a worktree; use the current branch.
- Keep Casper preflight hooks: balance, authorization state, and transfer-with-authorization support checks remain in verify.
- `RpcUrlConfig` and `SpeculativeRpcUrlConfig` are `Record<string, string>`.
- `createFacilitatorCasperSigner(privateKey, algorithm, options)` keeps `privateKey` and `algorithm` positional; RPC URLs, preflight hooks, and speculative RPC URLs live in an options object.
- Speculative execution is optional and runs only when `options.speculativeRpcUrlConfig[network]` exists.
- No new dependencies.
- No changes to legacy/v1 packages.

---

### Task 1: Signer API Options And Types

**Files:**
- Modify: `typescript/packages/mechanisms/casper/src/types.ts`
- Modify: `typescript/packages/mechanisms/casper/src/signer.ts`
- Test: `typescript/packages/mechanisms/casper/test/unit/signer.test.ts`

**Interfaces:**
- Consumes: Existing `FacilitatorCasperSigner`, `CasperBalanceParams`, `CasperPreflightParams`.
- Produces:
  - `export type RpcUrlConfig = Record<string, string>`
  - `export type SpeculativeRpcUrlConfig = Record<string, string>`
  - `export type PreflightHooks = { getBalance?: (params: CasperBalanceParams) => Promise<bigint>; getAuthorizationState?: (params: CasperPreflightParams) => Promise<CasperAuthorizationState>; assertTransferWithAuthorizationSupported?: (params: { network: Network; asset: string }) => Promise<void> }`
  - `export type FacilitatorCasperSignerOptions = { rpcUrlConfig?: RpcUrlConfig; preflightHooks?: PreflightHooks; speculativeRpcUrlConfig?: SpeculativeRpcUrlConfig }`
  - `export type ToFacilitatorCasperSignerOptions = FacilitatorCasperSignerOptions`
  - `createFacilitatorCasperSigner(privateKey, algorithm, options?)`
  - `toFacilitatorCasperSigner(privateKey, options?)`

- [ ] **Step 1: Write failing signer API tests**

Update `typescript/packages/mechanisms/casper/test/unit/signer.test.ts` so existing facilitator signer calls use the options object:

```ts
const signer = await toFacilitatorCasperSigner(privateKey, {
  rpcUrlConfig: { "casper:casper-test": "http://localhost:11101/rpc" },
});
```

```ts
const signer = await createFacilitatorCasperSigner(
  privateKeyHex(privateKey),
  KeyAlgorithm.SECP256K1,
  {
    rpcUrlConfig: { "casper:casper-test": "http://localhost:11101/rpc" },
  },
);
```

Add this test:

```ts
it("rejects unsupported networks when no RPC URL is configured", async () => {
  const privateKey = PrivateKey.generate(KeyAlgorithm.ED25519);
  const signer = await toFacilitatorCasperSigner(privateKey, {
    rpcUrlConfig: { "casper:casper-test": "http://localhost:11101/rpc" },
  });

  await expect(signer.getNetworkConfig("casper:casper-net-1")).rejects.toThrow(
    "unsupported Casper network: casper:casper-net-1",
  );
});
```

- [ ] **Step 2: Run signer tests to verify failure**

Run:

```bash
pnpm --filter @x402/casper test -- test/unit/signer.test.ts
```

Expected: TypeScript/runtime failures because `toFacilitatorCasperSigner` and `createFacilitatorCasperSigner` still take positional `rpcUrlConfig` and `preflightHooks`.

- [ ] **Step 3: Implement signer API types**

In `typescript/packages/mechanisms/casper/src/types.ts`, add:

```ts
import type { Deploy, Transaction } from "casper-js-sdk";
```

Change the existing `Transaction` import accordingly if it is currently a single-type import.

Add exported types:

```ts
export type RpcUrlConfig = Record<string, string>;
export type SpeculativeRpcUrlConfig = Record<string, string>;

export type PreflightHooks = {
  getBalance?: (params: CasperBalanceParams) => Promise<bigint>;
  getAuthorizationState?: (params: CasperPreflightParams) => Promise<CasperAuthorizationState>;
  assertTransferWithAuthorizationSupported?: (params: {
    network: Network;
    asset: string;
  }) => Promise<void>;
};

export type FacilitatorCasperSignerOptions = {
  rpcUrlConfig?: RpcUrlConfig;
  preflightHooks?: PreflightHooks;
  speculativeRpcUrlConfig?: SpeculativeRpcUrlConfig;
};

export type ToFacilitatorCasperSignerOptions = FacilitatorCasperSignerOptions;

export type CasperSpeculativeTransferParams = {
  network: Network;
  asset: string;
  deploy: Deploy;
};
```

Extend `FacilitatorCasperSigner` with the optional method:

```ts
simulateTransferWithAuthorization?(params: CasperSpeculativeTransferParams): Promise<void>;
```

- [ ] **Step 4: Implement signer API options**

In `typescript/packages/mechanisms/casper/src/signer.ts`, import the new types from `./types` and delete local `RpcUrlConfig` and `PreflightHooks` declarations.

Replace `resolveRpcUrl` with:

```ts
function resolveRpcUrl(network: Network, config?: RpcUrlConfig): string {
  return config?.[network] ?? NetworkConfigs[network]?.rpcUrl ?? "";
}
```

Change function signatures:

```ts
export async function toFacilitatorCasperSigner(
  privateKey: PrivateKeyType,
  options: ToFacilitatorCasperSignerOptions = {},
): Promise<FacilitatorCasperSigner> {
  const { rpcUrlConfig, preflightHooks = {} } = options;
  // existing body
}
```

```ts
export async function createFacilitatorCasperSigner(
  privateKey: string,
  algorithm: KeyAlgorithmType = KeyAlgorithm.ED25519,
  options: FacilitatorCasperSignerOptions = {},
): Promise<FacilitatorCasperSigner> {
  return toFacilitatorCasperSigner(PrivateKey.fromHex(privateKey, algorithm), options);
}
```

- [ ] **Step 5: Run signer tests**

Run:

```bash
pnpm --filter @x402/casper test -- test/unit/signer.test.ts
```

Expected: PASS for existing migrated tests. Speculative hook tests are not added until Task 2.

- [ ] **Step 6: Commit**

```bash
git add typescript/packages/mechanisms/casper/src/types.ts typescript/packages/mechanisms/casper/src/signer.ts typescript/packages/mechanisms/casper/test/unit/signer.test.ts
git commit -m "refactor: use options for casper facilitator signer"
```

### Task 2: Signer Speculative Client Hook

**Files:**
- Modify: `typescript/packages/mechanisms/casper/src/signer.ts`
- Test: `typescript/packages/mechanisms/casper/test/unit/signer.test.ts`

**Interfaces:**
- Consumes: `SpeculativeRpcUrlConfig`, `CasperSpeculativeTransferParams`, `FacilitatorCasperSignerOptions`.
- Produces: Optional `FacilitatorCasperSigner.simulateTransferWithAuthorization(params)`.

- [ ] **Step 1: Write failing speculative hook tests**

In `typescript/packages/mechanisms/casper/test/unit/signer.test.ts`, change imports to:

```ts
import { describe, expect, it, vi } from "vitest";
```

Mock the SDK before importing signer functions:

```ts
const speculativeExec = vi.fn();

vi.mock("casper-js-sdk", async importOriginal => {
  const actual = await importOriginal<typeof import("casper-js-sdk")>();
  return {
    default: {
      ...actual.default,
      SpeculativeClient: {
        newSpeculativeClient: vi.fn(() => ({ speculativeExec })),
      },
    },
  };
});
```

If Vitest hoisting makes the current import order awkward, move the `casperSdk` import below the mock and use `vi.hoisted` for `speculativeExec`.

Add tests:

```ts
it("does not expose speculative simulation without a speculative RPC URL", async () => {
  const privateKey = PrivateKey.generate(KeyAlgorithm.ED25519);
  const signer = await toFacilitatorCasperSigner(privateKey, {
    rpcUrlConfig: { "casper:casper-test": "http://localhost:11101/rpc" },
  });

  expect(signer.simulateTransferWithAuthorization).toBeUndefined();
});
```

```ts
it("exposes speculative simulation when a speculative RPC URL is configured", async () => {
  const privateKey = PrivateKey.generate(KeyAlgorithm.ED25519);
  const signer = await toFacilitatorCasperSigner(privateKey, {
    speculativeRpcUrlConfig: { "casper:casper-test": "http://localhost:7778/rpc" },
  });

  expect(signer.simulateTransferWithAuthorization).toBeDefined();
});
```

Use a real deploy-form transaction for success/failure tests:

```ts
function buildDeploy(privateKey: InstanceType<typeof PrivateKey>) {
  const transaction = new casperSdk.ContractCallBuilder()
    .from(privateKey.publicKey)
    .byPackageHash("a".repeat(64))
    .entryPoint("transfer_with_authorization")
    .runtimeArgs(casperSdk.Args.fromMap({}))
    .chainName("casper-test")
    .payment(2_500_000_000)
    .buildFor1_5();
  transaction.sign(privateKey);
  const deploy = transaction.getDeploy();
  if (!deploy) throw new Error("expected deploy");
  return deploy;
}
```

Add success/failure assertions:

```ts
it("calls speculativeExec with the deploy", async () => {
  speculativeExec.mockResolvedValueOnce({ executionResultV1: { success: {} } });
  const privateKey = PrivateKey.generate(KeyAlgorithm.ED25519);
  const deploy = buildDeploy(privateKey);
  const signer = await toFacilitatorCasperSigner(privateKey, {
    speculativeRpcUrlConfig: { "casper:casper-test": "http://localhost:7778/rpc" },
  });

  await expect(
    signer.simulateTransferWithAuthorization!({
      network: "casper:casper-test",
      asset: "a".repeat(64),
      deploy,
    }),
  ).resolves.toBeUndefined();

  expect(speculativeExec).toHaveBeenCalledWith("1", deploy);
});
```

```ts
it("throws speculative execution failure messages", async () => {
  speculativeExec.mockResolvedValueOnce({
    executionResultV1: { failure: { errorMessage: "reverted" } },
  });
  const privateKey = PrivateKey.generate(KeyAlgorithm.ED25519);
  const signer = await toFacilitatorCasperSigner(privateKey, {
    speculativeRpcUrlConfig: { "casper:casper-test": "http://localhost:7778/rpc" },
  });

  await expect(
    signer.simulateTransferWithAuthorization!({
      network: "casper:casper-test",
      asset: "a".repeat(64),
      deploy: buildDeploy(privateKey),
    }),
  ).rejects.toThrow("speculative execution failed: reverted");
});
```

```ts
it("throws Casper v2 speculative execution errors", async () => {
  speculativeExec.mockResolvedValueOnce({ executionResult: { errorMessage: "v2 reverted" } });
  const privateKey = PrivateKey.generate(KeyAlgorithm.ED25519);
  const signer = await toFacilitatorCasperSigner(privateKey, {
    speculativeRpcUrlConfig: { "casper:casper-test": "http://localhost:7778/rpc" },
  });

  await expect(
    signer.simulateTransferWithAuthorization!({
      network: "casper:casper-test",
      asset: "a".repeat(64),
      deploy: buildDeploy(privateKey),
    }),
  ).rejects.toThrow("speculative execution failed: v2 reverted");
});
```

- [ ] **Step 2: Run signer tests to verify failure**

Run:

```bash
pnpm --filter @x402/casper test -- test/unit/signer.test.ts
```

Expected: FAIL because signer does not yet create `SpeculativeClient` or expose the hook.

- [ ] **Step 3: Implement speculative client caching**

In `typescript/packages/mechanisms/casper/src/signer.ts`, destructure `speculativeRpcUrlConfig`:

```ts
const { rpcUrlConfig, preflightHooks = {}, speculativeRpcUrlConfig } = options;
```

Add SDK destructuring:

```ts
const { HttpHandler, KeyAlgorithm, PrivateKey, RpcClient, SpeculativeClient } = casperSdk;
```

Add a cache:

```ts
const speculativeClients = new Map<string, InstanceType<typeof SpeculativeClient>>();
```

If `InstanceType` does not work cleanly for the SDK export, use:

```ts
const speculativeClients = new Map<
  string,
  ReturnType<typeof SpeculativeClient.newSpeculativeClient>
>();
```

Add helper:

```ts
const getSpeculativeClient = (
  network: Network,
): ReturnType<typeof SpeculativeClient.newSpeculativeClient> | undefined => {
  const speculativeRpcUrl = speculativeRpcUrlConfig?.[network];
  if (!speculativeRpcUrl) {
    return undefined;
  }
  const existing = speculativeClients.get(speculativeRpcUrl);
  if (existing) {
    return existing;
  }
  const client = SpeculativeClient.newSpeculativeClient(new HttpHandler(speculativeRpcUrl));
  speculativeClients.set(speculativeRpcUrl, client);
  return client;
};
```

- [ ] **Step 4: Implement simulation result handling**

Before returning the signer object, compute:

```ts
const simulateTransferWithAuthorization = speculativeRpcUrlConfig
  ? async ({ network, deploy }: CasperSpeculativeTransferParams): Promise<void> => {
      const speculativeClient = getSpeculativeClient(network);
      if (!speculativeClient) {
        throw new Error(`Casper speculative RPC is not configured for network: ${network}`);
      }

      const result = await speculativeClient.speculativeExec("1", deploy);
      const v1Failure = result.executionResultV1?.failure;
      if (v1Failure) {
        throw new Error(
          `speculative execution failed: ${v1Failure.errorMessage || JSON.stringify(v1Failure)}`,
        );
      }
      if (result.executionResultV1?.success) {
        return;
      }
      const v2ErrorMessage = result.executionResult?.errorMessage;
      if (v2ErrorMessage) {
        throw new Error(`speculative execution failed: ${v2ErrorMessage}`);
      }
      if (result.executionResult) {
        return;
      }

      throw new Error(`speculative execution returned an unrecognized response`);
    }
  : undefined;
```

Add the optional property to the returned object only when defined:

```ts
...(simulateTransferWithAuthorization ? { simulateTransferWithAuthorization } : {}),
```

- [ ] **Step 5: Run signer tests**

Run:

```bash
pnpm --filter @x402/casper test -- test/unit/signer.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add typescript/packages/mechanisms/casper/src/signer.ts typescript/packages/mechanisms/casper/test/unit/signer.test.ts
git commit -m "feat: add casper speculative execution signer hook"
```

### Task 3: Facilitator Verify Speculative Execution

**Files:**
- Modify: `typescript/packages/mechanisms/casper/src/exact/facilitator/scheme.ts`
- Test: `typescript/packages/mechanisms/casper/test/unit/facilitator.test.ts`

**Interfaces:**
- Consumes: `FacilitatorCasperSigner.simulateTransferWithAuthorization?`.
- Produces:
  - `ErrSpeculativeExecutionFailed`
  - Private helper `buildTransferWithAuthorizationTransaction(payload, requirements, mode = "transaction-v1")`
  - Private method `validateSpeculativeExecution(payload, requirements)`

- [ ] **Step 1: Write failing facilitator tests**

In `typescript/packages/mechanisms/casper/test/unit/facilitator.test.ts`, import `ErrSpeculativeExecutionFailed` from the facilitator scheme.

Add this test:

```ts
it("runs speculative execution when configured", async () => {
  const payload = await createValidPayload();
  const simulateTransferWithAuthorization = vi.fn(async () => {});
  const signer = createMockSigner({ simulateTransferWithAuthorization });
  const scheme = new ExactCasperScheme(signer);

  const result = await scheme.verify(buildPaymentPayload(payload), buildRequirements());

  expect(result).toMatchObject({ isValid: true, payer: payload.authorization.from });
  expect(simulateTransferWithAuthorization).toHaveBeenCalledTimes(1);
  const call = simulateTransferWithAuthorization.mock.calls[0]?.[0];
  expect(call).toMatchObject({ network: testNetwork, asset: testAsset });
  expect(call?.deploy).toBeDefined();
});
```

Add failure test:

```ts
it("rejects speculative execution failures", async () => {
  const payload = await createValidPayload();
  const scheme = new ExactCasperScheme(
    createMockSigner({
      simulateTransferWithAuthorization: vi.fn(async () => {
        throw new Error("simulation reverted");
      }),
    }),
  );

  await expect(
    scheme.verify(buildPaymentPayload(payload), buildRequirements()),
  ).resolves.toMatchObject({
    isValid: false,
    invalidReason: ErrSpeculativeExecutionFailed,
    invalidMessage: "simulation reverted",
    payer: payload.authorization.from,
  });
});
```

Add skip test:

```ts
it("skips speculative execution when no simulation hook is configured", async () => {
  const payload = await createValidPayload();
  const signer = createMockSigner();
  const scheme = new ExactCasperScheme(signer);

  await expect(scheme.verify(buildPaymentPayload(payload), buildRequirements())).resolves.toMatchObject({
    isValid: true,
  });

  expect("simulateTransferWithAuthorization" in signer).toBe(false);
});
```

- [ ] **Step 2: Run facilitator tests to verify failure**

Run:

```bash
pnpm --filter @x402/casper test -- test/unit/facilitator.test.ts
```

Expected: FAIL because the error constant and simulation call do not exist.

- [ ] **Step 3: Add error constant and transaction builder helper**

In `typescript/packages/mechanisms/casper/src/exact/facilitator/scheme.ts`, add:

```ts
export const ErrSpeculativeExecutionFailed =
  "invalid_exact_casper_facilitator_speculative_execution_failed";
```

Add private helper:

```ts
private async buildTransferWithAuthorizationTransaction(
  payload: ExactCasperPayload,
  requirements: PaymentRequirements,
  mode: "transaction-v1" | "deploy" = "transaction-v1",
): Promise<casperSdk.Transaction> {
  const facilitatorPublicKey = casperSdk.PublicKey.fromHex(
    this.signer.getPublicKeyHex(requirements.network),
  );
  const networkConfig = await this.signer.getNetworkConfig(requirements.network);
  const builder = new casperSdk.ContractCallBuilder()
    .from(facilitatorPublicKey)
    .byPackageHash(requirements.asset)
    .entryPoint("transfer_with_authorization")
    .runtimeArgs(buildTransferWithAuthorizationArgs(payload))
    .chainName(networkConfig.chainName)
    .payment(this.config.limitedPaymentMotes ?? DEFAULT_PAYMENT_MOTES);

  return mode === "deploy" ? builder.buildFor1_5() : builder.build();
}
```

- [ ] **Step 4: Use helper in settlement**

Replace the existing settlement builder chain with:

```ts
const transaction = await this.buildTransferWithAuthorizationTransaction(
  exactPayload,
  requirements,
);
```

Keep existing sign, submit, and wait behavior unchanged.

- [ ] **Step 5: Implement speculative validation**

Add private method:

```ts
private async validateSpeculativeExecution(
  payload: ExactCasperPayload,
  requirements: PaymentRequirements,
): Promise<VerifyResponse | undefined> {
  const simulateTransferWithAuthorization = this.signer.simulateTransferWithAuthorization;
  if (!simulateTransferWithAuthorization) {
    return undefined;
  }

  const payer = payload.authorization.from;
  try {
    const transaction = await this.buildTransferWithAuthorizationTransaction(
      payload,
      requirements,
      "deploy",
    );
    await this.signer.signTransaction(transaction, requirements.network);
    const deploy = transaction.getDeploy();
    if (!deploy) {
      return invalid(ErrSpeculativeExecutionFailed, payer, "buildFor1_5 did not produce a deploy");
    }
    await simulateTransferWithAuthorization({
      network: requirements.network,
      asset: requirements.asset,
      deploy,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return invalid(ErrSpeculativeExecutionFailed, payer, message);
  }

  return undefined;
}
```

Call it in `verify()` after `validatePreflight()`:

```ts
const simulationValidation = await this.validateSpeculativeExecution(exactPayload, requirements);
if (simulationValidation) {
  return simulationValidation;
}
```

- [ ] **Step 6: Run facilitator tests**

Run:

```bash
pnpm --filter @x402/casper test -- test/unit/facilitator.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add typescript/packages/mechanisms/casper/src/exact/facilitator/scheme.ts typescript/packages/mechanisms/casper/test/unit/facilitator.test.ts
git commit -m "feat: simulate casper transfer authorization in verify"
```

### Task 4: Migrate Call Sites And Documentation

**Files:**
- Modify: `typescript/packages/mechanisms/casper/README.md`
- Modify: `typescript/packages/mechanisms/casper/test/integrations/exact-casper.live.test.ts`
- Modify: `examples/typescript/facilitator/advanced/all_networks.ts`
- Modify: `e2e/facilitators/typescript/index.ts`

**Interfaces:**
- Consumes: `createFacilitatorCasperSigner(privateKey, algorithm, options)`.
- Produces: Repository call sites compiling against the new options object.

- [ ] **Step 1: Update repository call sites**

Replace calls of this shape:

```ts
await createFacilitatorCasperSigner(privateKey, algorithm, rpcUrlConfig, preflightHooks);
```

with:

```ts
await createFacilitatorCasperSigner(privateKey, algorithm, {
  rpcUrlConfig,
  preflightHooks,
});
```

For inline config, use:

```ts
casperSigner = await createFacilitatorCasperSigner(
  process.env.CASPER_PRIVATE_KEY,
  process.env.CASPER_PRIVATE_KEY_ALGORITHM === "secp256k1" ? 2 : 1,
  {
    rpcUrlConfig: CASPER_RPC_URL ? { [CASPER_NETWORK]: CASPER_RPC_URL } : undefined,
    preflightHooks: {
      getBalance: async () => 10n ** 30n,
      getAuthorizationState: async () => "unused",
      assertTransferWithAuthorizationSupported: async () => {},
    },
  },
);
```

- [ ] **Step 2: Update README facilitator example**

In `typescript/packages/mechanisms/casper/README.md`, update the facilitator example:

```ts
const signer = await createFacilitatorCasperSigner(
  process.env.CASPER_FACILITATOR_PRIVATE_KEY!,
  undefined,
  {
    rpcUrlConfig: { "casper:casper-test": "https://node.testnet.casper.network/rpc" },
    speculativeRpcUrlConfig: process.env.CASPER_SPECULATIVE_RPC_URL
      ? { "casper:casper-test": process.env.CASPER_SPECULATIVE_RPC_URL }
      : undefined,
    preflightHooks: {
      getBalance: async params => {
        // Read CEP-18 balance for params.account.
        return 0n;
      },
      getAuthorizationState: async params => {
        // Read CEP-3009 authorization_state for params.payer and params.nonce.
        return "unused";
      },
      assertTransferWithAuthorizationSupported: async params => {
        // Fail if params.asset does not expose transfer_with_authorization.
      },
    },
  },
);
```

Add a short paragraph:

```md
`speculativeRpcUrlConfig` is optional. When it contains a URL for the payment network, facilitator `verify()` runs Casper speculative execution against that endpoint as a final check. The speculative endpoint is network-specific and is often exposed separately from standard node JSON-RPC, commonly on port `7778`.
```

- [ ] **Step 3: Run type/build check**

Run:

```bash
pnpm --filter @x402/casper build
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add typescript/packages/mechanisms/casper/README.md typescript/packages/mechanisms/casper/test/integrations/exact-casper.live.test.ts examples/typescript/facilitator/advanced/all_networks.ts e2e/facilitators/typescript/index.ts
git commit -m "docs: document casper speculative execution config"
```

### Task 5: Final Verification

**Files:**
- Verify only.

**Interfaces:**
- Consumes: All previous tasks.
- Produces: Verified feature branch ready for review.

- [ ] **Step 1: Run Casper package tests**

Run:

```bash
pnpm --filter @x402/casper test
```

Expected: PASS.

- [ ] **Step 2: Run Casper package build**

Run:

```bash
pnpm --filter @x402/casper build
```

Expected: PASS.

- [ ] **Step 3: Run formatting/linting for Casper package**

Run:

```bash
pnpm --filter @x402/casper lint:check
pnpm --filter @x402/casper format:check
```

Expected: PASS. If formatting fails, run `pnpm --filter @x402/casper format`, inspect the diff, and rerun checks.

- [ ] **Step 4: Inspect final diff**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only intended files changed.

- [ ] **Step 5: Commit verification fixes if needed**

If Task 5 required formatting or small fixes:

```bash
git add typescript/packages/mechanisms/casper/src/types.ts typescript/packages/mechanisms/casper/src/signer.ts typescript/packages/mechanisms/casper/src/exact/facilitator/scheme.ts typescript/packages/mechanisms/casper/test/unit/signer.test.ts typescript/packages/mechanisms/casper/test/unit/facilitator.test.ts typescript/packages/mechanisms/casper/test/integrations/exact-casper.live.test.ts typescript/packages/mechanisms/casper/README.md examples/typescript/facilitator/advanced/all_networks.ts e2e/facilitators/typescript/index.ts
git commit -m "chore: finalize casper speculative execution"
```

If no changes were needed, do not create an empty commit.
