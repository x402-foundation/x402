/**
 * Merchant setup: ensureTransferPreapproval against stubbed Scan and
 * participant endpoints. It leaves a preapproval that is far from expiry alone,
 * renews a self-provided one that is about to expire, creates one when there is
 * none, and refuses what it cannot do.
 */
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { ensureTransferPreapproval } from "../../src/preapproval.js";

const FIX = fileURLToPath(new URL("../../src/__fixtures__/", import.meta.url));
// Any real prepared transaction will do as the participant's prepare answer.
const PREPARED = readFileSync(FIX + "mainnet-transfer-preapproval-0.1.21.b64", "utf8").trim();

const MERCHANT = "merchant::1220" + "aa".repeat(32);
const DSO = "DSO::1220" + "bb".repeat(32);
const PKG = "0f".repeat(32);
const SYNC = "global-domain::1220" + "cc".repeat(32);
const DAY = 24 * 60 * 60 * 1000;
const PRIVATE_KEY = generateKeyPairSync("ed25519")
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

const contract = (id: string, template: string, payload: unknown) => ({
  contract_id: id,
  template_id: `${PKG}:${template}`,
  created_event_blob: `blob-${id}`,
  payload,
});
const round = (id: string, number: string, opensAt: string) => ({
  contract: contract(id, "Splice.Round:OpenMiningRound", { round: { number }, opensAt }),
});

interface Stub {
  preapproval?: { provider: string; expiresAt: string } | null;
  holdings?: Array<{ cid: string; amount: string }>;
  flavor?: "sv" | "validator";
}

/**
 * A fetch that answers the Scan and participant calls the helper makes, and
 * records the prepare request.
 *
 * @param stub - What the ledger holds.
 * @returns The fetch and the recorded prepare bodies and executes.
 */
