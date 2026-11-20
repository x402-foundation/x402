import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  acceptedTermsFingerprint,
  configureExactHeaderReplay,
  type ExactHeaderReplayClient,
  type ExactHeaderReplayHttpClient,
  type PaymentRequiredLike,
  type PaymentRequirementsLike,
} from "./header-replay.ts";

const REQUIREMENTS: PaymentRequirementsLike = {
  scheme: "exact",
  network: "eip155:84532",
  asset: "0x0000000000000000000000000000000000000001",
  amount: "1000",
  payTo: "0x0000000000000000000000000000000000000002",
  maxTimeoutSeconds: 300,
};
const OTHER_REQUIREMENTS: PaymentRequirementsLike = {
  ...REQUIREMENTS,
  amount: "9999",
};
const PAYMENT_REQUIRED: PaymentRequiredLike = { accepts: [REQUIREMENTS] };
const OTHER_PAYMENT_REQUIRED: PaymentRequiredLike = { accepts: [OTHER_REQUIREMENTS] };
const PAYLOAD = {
  x402Version: 2,
  payload: { signature: "0xsig" },
  accepted: REQUIREMENTS,
};

const WEATHER = "http://localhost:4022/weather";
const WEATHER_QUERY = "http://localhost:4022/weather?x=1";
const FORECAST = "http://localhost:4022/forecast";
const EVIL_ORIGIN = "http://evil.example/weather";

type AfterHook = (context: {
  paymentPayload: object;
  selectedRequirements: PaymentRequirementsLike;
}) => Promise<void>;
type RequiredHook = (context: {
  paymentRequired: PaymentRequiredLike;
  requestUrl: string;
}) => Promise<{ headers: Record<string, string> } | void>;

const digest = (headers: Record<string, string> | null | undefined): string => {
  if (!headers) {
    return "";
  }
  const value = Object.values(headers)[0];
  if (!value) {
    return "";
  }
  return createHash("sha256").update(value).digest("hex");
};

const payloadWithSignature = (signature: string) => ({
  x402Version: 2,
  payload: { signature },
  accepted: REQUIREMENTS,
});

const setup = (targetUrl: string = WEATHER) => {
  let afterHook: AfterHook | undefined;
  let requiredHook: RequiredHook | undefined;
  const client: ExactHeaderReplayClient = {
    onAfterPaymentCreation(hook) {
      afterHook = hook;
    },
  };
  const httpClient: ExactHeaderReplayHttpClient = {
    encodePaymentSignatureHeader(paymentPayload) {
      return {
        "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(paymentPayload), "utf8").toString("base64"),
      };
    },
    onPaymentRequired(hook) {
      requiredHook = hook;
    },
  };
  const captured = configureExactHeaderReplay(client, httpClient, targetUrl);
  assert.ok(afterHook);
  assert.ok(requiredHook);
  return {
    captured,
    afterPaymentCreation: afterHook,
    handlePaymentRequired: async (paymentRequired: PaymentRequiredLike, requestUrl: string) => {
      const result = await requiredHook!({ paymentRequired, requestUrl });
      return result?.headers ?? null;
    },
  };
};

const captureWeather = async (
  session: ReturnType<typeof setup>,
  requirements: PaymentRequirementsLike = REQUIREMENTS,
) => {
  const before = await session.handlePaymentRequired({ accepts: [requirements] }, WEATHER);
  assert.equal(before, null);
  await session.afterPaymentCreation({
    paymentPayload: PAYLOAD,
    selectedRequirements: requirements,
  });
};

const PYTHON_REQUIREMENTS_FINGERPRINT =
  "b5c50625f882c99881003964ead755b512b55723f6e1cbad6f1e835d452c9ea0";

describe("acceptedTermsFingerprint", () => {
  it("matches the Python accepted-terms fingerprint for the same requirements", () => {
    assert.equal(acceptedTermsFingerprint(REQUIREMENTS), PYTHON_REQUIREMENTS_FINGERPRINT);
  });

  it("is stable across extra key order and nested extra key order", () => {
    const left = acceptedTermsFingerprint({
      ...REQUIREMENTS,
      extra: { b: 1, a: { d: 2, c: 3 } },
    });
    const right = acceptedTermsFingerprint({
      ...REQUIREMENTS,
      extra: { a: { c: 3, d: 2 }, b: 1 },
    });
    assert.equal(left, right);
    assert.equal(left.length, 64);
  });

  it("normalizes maxTimeoutSeconds and payTo aliases", () => {
    const camel = acceptedTermsFingerprint(REQUIREMENTS);
    const snake = acceptedTermsFingerprint({
      scheme: REQUIREMENTS.scheme,
      network: REQUIREMENTS.network,
      asset: REQUIREMENTS.asset,
      amount: REQUIREMENTS.amount,
      pay_to: REQUIREMENTS.payTo,
      max_timeout_seconds: REQUIREMENTS.maxTimeoutSeconds,
    });
    assert.equal(camel, snake);
  });

  it("treats missing extra as empty object and changes when extra or timeout changes", () => {
    const missing = acceptedTermsFingerprint(REQUIREMENTS);
    const empty = acceptedTermsFingerprint({ ...REQUIREMENTS, extra: {} });
    const otherExtra = acceptedTermsFingerprint({ ...REQUIREMENTS, extra: { nonce: "1" } });
    const otherTimeout = acceptedTermsFingerprint({ ...REQUIREMENTS, maxTimeoutSeconds: 301 });
    assert.equal(missing, empty);
    assert.notEqual(missing, otherExtra);
    assert.notEqual(missing, otherTimeout);
  });
});

