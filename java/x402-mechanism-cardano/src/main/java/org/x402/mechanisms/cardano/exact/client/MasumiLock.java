package org.x402.mechanisms.cardano.exact.client;

import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import java.math.BigInteger;
import java.util.Locale;
import org.x402.mechanisms.cardano.utils.CardanoConstants;
import org.x402.mechanisms.cardano.utils.PlutusEncoding;
import org.x402.mechanisms.cardano.exact.masumi.MasumiConstants;
import org.x402.mechanisms.cardano.exact.masumi.MasumiDatum;
import org.x402.mechanisms.cardano.exact.masumi.MasumiExtra;
import org.x402.mechanisms.cardano.exact.masumi.MasumiTerms;

/**
 * Builds the Masumi {@code vested_pay} lock: the 19-field datum
 * and the lovelace the escrow output must carry. The client derives {@code
 * collateral_return_lovelace} so the escrow still clears min-UTxO after {@code SubmitResult}.
 */
public final class MasumiLock {

  private static final int COLLATERAL_FIXED_POINT_ROUNDS = 4;

  private MasumiLock() {}

  /**
   * A built lock.
   *
   * @param datum the inline datum
   * @param collateralLovelace datum {@code collateral_return_lovelace}
   * @param lockedLovelace escrow lovelace: {@code requestedLovelace + collateral}
   */
  public record Lock(PlutusData datum, BigInteger collateralLovelace, BigInteger lockedLovelace) {}

  /**
   * Builds the lock.
   *
   * @param extra the validated Masumi extra
   * @param buyerAddress the payer wallet address (datum {@code buyer})
   * @param asset the requested asset unit
   * @param amount the requested amount
   * @param coinsPerUtxoByte the live protocol parameter
   * @param buyerInput buyer-side datum input
   * @return the lock
   * @throws IllegalStateException when the collateral does not converge
   */
  public static Lock build(
      MasumiExtra extra,
      String buyerAddress,
      String asset,
      BigInteger amount,
      BigInteger coinsPerUtxoByte,
      MasumiBuyerInput buyerInput) {
    boolean isLovelace = CardanoConstants.LOVELACE.equals(asset.toLowerCase(Locale.ROOT));
    BigInteger requestedLovelace = isLovelace ? amount : BigInteger.ZERO;
    int nativeTokenCount = isLovelace ? 0 : 1;
    String buyerReturn = buyerInput == null ? null : buyerInput.buyerReturnAddress();

    BigInteger collateral = BigInteger.ZERO;
    PlutusData datum = datum(extra, buyerAddress, buyerReturn, collateral);
    boolean converged = false;
    for (int round = 0; round < COLLATERAL_FIXED_POINT_ROUNDS; round++) {
      BigInteger needed =
          MasumiConstants.collateralLovelace(requestedLovelace, PlutusEncoding.encode(datum).length, nativeTokenCount, coinsPerUtxoByte);
      if (needed.compareTo(collateral) <= 0) {
        converged = true;
        break;
      }
      collateral = needed;
      datum = datum(extra, buyerAddress, buyerReturn, collateral);
    }
    if (!converged) {
      throw new IllegalStateException("Masumi collateral did not converge; refusing to build an unspendable lock");
    }
    return new Lock(datum, collateral, requestedLovelace.add(collateral));
  }

  private static PlutusData datum(MasumiExtra extra, String buyer, String buyerReturn, BigInteger collateral) {
    MasumiTerms terms = extra.terms();
    return MasumiDatum.build(
        new MasumiDatum.LockInput(
            buyer,
            terms.sellerAddress(),
            buyerReturn,
            terms.sellerReturnAddress(),
            extra.referenceKey(),
            extra.referenceSignature(),
            terms.sellerNonce(),
            terms.buyerNonce(),
            terms.agentIdentifierOrEmpty(),
            collateral,
            terms.inputHash(),
            new BigInteger(terms.payByTime()),
            new BigInteger(terms.submitResultTime()),
            new BigInteger(terms.unlockTime()),
            new BigInteger(terms.externalDisputeUnlockTime())));
  }
}
