import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  createSIWxMessage,
  createSIWxPayload,
  encodeSIWxHeader,
  parseSIWxHeader,
  validateSIWxMessage,
  verifySIWxSignature,
  type CompleteSIWxInfo,
  type EVMMessageVerifier,
  type EVMSigner,
} from "../src/sign-in-with-x/evm/index";
import {
  createSIWxMessage as createMixedMessage,
  createSIWxPayload as createMixedPayload,
  verifySIWxSignature as verifyMixedSignature,
} from "../src/sign-in-with-x/index";

const account = privateKeyToAccount(generatePrivateKey());
const responseUrl = "https://api.example.com/data";
const challenge: CompleteSIWxInfo = {
  domain: "api.example.com",
  uri: responseUrl,
  version: "1",
  chainId: "eip155:8453",
  type: "eip191",
  nonce: "a1b2c3d4e5f67890a1b2c3d4e5f67890",
  issuedAt: "2026-01-01T00:00:00.000Z",
  statement: "Sign in to access your purchased content",
  expirationTime: "2026-01-01T00:05:00.000Z",
  notBefore: "2025-12-31T23:59:00.000Z",
  requestId: "request-123",
  resources: ["https://other.example.com/resource"],
  signatureScheme: "eip191",
};
const expectedMessage = `api.example.com wants you to sign in with your Ethereum account:
${account.address}

Sign in to access your purchased content

URI: https://api.example.com/data
Version: 1
Chain ID: 8453
Nonce: a1b2c3d4e5f67890a1b2c3d4e5f67890
Issued At: 2026-01-01T00:00:00.000Z
Expiration Time: 2026-01-01T00:05:00.000Z
Not Before: 2025-12-31T23:59:00.000Z
Request ID: request-123
Resources:
- https://other.example.com/resource`;

describe("EVM-only SIWX helpers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:01:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("signs, encodes, validates, and verifies an EOA proof with all optional fields", async () => {
    const info = { ...challenge, unsignedServerMetadata: "must not enter the proof" };
    const payload = await createSIWxPayload(info, account, responseUrl);

    expect(createSIWxMessage(info, account.address)).toBe(expectedMessage);
    expect(payload).toEqual({
      ...challenge,
      address: account.address,
      signature: expect.stringMatching(/^0x[0-9a-f]+$/),
    });
    expect(createMixedMessage(info, account.address)).toBe(expectedMessage);
    expect(await createMixedPayload(info, account, responseUrl)).toEqual(payload);

    const parsed = parseSIWxHeader(encodeSIWxHeader(payload));
    expect(parsed).toEqual(payload);
    const checkNonce = vi.fn().mockResolvedValue(true);
    expect(await validateSIWxMessage(parsed, new URL(responseUrl), { checkNonce })).toEqual({
      isValid: true,
    });
    expect(checkNonce).toHaveBeenCalledExactlyOnceWith(challenge.nonce);
    expect(await verifySIWxSignature(parsed)).toEqual({ isValid: true, payer: account.address });
    expect(await verifyMixedSignature(parsed)).toEqual({ isValid: true, payer: account.address });
  });

  it("rejects a tampered signed requestId", async () => {
    const payload = await createSIWxPayload(challenge, account, responseUrl);
    expect(await verifySIWxSignature({ ...payload, requestId: "request-456" })).toMatchObject({
      isValid: false,
      invalidReason: "invalid_siwx_signature",
    });
  });

  it("keeps signatureScheme informational", async () => {
    const payload = await createSIWxPayload(challenge, account, responseUrl);
    expect(await verifySIWxSignature({ ...payload, signatureScheme: "eip6492" })).toEqual({
      isValid: true,
      payer: account.address,
    });
  });

  it("forwards a wallet client's account when signing", async () => {
    const signMessage = vi.fn(account.signMessage);
    const signer: EVMSigner = { account, signMessage };
    const payload = await createSIWxPayload(challenge, signer, responseUrl);
    expect(signMessage).toHaveBeenCalledExactlyOnceWith({ message: expectedMessage, account });
    expect(await verifySIWxSignature(payload)).toEqual({ isValid: true, payer: account.address });
  });

  it.each([
    { domain: "attacker.example" },
    { domain: "api.example.com.attacker.example" },
    { uri: "https://api.example.com.attacker.example/data" },
    { uri: "http://api.example.com/data" },
    { uri: "https://api.example.com:8443/data" },
    { uri: "not a URL" },
  ])("rejects an unbound challenge before signing %j", async changed => {
    const signMessage = vi.fn(account.signMessage);
    await expect(
      createSIWxPayload({ ...challenge, ...changed }, { ...account, signMessage }, responseUrl),
    ).rejects.toThrow();
    expect(signMessage).not.toHaveBeenCalled();
  });

  it("binds to the final response origin after redirects", async () => {
    const redirected = {
      ...challenge,
      domain: "login.example.com:8443",
      uri: "https://login.example.com:8443/data",
    };
    const signMessage = vi.fn(account.signMessage);
    const signer = { ...account, signMessage };
    await expect(createSIWxPayload(redirected, signer, responseUrl)).rejects.toThrow();
    expect(signMessage).not.toHaveBeenCalled();
    const payload = await createSIWxPayload(redirected, signer, new URL(redirected.uri));
    expect(signMessage).toHaveBeenCalledTimes(1);
    expect(await verifySIWxSignature(payload)).toEqual({ isValid: true, payer: account.address });
  });

  it.each(["solana:mainnet", "unknown:1", "eip155:invalid", "eip155:"])(
    "rejects the unsupported EVM chain %s before signing or verification",
    async chainId => {
      const info = { ...challenge, chainId };
      const signMessage = vi.fn(account.signMessage);
      expect(() => createSIWxMessage(info, account.address)).toThrow();
      await expect(
        createSIWxPayload(info, { ...account, signMessage }, responseUrl),
      ).rejects.toThrow();
      expect(signMessage).not.toHaveBeenCalled();
      const evmVerifier = vi.fn<EVMMessageVerifier>();
      expect(
        await verifySIWxSignature(
          { ...info, address: account.address, signature: "0x1234" },
          { evmVerifier },
        ),
      ).toMatchObject({ isValid: false, invalidReason: "invalid_siwx_chain_id" });
      expect(evmVerifier).not.toHaveBeenCalled();
    },
  );

  it("forwards all signed fields to the smart wallet verifier", async () => {
    const payload = { ...challenge, address: account.address, signature: "0x1234" };
    const evmVerifier = vi.fn<EVMMessageVerifier>().mockResolvedValue(true);
    const verification = await verifySIWxSignature(payload, { evmVerifier });
    expect(evmVerifier).toHaveBeenCalledExactlyOnceWith({
      address: account.address,
      message: expectedMessage,
      signature: "0x1234",
    });
    expect(verification).toEqual({ isValid: true, payer: account.address });
  });
});
