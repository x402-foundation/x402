import type { Address } from "@solana/kit";

import type { FacilitatorSigningCapabilities, FacilitatorSvmSigner } from "../../signer";

/**
 * {@link FacilitatorSvmSigner} narrowed to the optional RPC caps the `upto`
 * facilitator requires at runtime. Exact-only signers omit the read methods.
 */
export type UptoFacilitatorSigner = FacilitatorSvmSigner & {
  getAccountInfo: NonNullable<FacilitatorSvmSigner["getAccountInfo"]>;
  getLatestBlockhash: NonNullable<FacilitatorSvmSigner["getLatestBlockhash"]>;
  getSlot: NonNullable<FacilitatorSvmSigner["getSlot"]>;
  getSigner(feePayer: Address): FacilitatorSigningCapabilities;
};

/**
 * Assert a facilitator signer exposes every optional cap `upto` needs.
 *
 * @param signer - Facilitator signer to validate
 * @param label - Scheme or component name for error messages
 * @throws Error when a required capability is missing
 */
export function assertUptoFacilitatorSigner(
  signer: FacilitatorSvmSigner,
  label = "UptoSvmScheme",
): asserts signer is UptoFacilitatorSigner {
  if (typeof signer.getSigner !== "function") {
    throw new Error(`${label} requires getSigner on the signer.`);
  }
  if (typeof signer.getAccountInfo !== "function") {
    throw new Error(`${label} requires getAccountInfo on the signer.`);
  }
  if (typeof signer.getLatestBlockhash !== "function") {
    throw new Error(`${label} requires getLatestBlockhash on the signer.`);
  }
  if (typeof signer.getSlot !== "function") {
    throw new Error(`${label} requires getSlot on the signer.`);
  }
}
