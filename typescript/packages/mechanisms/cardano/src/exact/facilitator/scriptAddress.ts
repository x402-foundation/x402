import {
  Address,
  Data,
  PlutusV1,
  PlutusV2,
  PlutusV3,
  ScriptHash,
  UPLC,
} from "@evolution-sdk/evolution";

import type {
  CardanoExtraScript,
  CardanoScriptDescriptor,
  CardanoScriptParameter,
} from "../../types";
import { unwrapCborByteString } from "../../utils";
import {
  MAX_CARDANO_SCRIPT_BYTES,
  MAX_CARDANO_SCRIPT_PARAMETERS,
  MAX_CARDANO_SCRIPT_PARAMETER_BYTES,
} from "../../limits";

const SCRIPT_HASH_REGEX = /^[0-9a-f]{56}$/;
const EVEN_HEX_REGEX = /^(?:[0-9a-f]{2})+$/;

/**
 * Reconstructs the script payment-credential (script hash) implied by a script
 * `extra` block and verifies it matches the script credential of `payTo`.
 *
 * This implements the Cardano spec's script `assetTransferMethod` requirement:
 * "the address should match the script provided in extra after applying
 * parameters … so that the server can reconstruct the script address and verify
 * the payment". When `script.code` is supplied the hash is derived offline by
 * applying the declared parameters and hashing the result; when only
 * `scriptHash` is supplied it is compared directly.
 *
 * @param extra - The script `extra` block from the payment requirements.
 * @param payTo - The recipient address declared in the payment requirements.
 * @returns True when `payTo` is a script address whose credential matches.
 */
export function scriptAddressMatches(extra: CardanoExtraScript, payTo: string): boolean {
  const credential = scriptPaymentCredentialHex(payTo);
  if (credential === null) {
    return false;
  }
  let expected: string;
  try {
    expected = deriveScriptHashHex(extra);
  } catch {
    return false;
  }
  return credential === expected;
}

/**
 * Returns the script payment-credential hash of `payTo` (lowercase hex), or
 * `null` when the address has a key (non-script) payment credential or cannot
 * be parsed.
 *
 * @param payTo - A bech32 Cardano address.
 * @returns The script credential hash hex, or `null`.
 */
function scriptPaymentCredentialHex(payTo: string): string | null {
  let credential: { _tag?: string };
  try {
    credential = (Address.fromBech32(payTo) as { paymentCredential?: { _tag?: string } })
      .paymentCredential as { _tag?: string };
  } catch {
    return null;
  }
  if (!credential || credential._tag !== "ScriptHash") {
    return null;
  }
  return ScriptHash.toHex(credential as ScriptHash.ScriptHash).toLowerCase();
}

/**
 * Derives the script hash (lowercase hex) declared by a script `extra` block.
 * Prefers reconstructing from `script.code` (+ parameters); falls back to the
 * supplied `scriptHash` when no inline script is present.
 *
 * @param extra - The script `extra` block.
 * @returns The derived script hash hex.
 * @throws When neither `script` nor `scriptHash` is usable.
 */
export function deriveScriptHashHex(extra: CardanoExtraScript): string {
  if (extra.script?.code) {
    if (
      !EVEN_HEX_REGEX.test(extra.script.code) ||
      extra.script.code.length / 2 > MAX_CARDANO_SCRIPT_BYTES
    ) {
      throw new Error("Cardano script code is invalid or exceeds the byte limit");
    }
    const entries = extra.parameters ? Object.entries(extra.parameters) : [];
    if (entries.length > MAX_CARDANO_SCRIPT_PARAMETERS) {
      throw new Error("Cardano script has too many parameters");
    }
    let parameterBytes = 0;
    const params = entries.map(([name, parameter]) => {
      parameterBytes += Buffer.byteLength(name, "utf8") + parameterInputBytes(parameter);
      if (parameterBytes > MAX_CARDANO_SCRIPT_PARAMETER_BYTES) {
        throw new Error("Cardano script parameters exceed the byte limit");
      }
      return toPlutusData(parameter);
    });
    const applied = UPLC.applyParamsToScript(extra.script.code, params);
    const raw = unwrapCborByteString(applied);
    const script = makePlutusScript(extra.script.type, raw);
    return ScriptHash.toHex(ScriptHash.fromScript(script)).toLowerCase();
  }
  if (extra.scriptHash) {
    if (!SCRIPT_HASH_REGEX.test(extra.scriptHash)) {
      throw new Error("Cardano scriptHash must be 28-byte lowercase hex");
    }
    return extra.scriptHash.toLowerCase();
  }
  throw new Error("Cardano script payment requires either `script` or `scriptHash`");
}

