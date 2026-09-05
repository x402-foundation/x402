import { describe, expect, it, vi } from "vitest";
import { preprod, PrivateKey } from "@evolution-sdk/evolution";
import {
  blockfrostQueries,
  toClientCardanoSigner,
  toFacilitatorCardanoSigner,
  withCardanoProviderTimeout,
} from "../../src/signer";
import {
  CARDANO_MAINNET_CAIP2,
  CARDANO_PREPROD_CAIP2,
  CARDANO_PREPROD_CIP34,
  LOVELACE_ASSET,
} from "../../src/constants";
import { MASUMI_DEFAULT_DEPLOYMENT } from "../../src/exact/masumi/blueprint";
import { MASUMI_MAX_DEADLINE_HORIZON_MS } from "../../src/exact/masumi/constants";
import { verifyMasumiAuthorization } from "../../src/exact/masumi/verify";
import type { CardanoExtraMasumi } from "../../src/types";
import { issueMasumiRequirements } from "../helpers/masumi";

const makeSigner = (): ReturnType<typeof toFacilitatorCardanoSigner> =>
  toFacilitatorCardanoSigner({
    mnemonic: PrivateKey.generateMnemonic(),
    network: CARDANO_PREPROD_CAIP2,
    // Never contacted by getCurrentSlot / network-guard paths.
    provider: { blockfrost: { baseUrl: "http://offline.invalid" } },
  });

