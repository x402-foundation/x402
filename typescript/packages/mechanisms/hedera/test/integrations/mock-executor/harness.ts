/**
 * Shared setup for the live corner-case suite: a real facilitator on Hedera testnet wired to
 * the Mirror Node and the SDK, and payloads carrying MockTransferExecutor authorizations.
 */
import { randomBytes } from "node:crypto";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  AccountAllowanceApproveTransaction,
  AccountCreateTransaction,
  AccountId,
  AccountUpdateTransaction,
  Client,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  CustomFixedFee,
  Hbar,
  PrivateKey,
  TokenCreateTransaction,
  TokenId,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { HBAR_ASSET_ID } from "../../../src/constants";
import { ExactHederaScheme as ExactHederaFacilitator } from "../../../src/exact/facilitator/scheme";
import { createHederaPreflightTransfer } from "../../../src/preflight";
import {
  createHederaSignAndSubmitTransaction,
  createHederaVerifyPayerSignature,
  type FacilitatorHederaSigner,
} from "../../../src/signer";
import {
  createHederaGetTokenCustomFees,
  createHederaGetTransactionRecord,
  createHederaResolveEvmAddress,
  createHederaSimulateContractCall,
  createHederaSubmitContractExecute,
} from "../../../src/transferExecutorCapabilities";
import { buildMockAuthorization, MockMode, readBinding, type MockModeValue } from "./authorization";
import { asFacilitatorCall, caseFor, installRecorder, type RecordedSubmit } from "./recorder";

installRecorder();

export const NETWORK = "hedera:testnet";
export const DEFAULT_AMOUNT = 100_000n;
const DEFAULT_MIRROR = "https://testnet.mirrornode.hedera.com";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Settings of the live corner-case suite, from the environment.
 */
export type LiveEnv = {
  feePayer: string;
  feePayerKey: PrivateKey;
  payTo: string;
  /** The MockTransferExecutor, which is also the payer. */
  executor: string;
  mirrorNodeUrl: string | undefined;
};

/**
 * Reads the suite's settings.
 *
 * @returns The settings, or undefined unless every required variable is set
 */
export function readLiveEnv(): LiveEnv | undefined {
  const feePayer = process.env.HEDERA_FACILITATOR_ACCOUNT_ID;
  const key = process.env.HEDERA_FACILITATOR_PRIVATE_KEY;
  const payTo = process.env.HEDERA_RESOURCE_SERVER_ACCOUNT_ID;
  const executor = process.env.HEDERA_TE_MOCK_EXECUTOR_ID;
  if (!feePayer || !key || !payTo || !executor) {
    return undefined;
  }
  return {
    feePayer,
    feePayerKey: PrivateKey.fromStringECDSA(key),
    payTo,
    executor,
    mirrorNodeUrl: process.env.HEDERA_MIRROR_NODE_URL || undefined,
  };
}

/**
 * Options of the facilitator under test.
 */
export type FacilitatorOptions = {
  /** Executors the facilitator admits. Defaults to the mock. */
  executors?: string[];
  gasLimit?: number;
  simulationGasCeiling?: number;
};

/**
 * Builds a facilitator scheme with the real Mirror Node and SDK capabilities. Each call gets
 * its own in-flight guard.
 *
 * @param env - Suite settings
 * @param options - Admitted executors and gas settings
 * @returns Facilitator scheme
 */
