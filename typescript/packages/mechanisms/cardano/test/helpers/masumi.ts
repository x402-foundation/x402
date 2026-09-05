/**
 * OFFLINE Masumi 402 issuer fixture. NOT part of the shipped package.
 *
 * Drives the shipped {@link issue} with a throwaway seller key, defaulting the
 * three later deadlines to the spec's minimum gaps so a fixture only has to name
 * `pay_by_time`. Every field a negative fixture needs to bend is an explicit
 * option, so the seller always signs exactly what goes on the wire.
 */
import {
  Address,
  COSE,
  EnterpriseAddress,
  KeyHash,
  PrivateKey,
  VKey,
} from "@evolution-sdk/evolution";
import type { PaymentRequirements } from "@x402/core/types";

import { getCardanoNetworkId } from "../../src/constants";
import { issueMasumiRequirements as issue } from "../../src/exact/masumi/issue";
import type {
  CardanoExtraMasumi,
  MasumiCommitmentPart,
  MasumiDeployment,
  MasumiTerms,
} from "../../src/types";

/** Options for {@link issueMasumiRequirements}. */
export interface IssueMasumiOptions {
  network: string;
  amount: string;
  asset: string;
  maxTimeoutSeconds?: number;
  /** `pay_by_time` in POSIX ms; the later deadlines default off it. */
  payByTimeMs: bigint;
  submitResultTimeMs?: bigint;
  unlockTimeMs?: bigint;
  externalDisputeUnlockTimeMs?: bigint;
  /** Committed request content. Defaults to a single JCS `body` part. */
  parts?: Array<Pick<MasumiCommitmentPart, "name" | "canonicalization" | "mediaType" | "content">>;
  buyerNonce?: string;
  agentIdentifier?: string | null;
  settlementPolicy?: MasumiTerms["settlementPolicy"];
  sellerReturnAddress?: string;
  submissionPolicy?: CardanoExtraMasumi["submissionPolicy"];
  confirmationPolicy?: CardanoExtraMasumi["confirmationPolicy"];
  deployment?: MasumiDeployment;
}

/** A complete Masumi 402 plus the seller that authorized it. */
export interface IssuedMasumiRequirements {
  requirements: PaymentRequirements;
  extra: CardanoExtraMasumi;
  sellerAddress: string;
}

/** Minimum deadline gaps the spec requires, in POSIX milliseconds. */
const FIVE_MINUTES = 5n * 60n * 1000n;
const FIFTEEN_MINUTES = 15n * 60n * 1000n;

/**
 * Derives a fresh key-credential (enterprise) address on a network.
 *
 * @param network - The x402 Cardano network identifier.
 * @returns The private key and its bech32 enterprise address.
 */
export function freshKeyAddress(network: string): {
  privateKey: PrivateKey.PrivateKey;
  address: string;
} {
  const privateKey = PrivateKey.fromBytes(PrivateKey.generate());
  const keyHash = KeyHash.fromVKey(VKey.fromPrivateKey(privateKey));
  const enterprise = new EnterpriseAddress.EnterpriseAddress({
    networkId: getCardanoNetworkId(network),
    paymentCredential: keyHash,
  });
  return { privateKey, address: Address.toBech32(enterprise as unknown as Address.Address) };
}

/**
 * Issues a spec-conformant Masumi 402 signed by a throwaway seller key.
 *
 * @param options - What to issue.
 * @returns The requirements, the typed extra, and the seller address.
 */
export async function issueMasumiRequirements(
  options: IssueMasumiOptions,
): Promise<IssuedMasumiRequirements> {
  const { privateKey, address: sellerAddress } = freshKeyAddress(options.network);
  const payByTime = options.payByTimeMs;
  const submitResultTime = options.submitResultTimeMs ?? payByTime + FIVE_MINUTES;
  const unlockTime = options.unlockTimeMs ?? submitResultTime + FIFTEEN_MINUTES;
  const externalDisputeUnlockTime =
    options.externalDisputeUnlockTimeMs ?? unlockTime + FIFTEEN_MINUTES;

  const requirements = await issue({
    network: options.network,
    asset: options.asset,
    amount: options.amount,
    maxTimeoutSeconds: options.maxTimeoutSeconds ?? 600,
    sellerAddress,
    commitment: options.parts ?? [
      {
        name: "body",
        canonicalization: "jcs",
        mediaType: "application/json",
        content: { days: 3, units: "metric" },
      },
    ],
    payByTime: payByTime.toString(),
    submitResultTime: submitResultTime.toString(),
    unlockTime: unlockTime.toString(),
    externalDisputeUnlockTime: externalDisputeUnlockTime.toString(),
    // Fixed so a fixture's blockchainIdentifier is reproducible.
    sellerNonce: "ab".repeat(32),
    // Negative fixtures exist precisely to mint 402s the issuer's own policy
    // rejects — hostile sellers do not run our issuer. `issue.spec` covers the
    // issuer-side checks directly.
    unsafeSkipPolicyChecks: true,
    ...(options.buyerNonce !== undefined ? { buyerNonce: options.buyerNonce } : {}),
    ...(options.agentIdentifier !== undefined ? { agentIdentifier: options.agentIdentifier } : {}),
    ...(options.sellerReturnAddress !== undefined
      ? { sellerReturnAddress: options.sellerReturnAddress }
      : {}),
    ...(options.settlementPolicy ? { settlementPolicy: options.settlementPolicy } : {}),
    ...(options.submissionPolicy ? { submissionPolicy: options.submissionPolicy } : {}),
    ...(options.confirmationPolicy ? { confirmationPolicy: options.confirmationPolicy } : {}),
    ...(options.deployment ? { deployment: options.deployment } : {}),
    signTerms: (address, termsDigestHex) => {
      const signed = COSE.SignData.signData(
        Address.toHex(Address.fromBech32(address)),
        Uint8Array.from(Buffer.from(termsDigestHex, "hex")),
        privateKey,
      );
      return {
        key: Buffer.from(signed.key).toString("hex").toLowerCase(),
        signature: Buffer.from(signed.signature).toString("hex").toLowerCase(),
      };
    },
  });

  return {
    requirements,
    extra: requirements.extra as unknown as CardanoExtraMasumi,
    sellerAddress,
  };
}
