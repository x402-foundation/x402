package org.x402.mechanisms.cardano.testing;

import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.common.model.Networks;
import com.bloxbean.cardano.client.crypto.Blake2bUtil;
import com.bloxbean.cardano.client.crypto.api.impl.EdDSASigningProvider;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import org.x402.mechanisms.cardano.utils.CardanoAddresses;
import org.x402.mechanisms.cardano.utils.Cbor;

/**
 * Builds small Conway transactions by hand (CBOR), signed with real Ed25519 keys, for decoder and
 * verification branch tests. Not a ledger-valid builder: it writes exactly what the test asks.
 */
public final class TxBuilder {

  /** A deterministic test wallet. */
  public static final Account WALLET =
      new Account(Networks.testnet(), "test walk nut penalty hip pave soap entry language right filter choice");

  private final List<byte[]> inputs = new ArrayList<>();
  private final List<byte[]> outputs = new ArrayList<>();
  private final TreeMap<Integer, byte[]> extraBody = new TreeMap<>();
  private final Map<Integer, byte[]> witnessFields = new LinkedHashMap<>();
  private byte[] auxiliaryData;
  private final List<Account> signers = new ArrayList<>();
  private final List<byte[][]> rawWitnesses = new ArrayList<>();
  private long fee = 200_000;
  private Long ttl;
  private Long validityStart;
  private Integer networkId;
  private Boolean isValid = Boolean.TRUE;
  private boolean inputsAsSet;

  /**
   * A new builder.
   *
   * @return the builder
   */
  public static TxBuilder create() {
    return new TxBuilder();
  }

  /**
   * Adds an input.
   *
   * @param txHashHex 32-byte hex
   * @param index the index
   * @return this builder
   */
  public TxBuilder input(String txHashHex, long index) {
    inputs.add(
        new Cbor.Writer().header(4, 2).bytes(HexFormat.of().parseHex(txHashHex)).header(0, index).toByteArray());
    return this;
  }

  /**
   * Wraps the inputs in a CBOR set tag (258).
   *
   * @return this builder
   */
  public TxBuilder inputsAsSet() {
    inputsAsSet = true;
    return this;
  }

  /**
   * Adds a map-form output.
   *
   * @param address bech32
   * @param coin lovelace
   * @param assets {@code policy.name} → quantity, may be empty
   * @param inlineDatum datum CBOR, or {@code null}
   * @param referenceScript whether to attach a (dummy) reference script
   * @return this builder
   */
  public TxBuilder output(
      String address, long coin, Map<String, Long> assets, byte[] inlineDatum, boolean referenceScript) {
    int fields = 2 + (inlineDatum != null ? 1 : 0) + (referenceScript ? 1 : 0);
    Cbor.Writer w = new Cbor.Writer().header(5, fields);
    w.header(0, 0).bytes(CardanoAddresses.toBytes(address));
    w.header(0, 1);
    value(w, coin, assets);
    if (inlineDatum != null) {
      w.header(0, 2).header(4, 2).header(0, 1).header(6, 24).bytes(inlineDatum);
    }
    if (referenceScript) {
      byte[] script = new Cbor.Writer().header(4, 2).header(0, 3).bytes(new byte[] {1, 2, 3}).toByteArray();
      w.header(0, 3).header(6, 24).bytes(script);
    }
    outputs.add(w.toByteArray());
    return this;
  }

  /**
   * Adds a legacy array-form output, optionally with a datum hash.
   *
   * @param address bech32
   * @param coin lovelace
   * @param datumHash 32-byte datum hash, or {@code null}
   * @return this builder
   */
  public TxBuilder legacyOutput(String address, long coin, byte[] datumHash) {
    Cbor.Writer w = new Cbor.Writer().header(4, datumHash == null ? 2 : 3).bytes(CardanoAddresses.toBytes(address));
    w.header(0, coin);
    if (datumHash != null) {
      w.bytes(datumHash);
    }
    outputs.add(w.toByteArray());
    return this;
  }

  /**
   * Adds a raw output encoding.
   *
   * @param cbor the output's CBOR
   * @return this builder
   */
  public TxBuilder rawOutput(byte[] cbor) {
    outputs.add(cbor);
    return this;
  }

  private static void value(Cbor.Writer w, long coin, Map<String, Long> assets) {
    if (assets == null || assets.isEmpty()) {
      w.header(0, coin);
      return;
    }
    Map<String, Map<String, Long>> byPolicy = new LinkedHashMap<>();
    assets.forEach(
        (unit, qty) -> {
          int dot = unit.indexOf('.');
          byPolicy.computeIfAbsent(unit.substring(0, dot), k -> new LinkedHashMap<>()).put(unit.substring(dot + 1), qty);
        });
    w.header(4, 2).header(0, coin).header(5, byPolicy.size());
    byPolicy.forEach(
        (policy, names) -> {
          w.bytes(HexFormat.of().parseHex(policy)).header(5, names.size());
          names.forEach((name, qty) -> w.bytes(HexFormat.of().parseHex(name)).header(0, qty));
        });
  }

  /**
   * Sets the fee.
   *
   * @param fee lovelace
   * @return this builder
   */
  public TxBuilder fee(long fee) {
    this.fee = fee;
    return this;
  }

  /**
   * Sets the TTL.
   *
   * @param ttl slot
   * @return this builder
   */
  public TxBuilder ttl(Long ttl) {
    this.ttl = ttl;
    return this;
  }

  /**
   * Sets the validity start.
   *
   * @param slot slot
   * @return this builder
   */
  public TxBuilder validityStart(Long slot) {
    this.validityStart = slot;
    return this;
  }

