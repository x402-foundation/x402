import { Data, InlineDatum } from "@evolution-sdk/evolution";

import type { CardanoExtraScript } from "../../types";
import { MAX_CARDANO_DATUM_BYTES } from "../../limits";

/**
 * Builds the inline datum a script payment attaches to its `payTo` output from
 * the script `extra`. The datum is the server-supplied CBOR hex
 * (`extra.datum`), decoded and wrapped as an inline datum so the funds land at
 * the contract with the datum it expects.
 *
 * Unlike the Masumi lock datum (a fixed 19-field escrow shape this package
 * builds), a script datum is arbitrary and contract-specific — the server that
 * defined the contract supplies it verbatim and owns its correctness. This
 * helper only parses it; the facilitator does not verify its contents.
 *
 * @param extra - The script `extra` block from the payment requirements.
 * @returns The inline datum for the `payTo` output, or `undefined` when the
 *   script needs no datum (`extra.datum` omitted).
 * @throws When `extra.datum` is present but not non-empty CBOR hex.
 */
export function buildScriptDatumInline(
  extra: CardanoExtraScript,
): InlineDatum.InlineDatum | undefined {
  if (extra.datum === undefined) {
    return undefined;
  }
  if (
    typeof extra.datum !== "string" ||
    extra.datum.length === 0 ||
    extra.datum.length % 2 !== 0 ||
    extra.datum.length / 2 > MAX_CARDANO_DATUM_BYTES
  ) {
    throw new Error('Cardano script payment "datum" must be non-empty CBOR hex');
  }
  let data: Data.Data;
  try {
    data = Data.fromCBORHex(extra.datum);
  } catch (cause) {
    throw new Error('Cardano script payment "datum" is not valid CBOR hex', { cause });
  }
  return new InlineDatum.InlineDatum({ data });
}
