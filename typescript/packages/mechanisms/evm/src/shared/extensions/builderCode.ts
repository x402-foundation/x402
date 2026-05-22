import type {
  FacilitatorContext,
  FacilitatorExtension,
  PaymentPayload,
  PaymentRequirements,
} from "@x402/core/types";
import type { Hex } from "viem";

export const BUILDER_CODE_KEY = "builder-code" as const;

export interface DataSuffixContext {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

export interface BuilderCodeFacilitatorExtension extends FacilitatorExtension {
  key: typeof BUILDER_CODE_KEY;
  buildDataSuffix?(ctx: DataSuffixContext): Hex | undefined | Promise<Hex | undefined>;
}

type DataSuffixResolver = (
  context: FacilitatorContext,
  ctx: DataSuffixContext,
) => Promise<Hex | undefined>;

const BUILDER_CODE_RESOLVER: DataSuffixResolver = async (context, ctx) => {
  const ext = context.getExtension<BuilderCodeFacilitatorExtension>(BUILDER_CODE_KEY);
  if (!ext?.buildDataSuffix) {
    return undefined;
  }

  return ext.buildDataSuffix(ctx);
};

const DATA_SUFFIX_RESOLVERS: DataSuffixResolver[] = [BUILDER_CODE_RESOLVER];

/**
 * Resolves and concatenates data suffixes from registered extensions.
 *
 * @param context - Facilitator context with registered extensions
 * @param ctx - Data suffix context passed to extension resolvers
 * @returns Hex-encoded suffix to append to settlement calldata, or undefined if none
 */
export async function resolveDataSuffix(
  context: FacilitatorContext | undefined,
  ctx: DataSuffixContext,
): Promise<Hex | undefined> {
  if (!context) {
    return undefined;
  }

  const parts: Hex[] = [];
  for (const resolver of DATA_SUFFIX_RESOLVERS) {
    const suffix = await resolver(context, ctx);
    if (suffix && suffix !== "0x" && suffix.length > 2) {
      parts.push(suffix);
    }
  }

  if (parts.length === 0) {
    return undefined;
  }

  if (parts.length === 1) {
    return parts[0];
  }

  return parts.reduce((acc, part, index) => {
    if (index === 0) {
      return part;
    }
    const stripped = part.startsWith("0x") ? part.slice(2) : part;
    return `${acc}${stripped}` as Hex;
  });
}

/**
 * Appends a hex data suffix to encoded contract calldata.
 *
 * @param calldata - Base encoded function calldata
 * @param suffix - Optional hex suffix (with or without 0x prefix)
 * @returns Calldata with suffix appended, or the original calldata when suffix is empty
 */
export function appendDataSuffix(calldata: Hex, suffix?: Hex): Hex {
  if (!suffix || suffix === "0x" || suffix.length <= 2) {
    return calldata;
  }
  const suffixHex = suffix.startsWith("0x") ? suffix.slice(2) : suffix;
  return `${calldata}${suffixHex}` as Hex;
}