describe("toFacilitatorCardanoSigner", () => {
  it("exposes and network-guards an injected complete phase-1 validator", async () => {
    const calls: Array<{ transaction: string; network: string }> = [];
    const signer = toFacilitatorCardanoSigner({
      network: CARDANO_PREPROD_CAIP2,
      provider: { blockfrost: { baseUrl: "http://offline.invalid" } },
      validatePhase1Transaction: async (transaction, network) => {
        calls.push({ transaction, network });
      },
    });

    await signer.validatePhase1Transaction!("AAAA", CARDANO_PREPROD_CIP34);
    expect(calls).toEqual([{ transaction: "AAAA", network: CARDANO_PREPROD_CIP34 }]);
    await expect(signer.validatePhase1Transaction!("AAAA", CARDANO_MAINNET_CAIP2)).rejects.toThrow(
      /configured for cardano:preprod/,
    );
  });

  it("derives the current slot from the chain slot config (no network)", async () => {
    const signer = makeSigner();
    const slot = await signer.getCurrentSlot(CARDANO_PREPROD_CAIP2);

    const sc = preprod.slotConfig;
    const expected =
      sc.zeroSlot + BigInt(Math.floor((Date.now() - Number(sc.zeroTime)) / sc.slotLength));

    // Allow a few slots of drift between the two Date.now() reads.
    const drift = slot - expected;
    expect(drift >= -2n && drift <= 2n).toBe(true);
    expect(slot).toBeGreaterThan(sc.zeroSlot);
  });

  it("treats a CIP-34 alias and its canonical id as the same configured network", async () => {
    // Configured with the CIP-34 form, queried with the canonical form: the
    // normalize layer must accept it (slot is derived from the chain config,
    // so no network call is made).
    const aliasConfigured = toFacilitatorCardanoSigner({
      network: CARDANO_PREPROD_CIP34,
      provider: { blockfrost: { baseUrl: "http://offline.invalid" } },
    });
    await expect(aliasConfigured.getCurrentSlot(CARDANO_PREPROD_CAIP2)).resolves.toBeGreaterThan(
      0n,
    );

    // The reverse direction: configured canonical, queried with the alias.
    await expect(makeSigner().getCurrentSlot(CARDANO_PREPROD_CIP34)).resolves.toBeGreaterThan(0n);
  });

  it("rejects chain queries for a network it was not configured for", async () => {
    const signer = makeSigner();
    await expect(signer.getCurrentSlot(CARDANO_MAINNET_CAIP2)).rejects.toThrow(
      /configured for cardano:preprod/,
    );
    await expect(signer.getUtxo(`${"a".repeat(64)}#0`, CARDANO_MAINNET_CAIP2)).rejects.toThrow(
      /configured for cardano:preprod/,
    );
  });

  it("exposes one address with a mnemonic and none when run provider-only", () => {
    const withWallet = makeSigner();
    expect(withWallet.getAddresses()).toHaveLength(1);
    expect(withWallet.getAddresses()[0]).toMatch(/^addr_test1/);

    // The facilitator only broadcasts the client's signed transaction, so the
    // mnemonic is optional; without it there is no address to expose.
    const providerOnly = toFacilitatorCardanoSigner({
      network: CARDANO_PREPROD_CAIP2,
      provider: { blockfrost: { baseUrl: "http://offline.invalid" } },
    });
    expect(providerOnly.getAddresses()).toEqual([]);
  });

  it("attaches a bounded timeout to direct Blockfrost evidence requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const signer = toFacilitatorCardanoSigner({
        network: CARDANO_PREPROD_CAIP2,
        provider: {
          blockfrost: { baseUrl: "https://cardano-preprod.blockfrost.io/api/v0" },
          requestTimeoutMs: 25,
        },
      });
      await expect(
        signer.getTransactionEvidence!("a".repeat(64), CARDANO_PREPROD_CAIP2),
      ).resolves.toEqual({ status: "unknown", confirmations: -2 });
      expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("propagates provider failures while resolving a spent UTxO", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const queries = blockfrostQueries({
        blockfrost: { baseUrl: "https://cardano-preprod.blockfrost.io/api/v0" },
      });
      await expect(queries.spentUtxoAddress("a".repeat(64), 0)).rejects.toThrow(
        /Blockfrost \/txs\/.+\/utxos failed: 503/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects invalid provider timeout configuration", () => {
    expect(() =>
      toFacilitatorCardanoSigner({
        network: CARDANO_PREPROD_CAIP2,
        provider: {
          blockfrost: { baseUrl: "http://offline.invalid" },
          requestTimeoutMs: 0,
        },
      }),
    ).toThrow(/requestTimeoutMs/);
    expect(() =>
      toFacilitatorCardanoSigner({
        network: CARDANO_PREPROD_CAIP2,
        provider: { koios: { baseUrl: "http://offline.invalid" }, requestTimeoutMs: 0 },
      }),
    ).toThrow(/requestTimeoutMs/);
  });

  it("bounds provider promises by the configured deadline", async () => {
    vi.useFakeTimers();
    try {
      const pending = withCardanoProviderTimeout(
        new Promise<never>(() => undefined),
        25,
        "testOperation",
      );
      const rejection = expect(pending).rejects.toThrow(/testOperation timed out after 25ms/);
      await vi.advanceTimersByTimeAsync(25);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});

// The client is about to move real value, and in client-submission mode it
// broadcasts before any facilitator sees the payment. It therefore has to verify
// the seller authorization itself rather than trust the 402 — these all fail
// before any provider call, so no network is involved.
describe("client-side Masumi authorization", () => {
  const PAY_BY_TIME = BigInt(Date.now() + 5 * 60 * 1000);

  const clientSigner = (
    config: Partial<Parameters<typeof toClientCardanoSigner>[0]> = {},
  ): ReturnType<typeof toClientCardanoSigner> =>
    toClientCardanoSigner({
      mnemonic: PrivateKey.generateMnemonic(),
      network: CARDANO_PREPROD_CAIP2,
      provider: { blockfrost: { baseUrl: "http://offline.invalid" } },
      ...config,
    });

  /**
   * Builds the signer input for an issued Masumi 402.
   *
   * @param requirements - The issued requirements.
   * @param payTo - Optional override for the escrow address.
   * @returns The signer input.
   */
  const signInput = (
    requirements: Awaited<ReturnType<typeof issueMasumiRequirements>>["requirements"],
    payTo = requirements.payTo,
  ) => ({
    network: CARDANO_PREPROD_CAIP2,
    payTo,
    asset: requirements.asset,
    amount: requirements.amount,
    maxTimeoutSeconds: requirements.maxTimeoutSeconds,
    extra: requirements.extra,
    submissionMode: "server" as const,
  });

  it("refuses a 402 that redirects payTo away from the derived escrow", async () => {
    const { requirements } = await issueMasumiRequirements({
      network: CARDANO_PREPROD_CAIP2,
      asset: LOVELACE_ASSET,
      amount: "50000000",
      payByTimeMs: PAY_BY_TIME,
    });
    const attackerAddress =
      "addr_test1qzdjjcstngx8yneqv4d2phmz35ytkyxk4aa09rfexu7kj3evleltf708u3qyrn29sudutxqqy0vx5f3lv73dtewsdras79zz7d";
    await expect(
      clientSigner().buildAndSignPaymentTransaction(signInput(requirements, attackerAddress)),
    ).rejects.toThrow(/seller authorization failed/);
  });

  it("refuses a 402 whose seller signature does not cover the terms", async () => {
    const { requirements } = await issueMasumiRequirements({
      network: CARDANO_PREPROD_CAIP2,
      asset: LOVELACE_ASSET,
      amount: "50000000",
      payByTimeMs: PAY_BY_TIME,
    });
    // Raise the price after the seller signed it.
    const tampered = { ...requirements, amount: "60000000" };
    await expect(
      clientSigner().buildAndSignPaymentTransaction(signInput(tampered)),
    ).rejects.toThrow(/masumi_seller_signature/);
  });

  it("refuses a non-canonical deployment unless the application approves it", async () => {
    const custom = { ...MASUMI_DEFAULT_DEPLOYMENT, cooldownPeriod: "999999" };
    const { requirements } = await issueMasumiRequirements({
      network: CARDANO_PREPROD_CAIP2,
      asset: LOVELACE_ASSET,
      amount: "50000000",
      payByTimeMs: PAY_BY_TIME,
      deployment: custom,
    });
    await expect(
      clientSigner().buildAndSignPaymentTransaction(signInput(requirements)),
    ).rejects.toThrow(/custom deployment requires explicit application approval/);
    let inspectedDeployment: unknown;
    await expect(
      clientSigner({
        validateCustomMasumiDeployment: claim => {
          inspectedDeployment = claim;
          return claim.deployment.cooldownPeriod === custom.cooldownPeriod;
        },
      }).buildAndSignPaymentTransaction(signInput(requirements)),
    ).rejects.toThrow(/Blockfrost/);
    expect(inspectedDeployment).toMatchObject({
      network: CARDANO_PREPROD_CAIP2,
      payTo: requirements.payTo,
      deployment: custom,
    });

    await expect(
      clientSigner({ validateCustomMasumiDeployment: () => false }).buildAndSignPaymentTransaction(
        signInput(requirements),
      ),
    ).rejects.toThrow(/custom deployment was not approved/);
  });

  it("refuses a registry claim it cannot independently validate", async () => {
    const { requirements } = await issueMasumiRequirements({
      network: CARDANO_PREPROD_CAIP2,
      asset: LOVELACE_ASSET,
      amount: "50000000",
      payByTimeMs: PAY_BY_TIME,
      agentIdentifier: `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b${"01".repeat(8)}`,
    });
    await expect(
      clientSigner().buildAndSignPaymentTransaction(signInput(requirements)),
    ).rejects.toThrow(/masumi_agent_identifier/);
  });

  it("refuses invalid signed deadlines before wallet or provider access", async () => {
    const { requirements } = await issueMasumiRequirements({
      network: CARDANO_PREPROD_CAIP2,
      asset: LOVELACE_ASSET,
      amount: "50000000",
      payByTimeMs: PAY_BY_TIME,
      submitResultTimeMs: PAY_BY_TIME + 1n,
    });
    await expect(
      clientSigner().buildAndSignPaymentTransaction(signInput(requirements)),
    ).rejects.toThrow(/deadline intervals below the minimum/);
  });

  // The buyer cannot recover the payment or the collateral before
  // `submit_result_time`, so a 402 naming a deadline a year out would freeze the
  // wallet's funds for a year while satisfying every minimum-gap rule.
  it("refuses deadlines beyond the accepted horizon before provider access", async () => {
    const payByTime = BigInt(Date.now() + 5 * 60 * 1000);
    const { requirements } = await issueMasumiRequirements({
      network: CARDANO_PREPROD_CAIP2,
      asset: LOVELACE_ASSET,
      amount: "50000000",
      payByTimeMs: payByTime,
      externalDisputeUnlockTimeMs: payByTime + BigInt(400 * 24 * 60 * 60 * 1000),
    });
    await expect(
      clientSigner().buildAndSignPaymentTransaction(signInput(requirements)),
    ).rejects.toThrow(/deadlines extend beyond the accepted horizon/);

    // An operator that genuinely accepts a long settlement window can raise it.
    await expect(
      clientSigner({
        masumiMaxDeadlineHorizonMs: BigInt(500 * 24 * 60 * 60 * 1000),
      }).buildAndSignPaymentTransaction(signInput(requirements)),
    ).rejects.toThrow(/Blockfrost/);

    // The horizon is buyer policy, so a verifier does not impose one. If it did,
    // it could reject exactly the lock a client with a raised horizon already
    // made — stranding the funds the check exists to protect.
    const extra = requirements.extra as unknown as CardanoExtraMasumi;
    await expect(verifyMasumiAuthorization(extra, requirements)).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      verifyMasumiAuthorization(extra, requirements, {
        maxDeadlineHorizonMs: MASUMI_MAX_DEADLINE_HORIZON_MS,
      }),
    ).resolves.toMatchObject({ ok: false, detail: "deadlines extend beyond the accepted horizon" });
  });

  it("refuses a payByTime outside the x402 timeout before provider access", async () => {
    const { requirements } = await issueMasumiRequirements({
      network: CARDANO_PREPROD_CAIP2,
      asset: LOVELACE_ASSET,
      amount: "50000000",
      maxTimeoutSeconds: 60,
      payByTimeMs: BigInt(Date.now() + 5 * 60 * 1000),
    });
    await expect(
      clientSigner().buildAndSignPaymentTransaction(signInput(requirements)),
    ).rejects.toThrow(/payByTime exceeds maxTimeoutSeconds/);
  });

  it("refuses a script-credential buyer return address before wallet access", async () => {
    const { requirements } = await issueMasumiRequirements({
      network: CARDANO_PREPROD_CAIP2,
      asset: LOVELACE_ASSET,
      amount: "50000000",
      payByTimeMs: PAY_BY_TIME,
    });
    await expect(
      clientSigner({
        masumiBuyerInput: () => ({ buyerReturnAddress: requirements.payTo }),
      }).buildAndSignPaymentTransaction(signInput(requirements)),
    ).rejects.toThrow(/buyer return address must be a key-credential address/);
  });

  it("awaits registry validation with the protected resource", async () => {
    const { requirements } = await issueMasumiRequirements({
      network: CARDANO_PREPROD_CAIP2,
      asset: LOVELACE_ASSET,
      amount: "50000000",
      payByTimeMs: PAY_BY_TIME,
      agentIdentifier: `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b${"01".repeat(8)}`,
    });
    const resource = { url: "https://agent.example.com/weather" };
    await expect(
      clientSigner({
        validateMasumiRegistryClaim: async () => true,
      }).buildAndSignPaymentTransaction(signInput(requirements)),
    ).rejects.toThrow(/protected resource/);
    await expect(
      clientSigner({
        validateMasumiRegistryClaim: async claim => claim.resource.url === resource.url,
      }).buildAndSignPaymentTransaction({ ...signInput(requirements), resource }),
    ).rejects.toThrow(/Blockfrost/);
  });

  // The issuer MAY omit `content` for a part derived from the buyer's own
  // request bytes — the buyer recomputes that digest from what it actually sent.
  // A client that skips the check instead lets a seller invent the digest and
  // bind the escrow to a request that was never made.
  it("refuses a commitment part whose content it cannot verify", async () => {
    const body = { days: 3, units: "metric" };
    const { requirements } = await issueMasumiRequirements({
      network: CARDANO_PREPROD_CAIP2,
      asset: LOVELACE_ASSET,
      amount: "50000000",
      payByTimeMs: PAY_BY_TIME,
      parts: [{ name: "body", canonicalization: "jcs", content: body }],
    });
    // The issuer withholds the content it committed to.
    const extra = requirements.extra as unknown as { inputCommitment: { parts: unknown[] } };
    const withheld = {
      ...requirements,
      extra: {
        ...requirements.extra,
        inputCommitment: {
          ...(requirements.extra as unknown as { inputCommitment: object }).inputCommitment,
          parts: extra.inputCommitment.parts.map(p =>
            Object.fromEntries(
              Object.entries(p as Record<string, unknown>).filter(([k]) => k !== "content"),
            ),
          ),
        },
      },
    } as typeof requirements;

    await expect(
      clientSigner().buildAndSignPaymentTransaction(signInput(withheld)),
    ).rejects.toThrow(/carries no content to verify its digest against/);

    // Supplying the buyer's own request content makes it verifiable again.
    await expect(
      clientSigner({ masumiRequestContent: { body } }).buildAndSignPaymentTransaction(
        signInput(withheld),
      ),
    ).rejects.toThrow(/Blockfrost/); // got past authorization, failed at the offline provider
  });

  it("refuses buyer content that does not match the committed digest", async () => {
    const { requirements } = await issueMasumiRequirements({
      network: CARDANO_PREPROD_CAIP2,
      asset: LOVELACE_ASSET,
      amount: "50000000",
      payByTimeMs: PAY_BY_TIME,
      parts: [{ name: "body", canonicalization: "jcs", content: { days: 3, units: "metric" } }],
    });
    const extra = requirements.extra as unknown as { inputCommitment: { parts: unknown[] } };
    const withheld = {
      ...requirements,
      extra: {
        ...requirements.extra,
        inputCommitment: {
          ...(requirements.extra as unknown as { inputCommitment: object }).inputCommitment,
          parts: extra.inputCommitment.parts.map(p =>
            Object.fromEntries(
              Object.entries(p as Record<string, unknown>).filter(([k]) => k !== "content"),
            ),
          ),
        },
      },
    } as typeof requirements;

    // The buyer actually sent something else, so the digest must not recompute.
    await expect(
      clientSigner({
        masumiRequestContent: { body: { days: 4, units: "metric" } },
      }).buildAndSignPaymentTransaction(signInput(withheld)),
    ).rejects.toThrow(/masumi_commitment/);
  });

  it("refuses Hydra terms it cannot settle", async () => {
    const { requirements } = await issueMasumiRequirements({
      network: CARDANO_PREPROD_CAIP2,
      asset: LOVELACE_ASSET,
      amount: "50000000",
      payByTimeMs: PAY_BY_TIME,
      settlementPolicy: "hydra",
    });
    await expect(
      clientSigner().buildAndSignPaymentTransaction(signInput(requirements)),
    ).rejects.toThrow(/Hydra settlement/);
  });
});