export function createFacilitator(
  env: LiveEnv,
  options: FacilitatorOptions = {},
): ExactHederaFacilitator {
  const mirror = { mirrorNodeUrl: env.mirrorNodeUrl };
  const buildClient = (): Client =>
    Client.forTestnet().setOperator(AccountId.fromString(env.feePayer), env.feePayerKey);
  const signer: FacilitatorHederaSigner = {
    getAddresses: () => [env.feePayer],
    signAndSubmitTransaction: createHederaSignAndSubmitTransaction(buildClient, env.feePayerKey),
    verifyPayerSignature: createHederaVerifyPayerSignature(mirror),
    preflightTransfer: createHederaPreflightTransfer(mirror),
    resolveEvmAddress: createHederaResolveEvmAddress(mirror),
    getTokenCustomFees: createHederaGetTokenCustomFees(mirror),
    simulateContractCall: createHederaSimulateContractCall(mirror),
    submitContractExecute: createHederaSubmitContractExecute(buildClient, env.feePayerKey),
    getTransactionRecord: createHederaGetTransactionRecord(mirror),
  };
  const executors = options.executors ?? [env.executor];
  const gasLimit = options.gasLimit ?? 400_000;
  const recorded = caseFor({
    feePayer: env.feePayer,
    config: { executors, gasLimit, simulationGasCeiling: options.simulationGasCeiling },
  });
  const submits: RecordedSubmit[] = [];
  if (recorded && signer.submitContractExecute) {
    const submit = signer.submitContractExecute;
    signer.submitContractExecute = async params => {
      try {
        const result = await submit(params);
        submits.push(result);
        return result;
      } catch (error) {
        submits.push({ error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    };
  }
  const scheme = new ExactHederaFacilitator(signer, {
    transferExecutor: {
      executors: { [NETWORK]: executors },
      gasLimit,
      simulationGasCeiling: options.simulationGasCeiling,
    },
  });
  if (recorded) {
    for (const op of ["verify", "settle"] as const) {
      const run = scheme[op].bind(scheme) as (
        payload: PaymentPayload,
        requirements: PaymentRequirements,
      ) => Promise<unknown>;
      (scheme as unknown as Record<string, unknown>)[op] = async (
        payload: PaymentPayload,
        requirements: PaymentRequirements,
      ) => {
        const before = submits.length;
        const response = await asFacilitatorCall(() => run(payload, requirements));
        recorded.ops.push({
          op,
          payload,
          requirements,
          response,
          submit: submits.length > before ? submits[before] : undefined,
        });
        return response;
      };
    }
  }
  return scheme;
}

/**
 * What an authorization is prepared for, and how it may differ from the payment.
 */
export type PaymentOptions = {
  mode: MockModeValue;
  /** Requirements amount, in tinybars. */
  amount?: bigint;
  /** Amount the authorization is bound to, when it should differ from `amount`. */
  boundAmount?: bigint;
  /** Unix seconds the authorization expires. */
  validBefore?: bigint;
  /** Executor named in the payload, when it should differ from the mock. */
  payloadExecutor?: string;
  /** HTS token id to pay in; defaults to HBAR. */
  asset?: string;
  /** Payee; defaults to the suite's `payTo`. */
  payTo?: string;
};

/**
 * Builds a payment of HBAR from the mock to `payTo`, carrying a fresh authorization.
 *
 * @param env - Suite settings
 * @param options - Mode and any deliberate mismatch
 * @returns Payload and the requirements it accepts
 */
export async function createPayment(
  env: LiveEnv,
  options: PaymentOptions,
): Promise<{ payload: PaymentPayload; requirements: PaymentRequirements }> {
  const mirrorNodeUrl = env.mirrorNodeUrl ?? DEFAULT_MIRROR;
  const amount = options.amount ?? DEFAULT_AMOUNT;
  const resolve = createHederaResolveEvmAddress({ mirrorNodeUrl: env.mirrorNodeUrl });
  const payTo = options.payTo ?? env.payTo;
  const asset = options.asset ?? HBAR_ASSET_ID;
  const from = await resolve({ account: env.executor, network: NETWORK });
  const to = await resolve({ account: payTo, network: NETWORK });
  if (!from || !to) {
    throw new Error("could not resolve the payer or payTo to an EVM address");
  }
  const binding = await readBinding({
    mirrorNodeUrl,
    executorId: env.executor,
    from: from.evmAddress,
    asset: options.asset ? `0x${TokenId.fromString(options.asset).toEvmAddress()}` : ZERO_ADDRESS,
    to: to.evmAddress,
    amount: options.boundAmount ?? amount,
  });
  const authorization = buildMockAuthorization({
    mode: options.mode,
    binding,
    validBefore: options.validBefore,
  });
  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: NETWORK,
    amount: amount.toString(),
    asset,
    payTo,
    maxTimeoutSeconds: 180,
    extra: { assetTransferMethod: "transferExecutor", executors: [env.executor] },
  };
  return {
    payload: {
      x402Version: 2,
      resource: {
        url: "https://example.com/paid",
        description: "corner case",
        mimeType: "text/plain",
      },
      accepted: requirements,
      payload: {
        payer: env.executor,
        executor: options.payloadExecutor ?? env.executor,
        authorization,
      },
    },
    requirements,
  };
}

export { MockMode };

// ---------------------------------------------------------------------------------------------
// HTS fungible tokens: a token, a funded mock, and a payee that can receive it.
// ---------------------------------------------------------------------------------------------

/**
 * A fungible token the mock holds, and an account to pay it to.
 */
export type TokenFixture = {
  tokenId: string;
  /** Payee that accepts the token through automatic association. */
  payTo: string;
};

/**
 * Creates a fungible token with the facilitator as treasury, associates the mock with it and
 * funds the mock, and creates a payee account. The facilitator pays for all of it.
 *
 * @param env - Suite settings
 * @param options - Token settings
 * @param options.customFee - Gives the token a fixed custom fee of 1 HBAR, collected by the facilitator
 * @param options.fund - Token units to deposit in the mock, default 1,000,000 (all of the supply)
 * @returns The token and the payee
 */
export async function createTokenFixture(
  env: LiveEnv,
  options: { customFee?: boolean; fund?: number } = {},
): Promise<TokenFixture> {
  const client = Client.forTestnet()
    .setOperator(AccountId.fromString(env.feePayer), env.feePayerKey)
    .setDefaultMaxTransactionFee(new Hbar(20));
  try {
    const supply = 1_000_000;
    const create = new TokenCreateTransaction()
      .setTokenName("x402 test token")
      .setTokenSymbol("X402T")
      // The SDK's own cap for a token create is below what testnet charges at the current rate.
      .setMaxTransactionFee(new Hbar(40))
      .setDecimals(0)
      .setInitialSupply(supply)
      .setTreasuryAccountId(AccountId.fromString(env.feePayer));
    if (options.customFee) {
      create.setCustomFees([
        new CustomFixedFee()
          .setHbarAmount(new Hbar(1))
          .setFeeCollectorAccountId(AccountId.fromString(env.feePayer)),
      ]);
    }
    const tokenId = (await (await create.execute(client)).getReceipt(client)).tokenId;
    if (!tokenId) {
      throw new Error("token creation returned no token id");
    }

    const payeeKey = PrivateKey.generateECDSA();
    const payee = await (
      await new AccountCreateTransaction()
        .setECDSAKeyWithAlias(payeeKey.publicKey)
        .setMaxAutomaticTokenAssociations(-1)
        .setInitialBalance(new Hbar(1))
        .freezeWith(client)
        .sign(payeeKey)
    ).execute(client);
    const payTo = (await payee.getReceipt(client)).accountId;
    if (!payTo) {
      throw new Error("payee account creation returned no account id");
    }

    if (!options.customFee) {
      // The mock associates itself: HTS accepts an association signed by the contract's own call.
      await (
        await new ContractExecuteTransaction()
          .setContractId(env.executor)
          .setGas(1_000_000)
          .setFunction(
            "associate",
            new ContractFunctionParameters().addAddress(tokenId.toEvmAddress()),
          )
          .execute(client)
      ).getReceipt(client);
      await (
        await new TransferTransaction()
          .addTokenTransfer(tokenId, AccountId.fromString(env.feePayer), -(options.fund ?? supply))
          .addTokenTransfer(tokenId, AccountId.fromString(env.executor), options.fund ?? supply)
          .execute(client)
      ).getReceipt(client);
    }
    return { tokenId: tokenId.toString(), payTo: payTo.toString() };
  } finally {
    client.close();
  }
}

// ---------------------------------------------------------------------------------------------
// SignedOwnerExecutor: an owner account, its allowance, signed authorizations and key rotation.
// ---------------------------------------------------------------------------------------------

const TESTNET_CHAIN_ID = 296n;
/** `bytes32("SignedOwnerExecutor.v1")`, left-aligned ASCII. */
const SIGNED_DOMAIN = Buffer.from("SignedOwnerExecutor.v1").toString("hex").padEnd(64, "0");

/**
 * Settings of the signed-owner suite: the shared ones plus the deployed executor.
 */
export type SignedEnv = LiveEnv & { signedExecutor: string };

/**
 * Reads the signed-owner suite's settings.
 *
 * @returns The settings, or undefined unless every required variable is set
 */
export function readSignedEnv(): SignedEnv | undefined {
  const base = readLiveEnv();
  const signedExecutor = process.env.HEDERA_TE_SIGNED_EXECUTOR_ID;
  return base && signedExecutor ? { ...base, signedExecutor } : undefined;
}

/**
 * An owner account the signed executor can spend from.
 */
export type Owner = {
  accountId: string;
  key: PrivateKey;
  /** The owner's alias: the address the executor receives as `from`. */
  evmAddress: string;
};

/**
 * Builds an SDK client that pays as the facilitator.
 *
 * @param env - Suite settings
 * @returns Client
 */
function operatorClient(env: LiveEnv): Client {
  return Client.forTestnet()
    .setOperator(AccountId.fromString(env.feePayer), env.feePayerKey)
    .setDefaultMaxTransactionFee(new Hbar(20));
}

/**
 * Creates an owner account with an ECDSA key and an alias, and grants the signed executor an
 * HBAR allowance. The facilitator pays for both; the owner signs the allowance.
 *
 * @param env - Suite settings
 * @param options - Initial balance and allowance, in HBAR
 * @param options.balance - Initial balance, default 2
 * @param options.allowance - Allowance for the executor, default 1; 0 grants none
 * @returns The owner
 */
export async function createOwner(
  env: SignedEnv,
  options: { balance?: number; allowance?: number } = {},
): Promise<Owner> {
  const client = operatorClient(env);
  try {
    const key = PrivateKey.generateECDSA();
    const created = await (
      await new AccountCreateTransaction()
        .setECDSAKeyWithAlias(key.publicKey)
        .setInitialBalance(new Hbar(options.balance ?? 2))
        .freezeWith(client)
        .sign(key)
    ).execute(client);
    const accountId = (await created.getReceipt(client)).accountId;
    if (!accountId) {
      throw new Error("owner account creation returned no account id");
    }
    const allowance = options.allowance ?? 1;
    if (allowance > 0) {
      await (
        await (
          await new AccountAllowanceApproveTransaction()
            .approveHbarAllowance(
              accountId,
              AccountId.fromString(env.signedExecutor),
              new Hbar(allowance),
            )
            .freezeWith(client)
            .sign(key)
        ).execute(client)
      ).getReceipt(client);
    }
    if (allowance > 0) {
      // The simulation reads mirror state, so a payment verified before the mirror node has
      // ingested the allowance would revert in the executor's allowance transfer.
      const base = (env.mirrorNodeUrl ?? DEFAULT_MIRROR).replace(/\/+$/, "");
      await waitFor(
        async () => {
          const response = await fetch(
            `${base}/api/v1/accounts/${accountId}/allowances/crypto?spender.id=${env.signedExecutor}`,
          );
          const body = (await response.json()) as { allowances?: unknown[] };
          return body.allowances?.length ?? 0;
        },
        shown => shown > 0,
      );
    }
    const resolve = createHederaResolveEvmAddress({ mirrorNodeUrl: env.mirrorNodeUrl });
    const evm = await waitFor(
      () => resolve({ account: accountId.toString(), network: NETWORK }),
      value => value !== undefined,
    );
    return { accountId: accountId.toString(), key, evmAddress: evm!.evmAddress };
  } finally {
    client.close();
  }
}

/**
 * Rotates an owner's account key. The owner's alias keeps naming the old key.
 *
 * @param env - Suite settings
 * @param owner - Owner to rotate; its `key` is replaced
 * @returns The owner with the new key
 */
export async function rotateOwnerKey(env: SignedEnv, owner: Owner): Promise<Owner> {
  const client = operatorClient(env);
  try {
    const next = PrivateKey.generateECDSA();
    await (
      await (
        await new AccountUpdateTransaction()
          .setAccountId(AccountId.fromString(owner.accountId))
          .setKey(next.publicKey)
          .freezeWith(client)
          .sign(owner.key)
      ).sign(next)
    )
      .execute(client)
      .then(response => response.getReceipt(client));
    // The simulation reads mirror state, so wait until the mirror node shows the new key.
    const base = (env.mirrorNodeUrl ?? DEFAULT_MIRROR).replace(/\/+$/, "");
    await waitFor(
      async () => {
        const response = await fetch(`${base}/api/v1/accounts/${owner.accountId}`);
        const body = (await response.json()) as { key?: { key?: string } };
        return body.key?.key?.toLowerCase();
      },
      shown => shown === next.publicKey.toStringRaw().toLowerCase(),
    );
    return { ...owner, key: next };
  } finally {
    client.close();
  }
}

/**
 * Polls until a value satisfies a condition.
 *
 * @param read - Reads the value
 * @param done - True when the value is the one waited for
 * @param timeoutMs - Give up after this long
 * @returns The value
 */
async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the mirror node");
    }
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
}

