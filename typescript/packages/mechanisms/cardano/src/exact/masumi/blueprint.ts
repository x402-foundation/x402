import {
  Address,
  Data,
  EnterpriseAddress,
  PlutusV3,
  ScriptHash,
  UPLC,
} from "@evolution-sdk/evolution";

import {
  CARDANO_PREVIEW_CAIP2,
  getCardanoNetworkId,
  normalizeCardanoNetwork,
} from "../../constants";
import type { MasumiDeployment } from "../../types";
import { unwrapCborByteString } from "../../utils";
import { MAX_MASUMI_SCRIPT_HASH_CACHE_ENTRIES } from "../../limits";
import { MASUMI_VESTED_PAY_COMPILED_CODE } from "./blueprintCode";

/**
 * Derivation of the deployment-specific `vested_pay` escrow address.
 *
 * The validator parameters are baked into the script hash, so a different
 * parameterization is a different address — and a look-alike `vested_pay` with
 * different admins is a different trust domain. The verifier therefore derives
 * the address itself from the canonical compiled validator and requires it to
 * equal `payTo`; `payTo` is never defaulted or inferred.
 */

/** `SHA-256(JCS(blueprint))` of the pinned canonical blueprint document. */
export const MASUMI_BLUEPRINT_DIGEST =
  "6249de17bb87c5246106af6b0f33de22b44ca24b9c1445fa36d10eb8b583dec7";

/** CIP-57 validator title this scheme locks into. */
export const MASUMI_VALIDATOR_TITLE = "vested_pay.vested_pay.spend";

/** Scheme-level datum schema version for the escrow datum. */
export const MASUMI_DATUM_SCHEMA_VERSION = "masumi.vested_pay.v2";

/**
 * Canonical deployment parameters. Mainnet and Preprod default to these when
 * `extra.deployment` is absent; Preview has no canonical deployment and always
 * requires an explicit one.
 */
export const MASUMI_DEFAULT_DEPLOYMENT: MasumiDeployment = {
  requiredAdmins: "2",
  adminVkeys: [
    "fc16a1fcf309aed03ec18bb2176f5ea29acea70bb79145ebaffa8e75",
    "7f78161369549d8e2b138fee724c9fa606d6107a66720bdb4c48ada6",
    "89eef9ea84e0ee7fe4921fa93eb2873ff6e34473f751d5d52cb75aa6",
  ],
  cooldownPeriod: "420000",
};

/** Applying parameters + hashing is pure, so memoize it per parameterization. */
const scriptHashCache = new Map<string, string>();

/**
 * Resolves which deployment parameters apply to a payment.
 *
 * @param network - The x402 Cardano network identifier (or a CIP-34 alias).
 * @param declared - The `extra.deployment` block, when present.
 * @returns The deployment to apply, or `null` when the network has no canonical
 *   default and none was declared.
 */
export function resolveMasumiDeployment(
  network: string,
  declared: MasumiDeployment | undefined,
): MasumiDeployment | null {
  if (declared) return declared;
  return normalizeCardanoNetwork(network) === CARDANO_PREVIEW_CAIP2
    ? null
    : MASUMI_DEFAULT_DEPLOYMENT;
}

/**
 * Derives the escrow validator hash for a deployment by applying its three
 * parameters to the canonical compiled validator. Admin key order and
 * duplicates are preserved — a repeated key carries repeated voting weight and
 * changes the hash.
 *
 * @param deployment - The deployment parameters.
 * @returns The lowercase hex script hash.
 */
export function masumiEscrowScriptHash(deployment: MasumiDeployment): string {
  const cacheKey = `${deployment.requiredAdmins}|${deployment.adminVkeys.join(",")}|${deployment.cooldownPeriod}`;
  const cached = scriptHashCache.get(cacheKey);
  if (cached) return cached;

  const applied = UPLC.applyParamsToScript(MASUMI_VESTED_PAY_COMPILED_CODE, [
    Data.int(BigInt(deployment.requiredAdmins)),
    Data.list(deployment.adminVkeys.map(vkey => Data.bytearray(vkey))),
    Data.int(BigInt(deployment.cooldownPeriod)),
  ]);
  const script = new PlutusV3.PlutusV3({ bytes: unwrapCborByteString(applied) });
  const hash = ScriptHash.toHex(ScriptHash.fromScript(script)).toLowerCase();
  if (scriptHashCache.size >= MAX_MASUMI_SCRIPT_HASH_CACHE_ENTRIES) {
    const oldest = scriptHashCache.keys().next().value;
    if (oldest !== undefined) scriptHashCache.delete(oldest);
  }
  scriptHashCache.set(cacheKey, hash);
  return hash;
}

/**
 * Derives the bech32 escrow address for a deployment on a network.
 *
 * @param network - The x402 Cardano network identifier (or a CIP-34 alias).
 * @param deployment - The deployment parameters; defaults to the canonical set.
 * @returns The bech32 enterprise script address of the escrow.
 */
export function masumiEscrowAddress(
  network: string,
  deployment: MasumiDeployment = MASUMI_DEFAULT_DEPLOYMENT,
): string {
  const enterprise = new EnterpriseAddress.EnterpriseAddress({
    networkId: getCardanoNetworkId(network),
    paymentCredential: ScriptHash.fromHex(masumiEscrowScriptHash(deployment)),
  });
  return Address.toBech32(enterprise as unknown as Address.Address);
}