/**
 * Measures one scalar parameter before conversion allocates Plutus data.
 *
 * @param param - Declared script parameter.
 * @returns Approximate source bytes consumed by the value.
 */
function parameterInputBytes(param: CardanoScriptParameter): number {
  if (!param || typeof param !== "object") {
    throw new Error("Cardano script parameter must be an object");
  }
  switch (param.type) {
    case "bytes": {
      if (typeof param.value !== "string" || !/^(?:[0-9a-f]{2})*$/.test(param.value)) {
        throw new Error("Cardano bytes parameter must be lowercase even-length hex");
      }
      return param.value.length / 2;
    }
    case "string":
      if (typeof param.value !== "string") {
        throw new Error("Cardano string parameter must carry a string");
      }
      return Buffer.byteLength(param.value, "utf8");
    case "bigint":
    case "integer": {
      const value = param.value;
      if (typeof value === "number" && !Number.isSafeInteger(value)) {
        throw new Error("Cardano integer parameter must be a safe integer");
      }
      if (
        typeof value !== "bigint" &&
        typeof value !== "number" &&
        (typeof value !== "string" || !/^(?:0|[1-9]\d*|-[1-9]\d*)$/.test(value))
      ) {
        throw new Error("Cardano integer parameter must use canonical decimal syntax");
      }
      const digits = String(value).replace(/^-/, "");
      if (digits.length > 128) {
        throw new Error("Cardano integer parameter exceeds the digit limit");
      }
      return digits.length;
    }
    case "boolean":
      if (typeof param.value !== "boolean") {
        throw new Error("Cardano boolean parameter must carry a boolean");
      }
      return 1;
    default:
      throw new Error(`Unsupported Cardano script parameter type: ${param.type}`);
  }
}

/**
 * Converts a typed script parameter into Plutus `Data`. Only the scalar types
 * the reference signer emits are supported; nested constr/list/map parameters
 * must be handled by a subclass override.
 *
 * @param param - The script parameter descriptor.
 * @returns The Plutus data encoding.
 */
function toPlutusData(param: CardanoScriptParameter): Data.Data {
  switch (param.type) {
    case "bytes":
      return Data.bytearray(param.value as string);
    case "string":
      return Data.bytearray(Buffer.from(param.value as string, "utf8").toString("hex"));
    case "bigint":
    case "integer":
      return Data.int(BigInt(param.value as string | number | bigint));
    case "boolean":
      return Data.constr(param.value ? 1n : 0n, []);
    default:
      throw new Error(`Unsupported Cardano script parameter type: ${param.type}`);
  }
}

/**
 * Builds an Evolution SDK Plutus script of the declared version from raw
 * (unwrapped) script bytes.
 *
 * @param type - The Plutus language version.
 * @param bytes - The raw flat-encoded script bytes.
 * @returns The script instance.
 */
function makePlutusScript(
  type: CardanoScriptDescriptor["type"],
  bytes: Uint8Array,
): PlutusV1.PlutusV1 | PlutusV2.PlutusV2 | PlutusV3.PlutusV3 {
  switch (type) {
    case "plutusV1":
      return new PlutusV1.PlutusV1({ bytes });
    case "plutusV2":
      return new PlutusV2.PlutusV2({ bytes });
    case "plutusV3":
      return new PlutusV3.PlutusV3({ bytes });
  }
}