function ledger(stub: Stub) {
  const prepares: Array<Record<string, unknown>> = [];
  const executes: Array<Record<string, unknown>> = [];
  const later = new Date(Date.now() + 60_000).toISOString();
  const earlier = new Date(Date.now() - 60_000).toISOString();
  const rules = {
    contract: contract("rules", "Splice.AmuletRules:AmuletRules", { dso: DSO }),
    domain_id: SYNC,
  };
  const fetchStub = (async (url: string, init?: RequestInit) => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.includes("/transfer-preapprovals/by-party/")) {
      const p = stub.preapproval;
      return json({
        transfer_preapproval: p
          ? {
              contract: {
                contract_id: "pre-1",
                payload: {
                  dso: DSO,
                  receiver: MERCHANT,
                  provider: p.provider,
                  expiresAt: p.expiresAt,
                },
              },
            }
          : null,
      });
    }
    if (url.endsWith("/amulet-rules")) {
      return json(
        stub.flavor === "validator" ? { amulet_rules: rules } : { amulet_rules_update: rules },
      );
    }
    if (url.endsWith("/open-and-issuing-mining-rounds")) {
      const open = [
        round("r10", "10", earlier),
        round("r11", "11", earlier),
        round("r12", "12", later),
      ];
      const issuing = [round("i9", "9", earlier), round("i13", "13", later)];
      return json(
        stub.flavor === "validator"
          ? { open_mining_rounds: open, issuing_mining_rounds: issuing }
          : {
              open_mining_rounds: Object.fromEntries(open.map(r => [r.contract.contract_id, r])),
              issuing_mining_rounds: Object.fromEntries(
                issuing.map(r => [r.contract.contract_id, r]),
              ),
            },
      );
    }
    if (url.endsWith("/v2/state/ledger-end")) return json({ offset: 3 });
    if (url.endsWith("/v2/state/active-contracts")) {
      return json(
        (stub.holdings ?? [{ cid: "h1", amount: "100.0" }]).map(h => ({
          contractEntry: {
            JsActiveContract: {
              createdEvent: {
                contractId: h.cid,
                templateId: `${PKG}:Splice.Amulet:Amulet`,
                interfaceViews: [
                  {
                    interfaceId: `${PKG}:Splice.Api.Token.HoldingV1:Holding`,
                    viewValue: {
                      owner: MERCHANT,
                      instrumentId: { admin: DSO, id: "Amulet" },
                      amount: h.amount,
                    },
                  },
                ],
              },
            },
          },
        })),
      );
    }
    if (url.endsWith("/v2/interactive-submission/prepare")) {
      prepares.push(JSON.parse(String(init?.body)));
      return json({ preparedTransaction: PREPARED, preparedTransactionHash: "x" });
    }
    if (url.endsWith("/v2/interactive-submission/execute")) {
      executes.push(JSON.parse(String(init?.body)));
      return json({ updateId: "1220-preapproval" });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const config = {
    participantUrl: "http://participant.invalid",
    token: "t",
    userId: "u",
    synchronizerId: SYNC,
    scanUrl: "http://scan.invalid",
    ...(stub.flavor ? { scanFlavor: stub.flavor } : {}),
    party: MERCHANT,
    privateKeyPem: PRIVATE_KEY,
    fetch: fetchStub,
  };
  return { config, prepares, executes };
}

const expiresAt = new Date(Date.now() + 365 * DAY);
const exercise = (body: Record<string, unknown>) =>
  (body.commands as Array<{ ExerciseCommand: Record<string, unknown> }>)[0]!.ExerciseCommand;

describe("ensureTransferPreapproval", () => {
  it("leaves a preapproval that is far from expiry alone", async () => {
    const { config, prepares } = ledger({
      preapproval: {
        provider: "someone::1220",
        expiresAt: new Date(Date.now() + 30 * DAY).toISOString(),
      },
    });
    const r = await ensureTransferPreapproval(config, { expiresAt });
    expect(r.action).toBe("unchanged");
    expect(prepares).toHaveLength(0);
  });

  it("creates one when the merchant has none, as provider and receiver", async () => {
    const { config, prepares, executes } = ledger({ preapproval: null });
    const r = await ensureTransferPreapproval(config, { expiresAt });
    expect(r).toEqual({
      action: "created",
      expiresAt: expiresAt.toISOString(),
      updateId: "1220-preapproval",
    });
    const cmd = exercise(prepares[0]!);
    expect(cmd.choice).toBe("AmuletRules_CreateTransferPreapproval");
    expect(cmd.contractId).toBe("rules");
    expect(cmd.choiceArgument).toMatchObject({
      receiver: MERCHANT,
      provider: MERCHANT,
      expectedDso: DSO,
      expiresAt: expiresAt.toISOString(),
      inputs: [{ tag: "InputAmulet", value: "h1" }],
      context: {
        amuletRules: "rules",
        // The latest round that is already open; rounds opening later are left out.
        context: { openMiningRound: "r11", issuingMiningRounds: [[{ number: "9" }, "i9"]] },
      },
    });
    expect(prepares[0]!.actAs).toEqual([MERCHANT]);
    const signed = executes[0]!.partySignatures as { signatures: Array<{ party: string }> };
    expect(signed.signatures[0]!.party).toBe(MERCHANT);
  });

  it("renews a self-provided preapproval that is about to expire", async () => {
    const { config, prepares } = ledger({
      preapproval: { provider: MERCHANT, expiresAt: new Date(Date.now() + DAY).toISOString() },
    });
    const r = await ensureTransferPreapproval(config, { expiresAt });
    expect(r.action).toBe("renewed");
    const cmd = exercise(prepares[0]!);
    expect(cmd.choice).toBe("TransferPreapproval_Renew");
    expect(cmd.contractId).toBe("pre-1");
    expect(cmd.choiceArgument).toMatchObject({ newExpiresAt: expiresAt.toISOString() });
  });

  it("replaces an expired preapproval with a new one", async () => {
    const { config, prepares } = ledger({
      preapproval: {
        provider: "someone::1220",
        expiresAt: new Date(Date.now() - DAY).toISOString(),
      },
    });
    expect((await ensureTransferPreapproval(config, { expiresAt })).action).toBe("created");
    expect(exercise(prepares[0]!).choice).toBe("AmuletRules_CreateTransferPreapproval");
  });

  it("refuses to renew a preapproval another provider holds", async () => {
    const { config } = ledger({
      preapproval: {
        provider: "someone::1220",
        expiresAt: new Date(Date.now() + DAY).toISOString(),
      },
    });
    await expect(ensureTransferPreapproval(config, { expiresAt })).rejects.toThrow(
      /only that provider/,
    );
  });

  it("refuses when the merchant holds no Canton Coin for the fee", async () => {
    const { config } = ledger({ preapproval: null, holdings: [] });
    await expect(ensureTransferPreapproval(config, { expiresAt })).rejects.toThrow(
      /no Canton Coin/,
    );
  });

  it("reads rules and rounds through a validator scan-proxy too", async () => {
    const { config, prepares } = ledger({ preapproval: null, flavor: "validator" });
    expect((await ensureTransferPreapproval(config, { expiresAt })).action).toBe("created");
    expect(exercise(prepares[0]!).choiceArgument).toMatchObject({
      context: { context: { openMiningRound: "r11" } },
    });
  });
});
