import { AuxiliaryData, Transaction, TransactionMetadatum } from "@evolution-sdk/evolution";
import { sha256 } from "@noble/hashes/sha2.js";
import { beforeAll, describe, expect, it } from "vitest";
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";

import { ExactCardanoScheme as ExactCardanoClient } from "../../src/exact/client/scheme";
import { ExactCardanoScheme as ExactCardanoFacilitator } from "../../src/exact/facilitator/scheme";
import { ExactCardanoScheme as ExactCardanoServer } from "../../src/exact/server/scheme";
import { jcs } from "../../src/exact/masumi/jcs";
import {
  CARDANO_REQUEST_COMMITMENT,
  HTTP_BINDING_DOMAIN,
  REQUEST_COMMITMENT_ERRORS,
  REQUEST_COMMITMENT_METADATA_LABEL,
  assertCommitmentEmbedded,
  buildHttpBinding,
  buildRequestCommitment,
  createRequestCommitmentServerExtension,
  declareRequestCommitmentExtension,
  encodeRequestCommitmentMetadatum,
  readRequestCommitment,
  requestCommitmentPayloadExtension,
  resolveClientRequestCommitment,
  validateSalt,
  validateBoundHeaders,
  validateTargetUri,
  type HttpRequestDescription,
} from "../../src/exact/requestCommitment";
import { LOVELACE_ASSET } from "../../src/constants";
import { buildSignedTx } from "../helpers/buildSignedTx";
import {
  buildRequirements,
  freshPreprodAddress,
  NETWORK,
  NONCE_REF,
  stubClientSigner,
  stubFacilitatorSigner,
  TTL_SLOT,
} from "../helpers/stubs";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/** The request used by the `http:1` test vector of scheme_exact_lnbtc.md. */
const SPEC_REQUEST: HttpRequestDescription = {
  method: "GET",
  url: "https://api.example.com/article/A",
  headers: {},
};

/** Fixed salt of the published vectors: bytes 0x00..0x1f. */
const SALT = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

