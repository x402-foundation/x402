/**
 * Vendored from
 * https://github.com/solana-foundation/payment-channel/blob/main/clients/typescript/src/generated/pdas/eventAuthority.ts
 */

import {
  type Address,
  getProgramDerivedAddress,
  getUtf8Encoder,
  type ProgramDerivedAddress,
} from "@solana/kit";

/**
 *
 * @param config
 * @param config.programAddress
 */
export async function findEventAuthorityPda(
  config: { programAddress?: Address | undefined } = {},
): Promise<ProgramDerivedAddress> {
  const {
    programAddress = "CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX" as Address<"CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX">,
  } = config;
  return await getProgramDerivedAddress({
    programAddress,
    seeds: [getUtf8Encoder().encode("event_authority")],
  });
}
