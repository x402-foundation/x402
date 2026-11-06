import {
  Networks,
  StrKey,
  buildAuthorizationEntryPreimage,
  hash,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTRACT,
  LEDGER,
  NETWORK,
  TOKEN,
  authority,
  payer,
  recipient,
  requirements,
} from "./upto-helpers";
import { createEd25519Signer, type ClientStellarSigner } from "../../src/signer";
import { termsFromScVal } from "../../src/upto";
import { UptoStellarScheme as UptoClient } from "../../src/upto/client";
import { UptoStellarScheme as UptoServer } from "../../src/upto/server";
import * as utils from "../../src/utils";
import type { PaymentRequirements } from "@x402/core/types";

vi.mock("../../src/utils", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/utils")>()),
  getRpcClient: vi.fn(),
  getEstimatedLedgerCloseTimeSeconds: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(utils.getRpcClient).mockReturnValue({
    getLatestLedger: () => Promise.resolve({ sequence: LEDGER }),
  } as unknown as rpc.Server);
  vi.mocked(utils.getEstimatedLedgerCloseTimeSeconds).mockResolvedValue(5);
});

const signer = createEd25519Signer(payer.secret(), NETWORK);
const contracts = { [NETWORK]: CONTRACT };
const client = (
  options: ConstructorParameters<typeof UptoClient>[1] = {},
  key: ClientStellarSigner = signer,
) => new UptoClient(key, { contracts, ...options });
const entryOf = (payload: Record<string, unknown>) =>
  xdr.SorobanAuthorizationEntry.fromXDR(payload["authorization"] as string, "base64");