/** Minimal HTTP adapter for the server extension. */
function adapter(request: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  parsedBody?: unknown;
}) {
  const headers = Object.fromEntries(
    Object.entries(request.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    getHeader: (name: string) => headers[name.toLowerCase()],
    getMethod: () => request.method,
    getUrl: () => request.url,
    getBody: () => request.parsedBody,
  };
}

/** Second vector: query string, body and a bound header. */
const SEARCH_BODY = new TextEncoder().encode('{"q":"cardano"}');
const SEARCH_REQUEST: HttpRequestDescription = {
  method: "POST",
  url: "https://api.example.com/search?q=cardano&lang=es",
  body: SEARCH_BODY,
  headers: { "content-type": "application/json" },
};

const transport = (request: Parameters<typeof adapter>[0]) => ({
  request: { adapter: adapter(request) },
});

/**
 * Re-wraps a signed transaction with different auxiliary data, keeping the
 * signed body untouched.
 *
 * @param transactionBase64 - The signed transaction.
 * @param auxiliaryData - Replacement auxiliary data (or null).
 * @returns The modified transaction.
 */
function withAuxiliaryData(
  transactionBase64: string,
  auxiliaryData: AuxiliaryData.AuxiliaryData | null,
): string {
  const tx = Transaction.fromCBORBytes(Buffer.from(transactionBase64, "base64"));
  const modified = new Transaction.Transaction({
    body: tx.body,
    witnessSet: tx.witnessSet,
    isValid: true,
    auxiliaryData,
  });
  return Buffer.from(Transaction.toCBORBytes(modified)).toString("base64");
}

/**
 * Auxiliary data carrying one metadata entry.
 *
 * @param label - Metadata label.
 * @param metadatum - Metadata value.
 * @returns The auxiliary data.
 */
function auxWith(label: bigint, metadatum: TransactionMetadatum.TransactionMetadatum) {
  return AuxiliaryData.conway({
    metadata: new Map([[label, metadatum]]),
  } as Parameters<typeof AuxiliaryData.conway>[0]);
}

let payTo: string;
beforeAll(async () => {
  payTo = await freshPreprodAddress();
});

/**
 * Builds a signed payment transaction, optionally carrying a commitment.
 *
 * @param hash - Commitment digest to embed, if any.
 * @returns The base64 transaction.
 */
async function signedTx(hash?: string): Promise<string> {
  const built = await buildSignedTx({
    payTo,
    asset: LOVELACE_ASSET,
    amount: 1_000_000n,
    nonceUtxoRef: NONCE_REF,
    ttlSlot: TTL_SLOT,
    network: NETWORK,
    ...(hash
      ? {
          metadata: {
            label: REQUEST_COMMITMENT_METADATA_LABEL,
            metadatum: encodeRequestCommitmentMetadatum("http:1", hash),
          },
        }
      : {}),
  });
  return built.transaction;
}

describe("http:1 binding", () => {
  it("uses the lnbtc http:1 rules: swapping in the lnbtc domain reproduces its spec vector", () => {
    const binding = buildHttpBinding(SPEC_REQUEST, []);
    expect(binding.domain).toBe(HTTP_BINDING_DOMAIN);
    const lnbtc = { ...binding, domain: "x402:exact:lnbtc:bolt11:http:1" };
    expect(jcs(lnbtc)).toBe(
      '{"bodyHash":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","domain":"x402:exact:lnbtc:bolt11:http:1","headers":[],"method":"GET","url":"https://api.example.com/article/A"}',
    );
    expect(hex(sha256(new TextEncoder().encode(jcs(lnbtc))))).toBe(
      "0d6623f775e025501fa7f0a30b54da25aad62b6ccfe35c85da38016711e6c018",
    );
  });

  it("distinguishes an absent header from an empty one", () => {
    const absent = buildHttpBinding({ ...SPEC_REQUEST, headers: {} }, ["accept"]);
    const empty = buildHttpBinding({ ...SPEC_REQUEST, headers: { accept: "" } }, ["accept"]);
    expect(absent.headers[0].valueHash).toBe(hex(sha256(Uint8Array.of(0))));
    expect(empty.headers[0].valueHash).toBe(hex(sha256(Uint8Array.of(1))));
  });

  it("hashes the body bytes as given", () => {
    const body = new TextEncoder().encode('{"a":1}');
    expect(buildHttpBinding({ ...SPEC_REQUEST, method: "POST", body }, []).bodyHash).toBe(
      hex(sha256(body)),
    );
  });

  it.each([["Accept"], ["b", "a"], ["a", "a"], ["payment-signature"]])(
    "rejects bound header list %j",
    (...headers: string[]) => {
      expect(() => validateBoundHeaders(headers)).toThrow();
    },
  );

  it.each([
    "/article/A",
    "ftp://api.example.com/a",
    "https://user@api.example.com/a",
    "https://api.example.com/a#frag",
    "https://api.example.com/ä",
  ])("rejects target URI %s", url => {
    expect(() => validateTargetUri(url)).toThrow();
  });

  it("changes the commitment when only the URL changes", () => {
    const a = buildRequestCommitment(buildHttpBinding(SPEC_REQUEST, []));
    const b = buildRequestCommitment(
      buildHttpBinding({ ...SPEC_REQUEST, url: "https://api.example.com/article/B" }, []),
    );
    expect(a.digest).not.toBe(b.digest);
  });
});

describe("test vector", () => {
  it("matches the published vector (GET https://api.example.com/article/A)", () => {
    const binding = buildHttpBinding(SPEC_REQUEST, []);
    const commitment = buildRequestCommitment(binding);
    expect(commitment.parts[0].digest).toBe(
      "22351cc0b694189e9feb7bab0fb3956fc1dcc0927b704406d2428e0fe821acd1",
    );
    expect(commitment.digest).toBe(
      "556fb70df9929f3ebd96b8b51b772374a9d38379b3983f820bf5e4629bd34e68",
    );
    const aux = AuxiliaryData.conway({
      metadata: new Map([
        [
          REQUEST_COMMITMENT_METADATA_LABEL,
          encodeRequestCommitmentMetadatum("http:1", commitment.digest),
        ],
      ]),
    } as Parameters<typeof AuxiliaryData.conway>[0]);
    expect(hex(AuxiliaryData.toCBORBytes(aux))).toBe(
      "d90103a100a1190192a2617066687474703a3161685820556fb70df9929f3ebd96b8b51b772374a9d38379b3983f820bf5e4629bd34e68",
    );
  });

  it("matches the published salted vector (the value signed on-chain)", () => {
    const salted = buildRequestCommitment(buildHttpBinding(SPEC_REQUEST, []), SALT);
    expect(salted.parts.map(p => p.name)).toEqual(["request", "salt"]);
    expect(salted.parts[0].digest).toBe(
      "22351cc0b694189e9feb7bab0fb3956fc1dcc0927b704406d2428e0fe821acd1",
    );
    expect(salted.parts[1].digest).toBe(
      "4602db566c605e475171dc6f7ae9cafdcaa264b971d95e7c98df10c2a3a47ffc",
    );
    expect(salted.digest).toBe("712cdce8a4e64fc7e2b2fb3b70ba41317ff606d84e98890c65d4fd828276a621");
    const aux = auxWith(
      REQUEST_COMMITMENT_METADATA_LABEL,
      encodeRequestCommitmentMetadatum("http:1", salted.digest),
    );
    const auxBytes = AuxiliaryData.toCBORBytes(aux);
    expect(hex(auxBytes)).toBe(
      "d90103a100a1190192a2617066687474703a3161685820712cdce8a4e64fc7e2b2fb3b70ba41317ff606d84e98890c65d4fd828276a621",
    );
  });

  it("a different salt gives a different on-chain digest for the same request", () => {
    const binding = buildHttpBinding(SPEC_REQUEST, []);
    expect(buildRequestCommitment(binding, SALT).digest).not.toBe(
      buildRequestCommitment(binding, "ff".repeat(32)).digest,
    );
  });

  it.each(["", "00", "AB".repeat(32), "0x" + "00".repeat(31), 42])("rejects salt %j", salt => {
    expect(() => validateSalt(salt)).toThrow();
  });
});

describe("second test vector", () => {
  it("matches the published vector (POST with query, body and a bound header)", () => {
    const binding = buildHttpBinding(SEARCH_REQUEST, ["content-type"]);
    expect(jcs(binding)).toBe(
      '{"bodyHash":"d1ea1113acf7d9176837ceb07bfa3b30c7bbd4907b1157c8c52818ed77b6a77c","domain":"x402:exact:cardano:request-commitment:http:1","headers":[{"name":"content-type","valueHash":"b2ec0efb460ab23169a6cfc6bd623cca0865f32297a1fd3585a974fc78d441a5"}],"method":"POST","url":"https://api.example.com/search?q=cardano&lang=es"}',
    );
    const commitment = buildRequestCommitment(binding);
    expect(commitment.parts[0].digest).toBe(
      "19f76af6c9d60eb3f599273ac707830fb5fd2703b870aa9165014048fd5375c3",
    );
    expect(commitment.digest).toBe(
      "f2a6d890837465ce790568b4872b576e5004fb304c3c7ed061be2fb5fa988b52",
    );
    expect(buildRequestCommitment(binding, SALT).digest).toBe(
      "d26cbb2a326a7c06dad25e8a21de168a5461e8c413fb6f2efe87980cfb2b778e",
    );
  });
});

describe("reading the commitment from a transaction", () => {
  const commitment = buildRequestCommitment(buildHttpBinding(SPEC_REQUEST, []));

  it("finds a commitment the body commits to", async () => {
    const found = readRequestCommitment(await signedTx(commitment.digest));
    expect(found).toEqual({
      status: "present",
      metadatum: { profile: "http:1", hash: commitment.digest },
    });
  });

  it("reports absence for a transaction without auxiliary data", async () => {
    expect(readRequestCommitment(await signedTx())).toEqual({ status: "absent" });
  });

  it("reports absence when auxiliary data has no label 402", async () => {
    const built = await buildSignedTx({
      payTo,
      asset: LOVELACE_ASSET,
      amount: 1_000_000n,
      nonceUtxoRef: NONCE_REF,
      ttlSlot: TTL_SLOT,
      network: NETWORK,
      metadata: { label: 674n, metadatum: "hello" },
    });
    expect(readRequestCommitment(built.transaction)).toEqual({ status: "absent" });
  });

  it("rejects metadata the body does not commit to (added after signing)", async () => {
    const forged = withAuxiliaryData(
      await signedTx(),
      auxWith(
        REQUEST_COMMITMENT_METADATA_LABEL,
        encodeRequestCommitmentMetadatum("http:1", commitment.digest),
      ),
    );
    expect(readRequestCommitment(forged).status).toBe("unsigned");
  });

  it("rejects metadata swapped for different metadata after signing", async () => {
    const other = buildRequestCommitment(
      buildHttpBinding({ ...SPEC_REQUEST, url: "https://api.example.com/article/B" }, []),
    );
    const swapped = withAuxiliaryData(
      await signedTx(commitment.digest),
      auxWith(
        REQUEST_COMMITMENT_METADATA_LABEL,
        encodeRequestCommitmentMetadatum("http:1", other.digest),
      ),
    );
    expect(readRequestCommitment(swapped).status).toBe("unsigned");
  });

  it("rejects unrelated metadata the body does not commit to, instead of ignoring it", async () => {
    const forged = withAuxiliaryData(await signedTx(), auxWith(674n, "not part of the extension"));
    expect(readRequestCommitment(forged).status).toBe("unsigned");
  });

  it("rejects a body that commits to auxiliary data the transaction dropped", async () => {
    const dropped = withAuxiliaryData(await signedTx(commitment.digest), null);
    expect(readRequestCommitment(dropped).status).toBe("unsigned");
  });

  it.each([
    [
      "extra key",
      TransactionMetadatum.map(
        new Map<
          TransactionMetadatum.TransactionMetadatum,
          TransactionMetadatum.TransactionMetadatum
        >([
          ["p", "http:1"],
          ["h", new Uint8Array(32)],
          ["x", "y"],
        ]),
      ),
    ],
    [
      "unknown profile",
      TransactionMetadatum.map(
        new Map<
          TransactionMetadatum.TransactionMetadatum,
          TransactionMetadatum.TransactionMetadatum
        >([
          ["p", "mcp:1"],
          ["h", new Uint8Array(32)],
        ]),
      ),
    ],
    [
      "short hash",
      TransactionMetadatum.map(
        new Map<
          TransactionMetadatum.TransactionMetadatum,
          TransactionMetadatum.TransactionMetadatum
        >([
          ["p", "http:1"],
          ["h", new Uint8Array(31)],
        ]),
      ),
    ],
    ["bare bytes", new Uint8Array(32)],
  ])("reports malformed label 402 (%s)", async (_name, metadatum) => {
    const built = await buildSignedTx({
      payTo,
      asset: LOVELACE_ASSET,
      amount: 1_000_000n,
      nonceUtxoRef: NONCE_REF,
      ttlSlot: TTL_SLOT,
      network: NETWORK,
      metadata: { label: REQUEST_COMMITMENT_METADATA_LABEL, metadatum },
    });
    expect(readRequestCommitment(built.transaction).status).toBe("malformed");
  });
});

describe("client resolution", () => {
  const declaredFor = (request: HttpRequestDescription, required: boolean) => ({
    [CARDANO_REQUEST_COMMITMENT]: {
      ...declareRequestCommitmentExtension({ required }),
      info: {
        ...declareRequestCommitmentExtension({ required }).info,
        commitment: buildRequestCommitment(buildHttpBinding(request, [])),
      },
    },
  });

  it("embeds nothing when the server declared nothing", async () => {
    expect(await resolveClientRequestCommitment({}, () => SPEC_REQUEST)).toBeUndefined();
  });

  it("returns the salted digest after recomputing it from the client's own request", async () => {
    const result = await resolveClientRequestCommitment(
      declaredFor(SPEC_REQUEST, true),
      () => SPEC_REQUEST,
      () => SALT,
    );
    expect(result).toEqual({
      profile: "http:1",
      hash: buildRequestCommitment(buildHttpBinding(SPEC_REQUEST, []), SALT).digest,
      salt: SALT,
    });
    expect(requestCommitmentPayloadExtension(result!)).toEqual({
      [CARDANO_REQUEST_COMMITMENT]: { info: { salt: SALT } },
    });
  });

  it("uses a fresh salt per payment, so two payments for one request are not linkable", async () => {
    const a = await resolveClientRequestCommitment(
      declaredFor(SPEC_REQUEST, true),
      () => SPEC_REQUEST,
    );
    const b = await resolveClientRequestCommitment(
      declaredFor(SPEC_REQUEST, true),
      () => SPEC_REQUEST,
    );
    expect(a!.salt).toMatch(/^[0-9a-f]{64}$/);
    expect(a!.salt).not.toBe(b!.salt);
    expect(a!.hash).not.toBe(b!.hash);
    expect(a!.hash).not.toBe(buildRequestCommitment(buildHttpBinding(SPEC_REQUEST, [])).digest);
  });

  it("refuses a salt source that returns a malformed salt", async () => {
    await expect(
      resolveClientRequestCommitment(
        declaredFor(SPEC_REQUEST, true),
        () => SPEC_REQUEST,
        () => "00",
      ),
    ).rejects.toThrow(/salt/);
  });

  it("refuses a commitment for a different request, even when not required", async () => {
    const other = { ...SPEC_REQUEST, url: "https://api.example.com/article/B" };
    await expect(
      resolveClientRequestCommitment(declaredFor(other, false), () => SPEC_REQUEST),
    ).rejects.toThrow(/Refusing to pay/);
  });

  it("refuses a declared digest that does not recompute", async () => {
    const declared = declaredFor(SPEC_REQUEST, false);
    (declared[CARDANO_REQUEST_COMMITMENT].info.commitment as { digest: string }).digest =
      "00".repeat(32);
    await expect(resolveClientRequestCommitment(declared, () => SPEC_REQUEST)).rejects.toThrow();
  });

  it("without a request provider: refuses when required, pays without when optional", async () => {
    await expect(
      resolveClientRequestCommitment(declaredFor(SPEC_REQUEST, true), undefined),
    ).rejects.toThrow(/requires/);
    expect(
      await resolveClientRequestCommitment(declaredFor(SPEC_REQUEST, false), undefined),
    ).toBeUndefined();
  });

  it("detects a signer that ignored the commitment", async () => {
    const digest = buildRequestCommitment(buildHttpBinding(SPEC_REQUEST, [])).digest;
    expect(() =>
      assertCommitmentEmbedded(signedTxSync.none, { profile: "http:1", hash: digest }),
    ).toThrow(/did not embed/);
  });
});

// Filled in beforeAll so the synchronous assertion above has a transaction.
const signedTxSync: { none: string } = { none: "" };
beforeAll(async () => {
  signedTxSync.none = await signedTx();
});

describe("server extension", () => {
  const ORIGIN = "https://api.example.com";
  const extension = createRequestCommitmentServerExtension({ publicOrigin: ORIGIN });
  const verify = extension.hooks!.onBeforeVerify!;
  const requirements = () => buildRequirements(payTo, "1000000");
  const declaration = (required: boolean) => declareRequestCommitmentExtension({ required });
  const ctx = (
    transaction: string,
    request = SPEC_REQUEST.url.replace(ORIGIN, ""),
    salt: unknown = SALT,
  ) => ({
    paymentPayload: {
      x402Version: 2,
      payload: { transaction, nonce: NONCE_REF },
      ...(salt === null
        ? {}
        : { extensions: { [CARDANO_REQUEST_COMMITMENT]: { info: { salt } } } }),
    },
    requirements: requirements(),
    declaredExtensions: {},
    transportContext: transport({ method: "GET", url: `http://evil.example${request}` }),
  });
  /** What the server publishes in the 402 (no salt). */
  const published = buildRequestCommitment(buildHttpBinding(SPEC_REQUEST, [])).digest;
  /** What the buyer signs on-chain (salted). */
  const digest = buildRequestCommitment(buildHttpBinding(SPEC_REQUEST, []), SALT).digest;

  it("publishes the commitment for the request, built from the public origin, not the Host", () => {
    const enriched = extension.enrichDeclaration!(
      declaration(true),
      transport({ method: "GET", url: "http://evil.example/article/A" }),
    ) as { info: { commitment: { digest: string } } };
    expect(enriched.info.commitment.digest).toBe(published);
  });

  it("rejects a commitment present on-chain without a disclosed salt", async () => {
    expect(
      await verify(declaration(false), ctx(await signedTx(digest), undefined, null) as never),
    ).toMatchObject({ abort: true, reason: REQUEST_COMMITMENT_ERRORS.malformed });
  });

  it("rejects a disclosed salt when the transaction carries no commitment", async () => {
    expect(await verify(declaration(false), ctx(await signedTx()) as never)).toMatchObject({
      abort: true,
      reason: REQUEST_COMMITMENT_ERRORS.malformed,
    });
  });

  it.each(["00", "AB".repeat(32), 7])("rejects a malformed salt %j", async salt => {
    expect(
      await verify(declaration(false), ctx(await signedTx(digest), undefined, salt) as never),
    ).toMatchObject({ abort: true, reason: REQUEST_COMMITMENT_ERRORS.malformed });
  });

  it("rejects a salt that does not lead to the signed commitment", async () => {
    expect(
      await verify(
        declaration(false),
        ctx(await signedTx(digest), undefined, "ff".repeat(32)) as never,
      ),
    ).toMatchObject({ abort: true, reason: REQUEST_COMMITMENT_ERRORS.mismatch });
  });

  it("rejects an unsalted commitment (the 402 value signed as is)", async () => {
    expect(await verify(declaration(false), ctx(await signedTx(published)) as never)).toMatchObject(
      { abort: true, reason: REQUEST_COMMITMENT_ERRORS.mismatch },
    );
  });

  it("accepts a transaction that commits to this request", async () => {
    expect(await verify(declaration(true), ctx(await signedTx(digest)) as never)).toBeUndefined();
  });

  it("rejects a commitment to a different request", async () => {
    const result = await verify(
      declaration(false),
      ctx(await signedTx(digest), "/article/B") as never,
    );
    expect(result).toMatchObject({ abort: true, reason: REQUEST_COMMITMENT_ERRORS.mismatch });
  });

  it("rejects a missing commitment only when required", async () => {
    const tx = await signedTx();
    expect(await verify(declaration(true), ctx(tx, undefined, null) as never)).toMatchObject({
      abort: true,
      reason: REQUEST_COMMITMENT_ERRORS.missing,
    });
    expect(await verify(declaration(false), ctx(tx, undefined, null) as never)).toBeUndefined();
  });

  it("rejects unsigned metadata even when the commitment is optional", async () => {
    const forged = withAuxiliaryData(
      await signedTx(),
      auxWith(
        REQUEST_COMMITMENT_METADATA_LABEL,
        encodeRequestCommitmentMetadatum("http:1", digest),
      ),
    );
    expect(await verify(declaration(false), ctx(forged) as never)).toMatchObject({
      abort: true,
      reason: REQUEST_COMMITMENT_ERRORS.unsigned,
    });
  });

  it("turns an internal error into a rejection instead of letting it through", async () => {
    const result = await verify(declaration(false), ctx("not-base64!") as never);
    expect(result).toMatchObject({ abort: true });
  });

  it("refuses a body it cannot hash faithfully", async () => {
    const result = await verify(declaration(false), {
      ...ctx(await signedTx(digest)),
      transportContext: {
        request: {
          adapter: adapter({
            method: "POST",
            url: "/article/A",
            headers: { "content-length": "7" },
          }),
        },
      },
    } as never);
    expect(result).toMatchObject({ abort: true });
  });

  it("refuses a POST without a raw body accessor even with no length headers (HTTP/2)", async () => {
    // The buyer committed to a POST with an empty body. Over HTTP/2 a body needs
    // neither Content-Length nor Transfer-Encoding, so without the accessor the
    // server cannot know the body is really empty and must refuse.
    const emptyPost = buildRequestCommitment(
      buildHttpBinding({ ...SPEC_REQUEST, method: "POST" }, []),
      SALT,
    ).digest;
    const result = await verify(declaration(false), {
      ...ctx(await signedTx(emptyPost)),
      transportContext: transport({ method: "POST", url: "/article/A" }),
    } as never);
    expect(result).toMatchObject({ abort: true });
  });

  it("does not let a Host header move the checked path (payment for A presented on B)", async () => {
    // Express and Fastify build getUrl() as scheme://Host + target. A Host with
    // `/`, `?` or `#` would otherwise make the server check /article/A while
    // serving /article/B.
    for (const [host, target] of [
      ["x/article/A#", "/article/B"],
      ["x/article/A?", "/article/B"],
      ["api.example.com/article/A", "/article/B"],
    ]) {
      const result = await verify(declaration(true), {
        ...ctx(await signedTx(digest)),
        transportContext: transport({
          method: "GET",
          url: `http://${host}${target}`,
          headers: { host },
        }),
      } as never);
      expect(result, `${host} ${target}`).toMatchObject({ abort: true });
    }
    const forwarded = await verify(declaration(true), {
      ...ctx(await signedTx(digest)),
      transportContext: transport({
        method: "GET",
        url: "http://x/article/A#/article/B",
        headers: { "x-forwarded-host": "x/article/A#" },
      }),
    } as never);
    expect(forwarded).toMatchObject({ abort: true });
    // A well-formed Host still verifies.
    expect(
      await verify(declaration(true), {
        ...ctx(await signedTx(digest)),
        transportContext: transport({
          method: "GET",
          url: "http://api.example.com:8080/article/A",
          headers: { host: "api.example.com:8080" },
        }),
      } as never),
    ).toBeUndefined();
  });

  it("does not let X-Forwarded-Proto, an absolute-form target or a foreign authority move the path", async () => {
    const tx = await signedTx(digest);
    for (const [headers, url] of [
      [
        { host: "api.example.com", "x-forwarded-proto": "https://x/y?u=https" },
        "https://x/y?u=https://api.example.com/article/A",
      ],
      [{ host: "api.example.com" }, "https://x/article/A"],
      [{ host: "host" }, "http://hosthttp://evil/article/A"],
      [{}, "http://x//article/A"],
      [{ host: "user@api.example.com" }, "http://user@api.example.com/article/A"],
    ] as Array<[Record<string, string>, string]>) {
      const result = await verify(declaration(true), {
        ...ctx(tx),
        transportContext: transport({ method: "GET", url, headers }),
      } as never);
      expect(result, url).toMatchObject({ abort: true });
    }
    for (const [headers, url] of [
      [{ host: "API.example.com:443" }, "https://api.example.com/article/A"],
      [{ host: "[::1]:3000" }, "http://[::1]:3000/article/A"],
      [
        {
          host: "internal:8080",
          "x-forwarded-host": "api.example.com",
          "x-forwarded-proto": "https",
        },
        "https://api.example.com/article/A",
      ],
    ] as Array<[Record<string, string>, string]>) {
      const result = await verify(declaration(true), {
        ...ctx(tx),
        transportContext: transport({ method: "GET", url, headers }),
      } as never);
      expect(result, url).toBeUndefined();
    }
  });

  it("rejects a crafted X-Forwarded-Proto or a `//` target even without a Host header", async () => {
    const victim = buildRequestCommitment(
      buildHttpBinding(
        {
          ...SPEC_REQUEST,
          url: "https://api.example.com/fetch?u=https://api.example.com/article/A",
        },
        [],
      ),
      SALT,
    ).digest;
    expect(
      await verify(declaration(true), {
        ...ctx(await signedTx(victim)),
        transportContext: transport({
          method: "GET",
          url: "https://x/fetch?u=https://api.example.com/article/A",
          headers: { "x-forwarded-proto": "https://x/fetch?u=https" },
        }),
      } as never),
    ).toMatchObject({ abort: true });
    const doubleSlash = buildRequestCommitment(
      buildHttpBinding({ ...SPEC_REQUEST, url: "https://api.example.com//article/A" }, []),
      SALT,
    ).digest;
    expect(
      await verify(declaration(true), {
        ...ctx(await signedTx(doubleSlash)),
        transportContext: transport({ method: "GET", url: "http://x//article/A" }),
      } as never),
    ).toMatchObject({ abort: true });
  });

  it("awaits an async parsed body: empty is accepted, non-empty is rejected", async () => {
    const tx = await signedTx(digest);
    const withBody = (parsedBody: unknown) => ({
      ...ctx(tx),
      transportContext: transport({ method: "GET", url: "/article/A", parsedBody }),
    });
    expect(
      await verify(declaration(true), withBody(Promise.resolve(undefined)) as never),
    ).toBeUndefined();
    expect(
      await verify(declaration(false), withBody(Promise.resolve({ q: "x" })) as never),
    ).toMatchObject({
      abort: true,
    });
  });

  it("refuses a GET whose framework parsed a body, without a raw body accessor", async () => {
    const result = await verify(declaration(false), {
      ...ctx(await signedTx(digest)),
      transportContext: transport({ method: "GET", url: "/article/A", parsedBody: { x: 1 } }),
    } as never);
    expect(result).toMatchObject({ abort: true });
  });

  it("binds the raw body when an accessor is configured", async () => {
    const withBody = createRequestCommitmentServerExtension({
      publicOrigin: ORIGIN,
      getRawBody: () => SEARCH_BODY,
    });
    const searchDigest = buildRequestCommitment(
      buildHttpBinding(SEARCH_REQUEST, ["content-type"]),
      SALT,
    ).digest;
    const decl = declareRequestCommitmentExtension({ required: true, headers: ["content-type"] });
    const request = {
      method: "POST",
      url: "/search?q=cardano&lang=es",
      headers: { "content-type": "application/json" },
    };
    const base = { ...ctx(await signedTx(searchDigest)), transportContext: transport(request) };
    expect(await withBody.hooks!.onBeforeVerify!(decl, base as never)).toBeUndefined();

    const otherBody = createRequestCommitmentServerExtension({
      publicOrigin: ORIGIN,
      getRawBody: () => new TextEncoder().encode('{"q":"ethereum"}'),
    });
    expect(await otherBody.hooks!.onBeforeVerify!(decl, base as never)).toMatchObject({
      abort: true,
      reason: REQUEST_COMMITMENT_ERRORS.mismatch,
    });

    const otherHeader = {
      ...base,
      transportContext: transport({ ...request, headers: { "content-type": "text/plain" } }),
    };
    expect(await withBody.hooks!.onBeforeVerify!(decl, otherHeader as never)).toMatchObject({
      abort: true,
      reason: REQUEST_COMMITMENT_ERRORS.mismatch,
    });
  });

  it("ignores non-Cardano requirements", async () => {
    const result = await verify(declaration(true), {
      ...ctx(await signedTx()),
      requirements: { ...requirements(), network: "eip155:8453" },
    } as never);
    expect(result).toBeUndefined();
  });
});

/** In-process facilitator client, as in the integration suite. */
class LocalFacilitatorClient implements FacilitatorClient {
  readonly scheme = "exact";
  readonly network = NETWORK;
  readonly x402Version = 2;
  /**
   * @param facilitator - In-process facilitator.
   */
  constructor(private readonly facilitator: x402Facilitator) {}
  /**
   * @param p - Payload.
   * @param r - Requirements.
   * @returns Verify response.
   */
  verify(p: PaymentPayload, r: PaymentRequirements): Promise<VerifyResponse> {
    return this.facilitator.verify(p, r);
  }
  /**
   * @param p - Payload.
   * @param r - Requirements.
   * @returns Settle response.
   */
  settle(p: PaymentPayload, r: PaymentRequirements): Promise<SettleResponse> {
    return this.facilitator.settle(p, r);
  }
  /**
   * @returns Supported kinds.
   */
  getSupported(): Promise<SupportedResponse> {
    return Promise.resolve(this.facilitator.getSupported());
  }
}

describe("full flow through x402Client, x402ResourceServer and the facilitator", () => {
  const ORIGIN = "https://api.example.com";
  const declared = {
    [CARDANO_REQUEST_COMMITMENT]: declareRequestCommitmentExtension({ required: true }),
  };

  /**
   * Runs 402 → payment → verify for one client configuration.
   *
   * @param clientRequest - What the client believes it is paying for.
   * @param retryPath - Path of the paid retry the server receives.
   * @param ignoreCommitment - Whether the client's signer drops the commitment.
   * @returns The verify result.
   */
  async function run(
    clientRequest: HttpRequestDescription,
    retryPath = "/article/A",
    ignoreCommitment = false,
  ) {
    const facilitator = new x402Facilitator().register(
      NETWORK,
      new ExactCardanoFacilitator(stubFacilitatorSigner()),
    );
    const server = new x402ResourceServer(new LocalFacilitatorClient(facilitator));
    server.register(NETWORK, new ExactCardanoServer());
    server.registerExtension(createRequestCommitmentServerExtension({ publicOrigin: ORIGIN }));
    await server.initialize();

    const first = transport({ method: "GET", url: "/article/A" });
    const accepts = [buildRequirements(payTo, "1000000")];
    const paymentRequired = await server.createPaymentRequiredResponse(
      accepts,
      { url: `${ORIGIN}/article/A`, description: "article", mimeType: "application/json" },
      undefined,
      server.enrichExtensions(declared, first.request),
      first,
    );

    const client = x402Client.fromConfig({
      schemes: [
        {
          network: NETWORK,
          client: new ExactCardanoClient(
            stubClientSigner({ ignoreRequestCommitment: ignoreCommitment }),
            { requestCommitmentRequest: () => clientRequest },
          ),
        },
      ],
      spendControls: false,
    });
    const payload = await client.createPaymentPayload(paymentRequired);

    const retry = transport({ method: "GET", url: retryPath });
    return server.verifyPayment(
      payload,
      payload.accepted,
      server.enrichExtensions(declared, retry.request),
      retry,
    );
  }

  it("verifies a payment whose transaction commits to the request", async () => {
    const result = await run(SPEC_REQUEST);
    expect(result.isValid).toBe(true);
  });

  it("rejects the same payment replayed against a different resource at the same price", async () => {
    const result = await run(SPEC_REQUEST, "/article/B");
    expect(result).toMatchObject({
      isValid: false,
      invalidReason: REQUEST_COMMITMENT_ERRORS.mismatch,
    });
  });

  it("client refuses to pay when the server's commitment is for another request", async () => {
    await expect(
      run({ ...SPEC_REQUEST, url: "https://api.example.com/article/B" }),
    ).rejects.toThrow(/Refusing to pay/);
  });

  it("client refuses a signer that drops the commitment", async () => {
    await expect(run(SPEC_REQUEST, "/article/A", true)).rejects.toThrow(/did not embed/);
  });
});
