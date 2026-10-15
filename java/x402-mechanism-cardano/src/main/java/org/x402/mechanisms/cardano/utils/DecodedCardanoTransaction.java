package org.x402.mechanisms.cardano.utils;

import java.math.BigInteger;
import java.util.List;
import java.util.Map;

/**
 * The structural view of a signed transaction that verification needs.
 *
 * @param txHash lowercase hex blake2b-256 of the body's wire bytes
 * @param networkId body {@code network_id}, or {@code null} when absent
 * @param ttlSlot TTL slot, or {@code null} when absent
 * @param validityStartSlot validity start slot, or {@code null} when absent
 * @param inputs inputs as lowercase {@code txHash#index}, in body order
 * @param fee the fee in lovelace
 * @param sizeBytes byte length of the complete signed transaction
 * @param balanceChangingOperations body fields that move value outside inputs and outputs
 * @param outputs outputs in body order
 * @param vkeyWitnessCount vkey plus bootstrap witnesses
 * @param vkeyHashes blake2b-224 of each vkey witness key
 * @param scriptWitnessCount native and Plutus scripts plus redeemers
 * @param redeemerCount Plutus redeemers
 * @param signaturesValid whether every vkey witness verifies over the body hash
 * @param isValid the ledger {@code is_valid} flag
 * @param bodyKeys the transaction body's field keys, ascending
 * @param requiredSigners lowercase hex key hashes of body field 14 ({@code required_signers})
 */
public record DecodedCardanoTransaction(
    String txHash,
    Integer networkId,
    BigInteger ttlSlot,
    BigInteger validityStartSlot,
    List<String> inputs,
    BigInteger fee,
    int sizeBytes,
    List<String> balanceChangingOperations,
    List<Output> outputs,
    int vkeyWitnessCount,
    List<String> vkeyHashes,
    int scriptWitnessCount,
    int redeemerCount,
    boolean signaturesValid,
    boolean isValid,
    List<Integer> bodyKeys,
    List<String> requiredSigners) {

  /** Copies the lists. */
  public DecodedCardanoTransaction {
    inputs = List.copyOf(inputs);
    balanceChangingOperations = List.copyOf(balanceChangingOperations);
    outputs = List.copyOf(outputs);
    vkeyHashes = List.copyOf(vkeyHashes);
    bodyKeys = List.copyOf(bodyKeys);
    requiredSigners = List.copyOf(requiredSigners);
  }

  /**
   * A view without body keys or required signers.
   *
   * @param txHash see the record
   * @param networkId see the record
   * @param ttlSlot see the record
   * @param validityStartSlot see the record
   * @param inputs see the record
   * @param fee see the record
   * @param sizeBytes see the record
   * @param balanceChangingOperations see the record
   * @param outputs see the record
   * @param vkeyWitnessCount see the record
   * @param vkeyHashes see the record
   * @param scriptWitnessCount see the record
   * @param redeemerCount see the record
   * @param signaturesValid see the record
   * @param isValid see the record
   */
  public DecodedCardanoTransaction(
      String txHash,
      Integer networkId,
      BigInteger ttlSlot,
      BigInteger validityStartSlot,
      List<String> inputs,
      BigInteger fee,
      int sizeBytes,
      List<String> balanceChangingOperations,
      List<Output> outputs,
      int vkeyWitnessCount,
      List<String> vkeyHashes,
      int scriptWitnessCount,
      int redeemerCount,
      boolean signaturesValid,
      boolean isValid) {
    this(txHash, networkId, ttlSlot, validityStartSlot, inputs, fee, sizeBytes, balanceChangingOperations,
        outputs, vkeyWitnessCount, vkeyHashes, scriptWitnessCount, redeemerCount, signaturesValid, isValid,
        List.of(), List.of());
  }

  /**
   * One transaction output.
   *
   * @param address bech32 address
   * @param coin lovelace
   * @param assets native assets keyed by lowercase {@code policy.assetNameHex}
   * @param datum lowercase CBOR hex of an inline datum (wire bytes), else {@code null}
   * @param serializedSize byte length of the output's wire encoding
   * @param hasReferenceScript whether the output carries a reference script
   * @param hasDatumHash whether the output carries a datum hash (rather than an inline datum)
   */
  public record Output(
      String address,
      BigInteger coin,
      Map<String, BigInteger> assets,
      String datum,
      int serializedSize,
      boolean hasReferenceScript,
      boolean hasDatumHash) {

    /** Copies the asset map. */
    public Output {
      assets = java.util.Collections.unmodifiableMap(new java.util.LinkedHashMap<>(assets));
    }

    /**
     * An output without a datum hash.
     *
     * @param address see the record
     * @param coin see the record
     * @param assets see the record
     * @param datum see the record
     * @param serializedSize see the record
     * @param hasReferenceScript see the record
     */
    public Output(String address, BigInteger coin, Map<String, BigInteger> assets, String datum,
        int serializedSize, boolean hasReferenceScript) {
      this(address, coin, assets, datum, serializedSize, hasReferenceScript, false);
    }
  }
}