  /**
   * Sets the body network id.
   *
   * @param id the id
   * @return this builder
   */
  public TxBuilder networkId(Integer id) {
    this.networkId = id;
    return this;
  }

  /**
   * Adds a raw body field (e.g. 9 = mint, 5 = withdrawals, 4 = certificates).
   *
   * @param key the body key
   * @param cbor the value's CBOR
   * @return this builder
   */
  public TxBuilder bodyField(int key, byte[] cbor) {
    extraBody.put(key, cbor);
    return this;
  }

  /**
   * Adds a raw witness-set field.
   *
   * @param key the witness-set key
   * @param cbor the value's CBOR
   * @return this builder
   */
  public TxBuilder witnessField(int key, byte[] cbor) {
    witnessFields.put(key, cbor);
    return this;
  }

  /**
   * Signs with an account's payment key.
   *
   * @param account the account
   * @return this builder
   */
  public TxBuilder signWith(Account account) {
    signers.add(account);
    return this;
  }

  /**
   * Adds a vkey witness verbatim (for invalid signatures).
   *
   * @param vkey the key
   * @param signature the signature
   * @return this builder
   */
  public TxBuilder rawWitness(byte[] vkey, byte[] signature) {
    rawWitnesses.add(new byte[][] {vkey, signature});
    return this;
  }

  /**
   * Sets the raw auxiliary data (the fourth element); {@code null} writes CBOR null as before.
   *
   * @param cbor the encoded auxiliary data
   * @return this builder
   */
  public TxBuilder auxiliaryData(byte[] cbor) {
    this.auxiliaryData = cbor;
    return this;
  }

  /**
   * Sets the ledger is_valid flag; {@code null} writes a 3-element (pre-Alonzo) envelope.
   *
   * @param valid the flag
   * @return this builder
   */
  public TxBuilder isValid(Boolean valid) {
    this.isValid = valid;
    return this;
  }

  /**
   * The body bytes.
   *
   * @return CBOR
   */
  public byte[] body() {
    TreeMap<Integer, byte[]> fields = new TreeMap<>(extraBody);
    Cbor.Writer in = new Cbor.Writer();
    if (inputsAsSet) {
      in.header(6, 258);
    }
    in.header(4, inputs.size());
    inputs.forEach(in::raw);
    fields.put(0, in.toByteArray());
    Cbor.Writer out = new Cbor.Writer().header(4, outputs.size());
    outputs.forEach(out::raw);
    fields.put(1, out.toByteArray());
    fields.put(2, new Cbor.Writer().header(0, fee).toByteArray());
    if (ttl != null) {
      fields.put(3, new Cbor.Writer().header(0, ttl).toByteArray());
    }
    if (validityStart != null) {
      fields.put(8, new Cbor.Writer().header(0, validityStart).toByteArray());
    }
    if (networkId != null) {
      fields.put(15, new Cbor.Writer().header(0, networkId).toByteArray());
    }
    Cbor.Writer body = new Cbor.Writer().header(5, fields.size());
    fields.forEach((k, v) -> body.header(0, k).raw(v));
    return body.toByteArray();
  }

  /**
   * The transaction id.
   *
   * @return lowercase hex
   */
  public String txHash() {
    return HexFormat.of().formatHex(Blake2bUtil.blake2bHash256(body()));
  }

  /**
   * Builds the signed transaction.
   *
   * @return base64 CBOR
   */
  public String build() {
    byte[] body = body();
    byte[] hash = Blake2bUtil.blake2bHash256(body);
    List<byte[][]> witnesses = new ArrayList<>(rawWitnesses);
    EdDSASigningProvider ed = new EdDSASigningProvider();
    for (Account a : signers) {
      witnesses.add(new byte[][] {a.publicKeyBytes(), ed.signExtended(hash, a.privateKeyBytes(), a.publicKeyBytes())});
    }
    Map<Integer, byte[]> ws = new TreeMap<>(witnessFields);
    if (!witnesses.isEmpty()) {
      Cbor.Writer vk = new Cbor.Writer().header(4, witnesses.size());
      for (byte[][] wit : witnesses) {
        vk.header(4, 2).bytes(wit[0]).bytes(wit[1]);
      }
      ws.put(0, vk.toByteArray());
    }
    Cbor.Writer wsw = new Cbor.Writer().header(5, ws.size());
    ws.forEach((k, v) -> wsw.header(0, k).raw(v));
    Cbor.Writer tx = new Cbor.Writer().header(4, isValid == null ? 3 : 4).raw(body).raw(wsw.toByteArray());
    if (isValid != null) {
      tx.raw(isValid ? 0xf5 : 0xf4);
    }
    if (auxiliaryData == null) {
      tx.raw(0xf6);
    } else {
      tx.raw(auxiliaryData);
    }
    return Base64.getEncoder().encodeToString(tx.toByteArray());
  }

  /**
   * A dummy 28-byte script / policy hash.
   *
   * @param b the byte to repeat
   * @return hex
   */
  public static String hash28(int b) {
    return String.format("%02x", b).repeat(28);
  }

  /**
   * A dummy 32-byte transaction hash.
   *
   * @param b the byte to repeat
   * @return hex
   */
  public static String hash32(int b) {
    return String.format("%02x", b).repeat(32);
  }

  /**
   * The wallet's base address.
   *
   * @return bech32
   */
  public static String walletAddress() {
    return WALLET.baseAddress();
  }

  /**
   * An unsigned integer CBOR helper for raw fields.
   *
   * @param v the value
   * @return CBOR
   */
  public static byte[] uint(long v) {
    return new Cbor.Writer().header(0, BigInteger.valueOf(v)).toByteArray();
  }
}
