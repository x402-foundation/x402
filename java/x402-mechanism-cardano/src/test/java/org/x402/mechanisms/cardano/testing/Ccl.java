package org.x402.mechanisms.cardano.testing;

import com.bloxbean.cardano.client.api.model.Amount;
import com.bloxbean.cardano.client.api.model.ProtocolParams;
import com.bloxbean.cardano.client.api.model.Utxo;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Builds cardano-client-lib values for tests. */
public final class Ccl {

  private Ccl() {}

  /** The preprod values the fixtures use: 4310 lovelace per UTxO byte, fee 44 · size + 155381. */
  public static final ProtocolParams PARAMS = params(4310, 44, 155381);

  /**
   * Protocol parameters with only the fee and min-UTxO values set.
   *
   * @param coinsPerUtxoByte lovelace per UTxO byte
   * @param minFeeA fee per byte
   * @param minFeeB constant fee
   * @return the parameters
   */
  public static ProtocolParams params(long coinsPerUtxoByte, long minFeeA, long minFeeB) {
    return ProtocolParams.builder()
        .coinsPerUtxoSize(Long.toString(coinsPerUtxoByte))
        .minFeeA(Math.toIntExact(minFeeA))
        .minFeeB(Math.toIntExact(minFeeB))
        .build();
  }

  /**
   * Protocol parameters from a fixture's {@code protocolParameters} values.
   *
   * @param coinsPerUtxoByte lovelace per UTxO byte
   * @param minFeeCoefficient fee per byte
   * @param minFeeConstant constant fee
   * @return the parameters
   */
  public static ProtocolParams params(
      BigInteger coinsPerUtxoByte, BigInteger minFeeCoefficient, BigInteger minFeeConstant) {
    return params(coinsPerUtxoByte.longValueExact(), minFeeCoefficient.longValueExact(),
        minFeeConstant.longValueExact());
  }

  /**
   * A wallet UTxO.
   *
   * @param txHash the producing transaction
   * @param index the output index
   * @param address the owner
   * @param coin lovelace
   * @param assets native assets keyed {@code policy.assetName}
   * @param referenceScript whether it carries a reference script
   * @return the UTxO
   */
  public static Utxo utxo(String txHash, long index, String address, BigInteger coin,
      Map<String, BigInteger> assets, boolean referenceScript) {
    List<Amount> amounts = new ArrayList<>();
    amounts.add(new Amount("lovelace", coin));
    if (assets != null) {
      assets.forEach((unit, qty) -> amounts.add(new Amount(unit.replace(".", ""), qty)));
    }
    return Utxo.builder()
        .txHash(txHash)
        .outputIndex(Math.toIntExact(index))
        .address(address)
        .amount(amounts)
        .referenceScriptHash(referenceScript ? "00".repeat(28) : null)
        .build();
  }
}