/**
 * Left-pads a hex string to one ABI word.
 *
 * @param hex - Hex digits without a prefix
 * @returns 64 hex characters
 */
function word(hex: string): string {
  return hex.padStart(64, "0");
}

/**
 * Builds a payment of HBAR from an owner to `payTo` through the signed executor.
 *
 * @param env - Suite settings
 * @param owner - Owner named as payer, whose allowance the executor spends
 * @param options - What is signed, and by whom
 * @param options.signer - Key that signs, default the owner's current key
 * @param options.amount - Requirements amount
 * @param options.signedAmount - Amount the signature covers, when it should differ
 * @param options.validBefore - Unix seconds the authorization expires
 * @returns Payload and the requirements it accepts
 */
export async function createSignedPayment(
  env: SignedEnv,
  owner: Owner,
  options: {
    signer?: PrivateKey;
    amount?: bigint;
    signedAmount?: bigint;
    validBefore?: bigint;
  } = {},
): Promise<{ payload: PaymentPayload; requirements: PaymentRequirements }> {
  const amount = options.amount ?? DEFAULT_AMOUNT;
  const resolve = createHederaResolveEvmAddress({ mirrorNodeUrl: env.mirrorNodeUrl });
  const to = await resolve({ account: env.payTo, network: NETWORK });
  const base = (env.mirrorNodeUrl ?? DEFAULT_MIRROR).replace(/\/+$/, "");
  const contract = (await (
    await fetch(`${base}/api/v1/contracts/${env.signedExecutor}`)
  ).json()) as {
    evm_address: string;
  };
  if (!to) {
    throw new Error("could not resolve payTo to an EVM address");
  }
  const validBefore = options.validBefore ?? BigInt(Math.floor(Date.now() / 1000) + 600);
  const nonce = randomBytes(32).toString("hex");
  const address = (value: string) => word(value.replace(/^0x/, ""));

  // digest = abi.encode(DOMAIN, from, asset, to, amount, validBefore, nonce, chainid, executor)
  const digest = Buffer.from(
    SIGNED_DOMAIN +
      address(owner.evmAddress) +
      address(ZERO_ADDRESS) +
      address(to.evmAddress) +
      word((options.signedAmount ?? amount).toString(16)) +
      word(validBefore.toString(16)) +
      nonce +
      word(TESTNET_CHAIN_ID.toString(16)) +
      address(contract.evm_address),
    "hex",
  );
  const signer = options.signer ?? owner.key;
  const signature = Buffer.from(signer.sign(digest)).toString("hex");
  const pubKey = Buffer.from(signer.publicKey.toBytesRaw()).toString("hex");

  // abi.encode(uint256 validBefore, bytes32 nonce, bytes pubKey, bytes signature)
  const authorization =
    "0x" +
    word(validBefore.toString(16)) +
    nonce +
    word("80") + // offset of pubKey: four head words
    word("e0") + // offset of signature: 0x80 + length word + 33 bytes padded to 64
    word("21") + // pubKey length
    pubKey.padEnd(128, "0") +
    word("40") + // signature length
    signature;

  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: NETWORK,
    amount: amount.toString(),
    asset: HBAR_ASSET_ID,
    payTo: env.payTo,
    maxTimeoutSeconds: 180,
    extra: { assetTransferMethod: "transferExecutor", executors: [env.signedExecutor] },
  };
  return {
    payload: {
      x402Version: 2,
      resource: {
        url: "https://example.com/paid",
        description: "signed owner",
        mimeType: "text/plain",
      },
      accepted: requirements,
      payload: { payer: owner.accountId, executor: env.signedExecutor, authorization },
    },
    requirements,
  };
}