describe("upto client", () => {
  it("signs the terms of the requirements, expiring after maxTimeoutSeconds", async () => {
    const result = await client().createPaymentPayload(2, requirements({ maxTimeoutSeconds: 61 }));
    expect(Object.keys(result.payload)).toEqual(["authorization"]);
    const entry = entryOf(result.payload);
    const credentials = entry.credentials().address();
    expect(credentials.signatureExpirationLedger()).toBe(LEDGER + 13);
    const call = entry.rootInvocation().function().contractFn();
    expect(call.functionName().toString()).toBe("settle");
    expect(termsFromScVal(call.args()[0] as xdr.ScVal)).toEqual({
      expirationLedger: LEDGER + 13,
      facilitator: authority.publicKey(),
      maxAmount: 1_000_000n,
      recipient: recipient.publicKey(),
      token: TOKEN,
      validAfterLedger: 0,
    });
    expect(entry.rootInvocation().subInvocations()).toHaveLength(1);
    const signature = credentials.signature().vec()?.[0]?.map();
    const bytes = signature
      ?.find(f => f.key().sym().toString() === "signature")
      ?.val()
      .bytes();
    const preimage = buildAuthorizationEntryPreimage(entry, LEDGER + 13, Networks.TESTNET);
    expect(bytes && payer.verify(hash(preimage.toXDR()), bytes)).toBe(true);
  });

  it("draws a fresh nonce for every payment", async () => {
    const nonces = new Set<bigint>();
    for (let i = 0; i < 5; i++) {
      const { payload } = await client().createPaymentPayload(2, requirements());
      nonces.add(entryOf(payload).credentials().address().nonce().toBigInt());
    }
    expect(nonces.size).toBe(5);
  });

  it("uses an injected signer for a contract-account payer, with delegated signer entries", async () => {
    const account = StrKey.encodeContract(hash(Buffer.from("client smart account")));
    const delegated = entryOf((await client().createPaymentPayload(2, requirements())).payload);
    const smart = { address: account, signAuthEntry: () => Promise.reject(new Error("unused")) };
    const scheme = client(
      {
        authorizeEntry: (entry, context) => {
          expect(context).toEqual({
            networkPassphrase: Networks.TESTNET,
            expirationLedger: LEDGER + 12,
          });
          entry
            .credentials()
            .address()
            .signature(xdr.ScVal.scvBytes(Buffer.alloc(64, 9)));
          return Promise.resolve({ authorization: entry, signerAuthorizations: [delegated] });
        },
      },
      smart,
    );
    const { payload } = await scheme.createPaymentPayload(2, requirements());
    expect(payload["signerAuthorizations"]).toEqual([delegated.toXDR("base64")]);
    await expect(client({}, smart).createPaymentPayload(2, requirements())).rejects.toThrow(
      /authorizeEntry/,
    );
    const tooMany = client(
      {
        authorizeEntry: entry =>
          Promise.resolve({ authorization: entry, signerAuthorizations: Array(5).fill(delegated) }),
      },
      smart,
    );
    await expect(tooMany.createPaymentPayload(2, requirements())).rejects.toThrow(/at most 4/);
  });

  it("surfaces a wallet refusal", async () => {
    const refusing: ClientStellarSigner = {
      address: payer.publicKey(),
      signAuthEntry: () =>
        Promise.resolve({ signedAuthEntry: "", error: { message: "user rejected", code: -4 } }),
    };
    await expect(client({}, refusing).createPaymentPayload(2, requirements())).rejects.toThrow(
      /user rejected/,
    );
  });

  const muxed = StrKey.encodeMed25519PublicKey(
    Buffer.concat([recipient.rawPublicKey(), Buffer.alloc(8, 2)]),
  );
  const extra = (facilitatorAddress?: string, areFeesSponsored = true) => ({
    extra: { areFeesSponsored, facilitatorAddress },
  });
  it.each<[string, Partial<PaymentRequirements>]>([
    ["another scheme", { scheme: "exact" }],
    ["a non-Stellar network", { network: "eip155:8453" }],
    ["a network without a settlement contract", { network: "stellar:pubnet" }],
    ["a zero maximum", { amount: "0" }],
    ["a decimal maximum", { amount: "1.5" }],
    ["a G… asset", { asset: payer.publicKey() }],
    ["a muxed payTo", { payTo: muxed }],
    ["a zero timeout", { maxTimeoutSeconds: 0 }],
    ["a timeout above 300 seconds", { maxTimeoutSeconds: 301 }],
    ["unsponsored fees", extra(authority.publicKey(), false)],
    ["a missing facilitator address", extra()],
    ["a C… facilitator address", extra(CONTRACT)],
    ["the payer as facilitator", extra(payer.publicKey())],
    ["the payer as payTo", { payTo: payer.publicKey() }],
  ])("refuses %s", async (_name, overrides) => {
    await expect(client().createPaymentPayload(2, requirements(overrides))).rejects.toThrow();
  });

  it("applies its own timeout limit and the core spend limit", async () => {
    await expect(
      client({ maxTimeoutSeconds: 60 }).createPaymentPayload(
        2,
        requirements({ maxTimeoutSeconds: 61 }),
      ),
    ).rejects.toThrow(/from 1 to 60/);
    await expect(
      client().createPaymentPayload(2, requirements(), { maxAmountPerPayment: "999999" }),
    ).rejects.toThrow(/spend limit/);
    await expect(
      client().createPaymentPayload(2, requirements(), { maxAmountPerPayment: "1000000" }),
    ).resolves.toBeDefined();
  });
});

describe("upto server", () => {
  it("prices in USDC by default, tries money parsers first and keeps asset amounts", async () => {
    const server = new UptoServer();
    expect(await server.parsePrice("$0.01", NETWORK)).toEqual({
      amount: "100000",
      asset: TOKEN,
      extra: {},
    });
    expect(await server.parsePrice({ amount: "5", asset: CONTRACT }, NETWORK)).toEqual({
      amount: "5",
      asset: CONTRACT,
      extra: {},
    });
    await expect(server.parsePrice({ amount: "5", asset: "" }, NETWORK)).rejects.toThrow();
    server.registerMoneyParser(amount =>
      Promise.resolve({ amount: `${amount}000000`, asset: CONTRACT }),
    );
    expect(await server.parsePrice("2", NETWORK)).toEqual({ amount: "2000000", asset: CONTRACT });
    expect(server.getAssetDecimals(TOKEN, NETWORK)).toBe(7);
  });

  it("copies areFeesSponsored and the settlement authority from the supported kind", async () => {
    const enhanced = await new UptoServer().enhancePaymentRequirements(
      { ...requirements(), extra: { note: "kept" } },
      {
        x402Version: 2,
        scheme: "upto",
        network: NETWORK,
        extra: { areFeesSponsored: true, facilitatorAddress: authority.publicKey(), other: 1 },
      },
      [],
    );
    expect(enhanced.extra).toEqual({
      note: "kept",
      areFeesSponsored: true,
      facilitatorAddress: authority.publicKey(),
    });
  });
});