describe("exact header replay", () => {
  it("replays the first encoded header for the exact URL and accepted terms", async () => {
    const session = setup();
    await captureWeather(session);
    assert.ok(session.captured.headers);
    const first = session.captured.headers;
    const replayed = await session.handlePaymentRequired(PAYMENT_REQUIRED, WEATHER);
    assert.ok(replayed);
    assert.deepEqual(Object.keys(first ?? {}), Object.keys(replayed ?? {}));
    assert.equal(digest(first), digest(replayed));
    const firstValue = Object.values(first ?? {})[0] ?? "";
    assert.ok(firstValue.length > 16);
  });

  it("does not replay across query drift", async () => {
    const session = setup();
    await captureWeather(session);
    const replayed = await session.handlePaymentRequired(PAYMENT_REQUIRED, WEATHER_QUERY);
    assert.equal(replayed, null);
  });

  it("does not replay to a different origin", async () => {
    const session = setup();
    await captureWeather(session);
    const replayed = await session.handlePaymentRequired(PAYMENT_REQUIRED, EVIL_ORIGIN);
    assert.equal(replayed, null);
  });

  it("does not replay to a different path", async () => {
    const session = setup();
    await captureWeather(session);
    const replayed = await session.handlePaymentRequired(PAYMENT_REQUIRED, FORECAST);
    assert.equal(replayed, null);
  });

  it("does not replay against different accepted terms", async () => {
    const session = setup();
    await captureWeather(session);
    const replayed = await session.handlePaymentRequired(OTHER_PAYMENT_REQUIRED, WEATHER);
    assert.equal(replayed, null);
    const same = await session.handlePaymentRequired(PAYMENT_REQUIRED, WEATHER);
    assert.ok(same);
    assert.equal(digest(session.captured.headers), digest(same));
  });

  it("does not bind A's credential to B when 402s interleave before capture", async () => {
    const session = setup(WEATHER);
    const beforeA = await session.handlePaymentRequired(PAYMENT_REQUIRED, WEATHER);
    const beforeB = await session.handlePaymentRequired(PAYMENT_REQUIRED, EVIL_ORIGIN);
    assert.equal(beforeA, null);
    assert.equal(beforeB, null);
    await session.afterPaymentCreation({
      paymentPayload: payloadWithSignature("0xsig-A"),
      selectedRequirements: REQUIREMENTS,
    });
    const replayedB = await session.handlePaymentRequired(PAYMENT_REQUIRED, EVIL_ORIGIN);
    const replayedA = await session.handlePaymentRequired(PAYMENT_REQUIRED, WEATHER);
    assert.equal(replayedB, null);
    assert.equal(replayedA, null);
    assert.equal(session.captured.url, WEATHER);
    assert.equal(session.captured.headers, undefined);
  });

  it("does not bind B's credential to A on reverse capture order", async () => {
    const session = setup(WEATHER);
    const beforeB = await session.handlePaymentRequired(PAYMENT_REQUIRED, FORECAST);
    const beforeA = await session.handlePaymentRequired(PAYMENT_REQUIRED, WEATHER);
    assert.equal(beforeB, null);
    assert.equal(beforeA, null);
    await session.afterPaymentCreation({
      paymentPayload: payloadWithSignature("0xsig-B"),
      selectedRequirements: REQUIREMENTS,
    });
    const replayedA = await session.handlePaymentRequired(PAYMENT_REQUIRED, WEATHER);
    const replayedB = await session.handlePaymentRequired(PAYMENT_REQUIRED, FORECAST);
    assert.equal(replayedA, null);
    assert.equal(replayedB, null);
    assert.equal(session.captured.url, WEATHER);
    assert.equal(session.captured.headers, undefined);
  });

  it("keeps sequential capture after a later foreign 402", async () => {
    const session = setup();
    await captureWeather(session);
    const foreign = await session.handlePaymentRequired(PAYMENT_REQUIRED, EVIL_ORIGIN);
    assert.equal(foreign, null);
    const same = await session.handlePaymentRequired(PAYMENT_REQUIRED, WEATHER);
    assert.ok(same);
    assert.equal(digest(session.captured.headers), digest(same));
    assert.equal(session.captured.url, WEATHER);
  });

  it("fails closed when the configured target URL is empty", async () => {
    const session = setup("");
    const before = await session.handlePaymentRequired(PAYMENT_REQUIRED, WEATHER);
    assert.equal(before, null);
    await session.afterPaymentCreation({
      paymentPayload: PAYLOAD,
      selectedRequirements: REQUIREMENTS,
    });
    const replayed = await session.handlePaymentRequired(PAYMENT_REQUIRED, WEATHER);
    assert.equal(replayed, null);
    assert.equal(session.captured.headers, undefined);
  });
});
