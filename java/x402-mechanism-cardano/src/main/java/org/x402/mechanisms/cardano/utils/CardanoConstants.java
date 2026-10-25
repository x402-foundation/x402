package org.x402.mechanisms.cardano.utils;

import java.util.regex.Pattern;

/** Scheme constants, asset units and wire-form patterns. */
public final class CardanoConstants {

  /** The exact scheme. */
  public static final String SCHEME_EXACT = "exact";
  /** Native ADA, carried in an output's coin. */
  public static final String LOVELACE = "lovelace";
  /** Address-to-address transfer. */
  public static final String METHOD_DEFAULT = "default";
  /** Masumi escrow transfer. */
  public static final String METHOD_MASUMI = "masumi";
  /** Script transfer. */
  public static final String METHOD_SCRIPT = "script";

  /** USDM policy on mainnet. */
  public static final String USDM_MAINNET_POLICY_ID =
      "c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad";
  /** USDM policy on preprod. */
  public static final String USDM_PREPROD_POLICY_ID =
      "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9";
  /** USDM unit on mainnet. */
  public static final String USDM_MAINNET_ASSET = USDM_MAINNET_POLICY_ID + ".0014df105553444d";
  /** USDM unit on preprod. */
  public static final String USDM_PREPROD_ASSET = USDM_PREPROD_POLICY_ID + ".0014df10745553444d";
  /** USDM decimals. */
  public static final int USDM_DECIMALS = 6;

  /** Default {@code confirmationPolicy.l1Confirmations}. */
  public static final int DEFAULT_L1_CONFIRMATIONS = 1;
  /** Lowest accepted {@code l1Confirmations} (authenticated mempool acceptance). */
  public static final int MIN_L1_CONFIRMATIONS = -1;
  /** Highest accepted {@code l1Confirmations}. */
  public static final int MAX_L1_CONFIRMATIONS = 20;
  /** Constant overhead in the min-UTxO formula. */
  public static final int MIN_UTXO_OVERHEAD_BYTES = 160;

  /** Largest signed transaction decoded before consulting a node. */
  public static final int MAX_TRANSACTION_BYTES = 64 * 1024;
  /** Maximum transaction inputs resolved during verification. */
  public static final int MAX_TRANSACTION_INPUTS = 256;
  /** Largest inline Plutus script accepted from requirements. */
  public static final int MAX_SCRIPT_BYTES = 64 * 1024;
  /** Largest inline datum accepted from requirements. */
  public static final int MAX_DATUM_BYTES = 64 * 1024;
  /** Maximum parameters applied to a script. */
  public static final int MAX_SCRIPT_PARAMETERS = 64;
  /** Aggregate parameter input budget. */
  public static final int MAX_SCRIPT_PARAMETER_BYTES = 64 * 1024;

  /** Asset unit, any hex case. */
  public static final Pattern ASSET = Pattern.compile("^(lovelace|[0-9a-fA-F]{56}\\.[0-9a-fA-F]{0,64})$");
  /** Canonical asset unit: lowercase hex or {@code lovelace}. */
  public static final Pattern CANONICAL_ASSET = Pattern.compile("^(lovelace|[0-9a-f]{56}\\.[0-9a-f]{0,64})$");
  /** Positive canonical decimal integer. */
  public static final Pattern POSITIVE_CANONICAL_AMOUNT = Pattern.compile("^[1-9][0-9]*$");
  /** UTxO reference {@code txHash#index}. */
  public static final Pattern UTXO_REF = Pattern.compile("^[0-9a-fA-F]{64}#\\d+$");

  private CardanoConstants() {}
}
