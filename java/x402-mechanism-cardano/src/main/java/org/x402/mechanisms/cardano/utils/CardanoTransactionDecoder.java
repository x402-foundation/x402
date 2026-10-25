package org.x402.mechanisms.cardano.utils;

import com.bloxbean.cardano.client.crypto.Blake2bUtil;
import com.bloxbean.cardano.client.crypto.api.impl.EdDSASigningProvider;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Decodes a base64 signed Cardano transaction. Everything
 * is read from the wire bytes: the transaction id hashes the body's exact bytes and output sizes
 * are the bytes the ledger sees. Only an inline datum is reported re-encoded, in the canonical
 * form the TypeScript decoder reports ({@link PlutusEncoding#canonical}).
 */
public final class CardanoTransactionDecoder {

  private static final EdDSASigningProvider ED25519 = new EdDSASigningProvider();
  private static final HexFormat HEX = HexFormat.of();

  private CardanoTransactionDecoder() {}

  /**
   * Strictly decodes canonical padded base64 within the 64 KiB budget.
   *
   * @param transactionBase64 the transaction
   * @return the bytes
   * @throws IllegalArgumentException when oversized or not canonical base64
   */
  public static byte[] transactionBytes(String transactionBase64) {
    if (transactionBase64 == null
        || transactionBase64.isEmpty()
        || transactionBase64.length() > maxBase64Length()) {
      throw new IllegalArgumentException("Cardano transaction exceeds the decode limit");
    }
    byte[] decoded;
    try {
      decoded = Base64.getDecoder().decode(transactionBase64);
    } catch (IllegalArgumentException e) {
      throw new IllegalArgumentException("Cardano transaction must use canonical padded base64", e);
    }
    if (decoded.length == 0
        || decoded.length > CardanoConstants.MAX_TRANSACTION_BYTES
        || !Base64.getEncoder().encodeToString(decoded).equals(transactionBase64)) {
      throw new IllegalArgumentException("Cardano transaction must use canonical padded base64");
    }
    return decoded;
  }

  /**
   * The longest base64 text a 64 KiB transaction can have.
   *
   * @return {@code ceil(65536 / 3) * 4}
   */
  public static int maxBase64Length() {
    return (CardanoConstants.MAX_TRANSACTION_BYTES + 2) / 3 * 4;
  }

  /**
   * Decodes a base64 transaction.
   *
   * @param transactionBase64 the transaction
   * @return the decoded view
   * @throws IllegalArgumentException when it is not a well-formed transaction
   */
  public static DecodedCardanoTransaction decode(String transactionBase64) {
    byte[] raw = transactionBytes(transactionBase64);
    Cbor.Item tx = Cbor.decode(raw);
    if (tx.major() != Cbor.Major.ARRAY || tx.items().size() != 4) {
      // Only the 4-element [body, witnessSet, isValid, auxiliaryData] form is accepted.
      throw new IllegalArgumentException("transaction must be a 4-element array");
    }
    Cbor.Item body = tx.items().get(0);
    Cbor.Item witnessSet = tx.items().get(1);
    if (body.major() != Cbor.Major.MAP || witnessSet.major() != Cbor.Major.MAP) {
      throw new IllegalArgumentException("transaction body and witness set must be maps");
    }
    // Readers disagree on which duplicate entry wins; refuse rather than guess.
    body.requireUniqueKeys("transaction body");
    witnessSet.requireUniqueKeys("witness set");
    Cbor.Item flag = tx.items().get(2);
    if (!flag.isSimple(20) && !flag.isSimple(21)) {
      throw new IllegalArgumentException("is_valid must be a boolean");
    }
    boolean isValid = flag.isSimple(21);
    List<Integer> bodyKeys = bodyKeys(body);
    checkAuxiliaryData(body.get(7), tx.items().get(3));

    byte[] bodyHash = Blake2bUtil.blake2bHash256(body.raw());
    List<String> inputs = inputs(body.get(0));
    List<DecodedCardanoTransaction.Output> outputs = outputs(body.get(1));
    BigInteger fee = unsigned(body.get(2), "fee");

    List<String> balanceChanging = new ArrayList<>();
    if (body.get(9) != null) {
      balanceChanging.add("mint");
    }
    if (body.get(5) != null) {
      balanceChanging.add("withdrawals");
    }
    if (body.get(4) != null) {
      balanceChanging.add("certificates");
    }
    if (body.get(20) != null) {
      balanceChanging.add("proposalProcedures");
    }
    if (body.get(22) != null) {
      balanceChanging.add("donation");
    }

    Integer networkId = null;
    if (body.get(15) != null) {
      networkId = unsigned(body.get(15), "network id").intValueExact();
    }

    Witnesses w = witnesses(witnessSet, bodyHash);
    return new DecodedCardanoTransaction(
        HEX.formatHex(bodyHash),
        networkId,
        optionalUnsigned(body.get(3), "ttl"),
        optionalUnsigned(body.get(8), "validity start"),
        inputs,
        fee,
        raw.length,
        balanceChanging,
        outputs,
        w.vkeyCount,
        w.vkeyHashes,
        w.scriptCount,
        w.redeemerCount,
        w.signaturesValid,
        isValid,
        bodyKeys,
        requiredSigners(body.get(14)));
  }

  /**
   * The body's keys. Each must be a plain unsigned integer: a tagged or otherwise encoded key is
   * not found by a lookup, so a field behind it would escape every check.
   */
  private static List<Integer> bodyKeys(Cbor.Item body) {
    List<Integer> keys = new ArrayList<>();
    for (Map.Entry<Cbor.Item, Cbor.Item> entry : body.entries()) {
      Cbor.Item key = entry.getKey();
      if (key.major() != Cbor.Major.UNSIGNED || key.integer().bitLength() > 31) {
        throw new IllegalArgumentException("transaction body keys must be unsigned integers");
      }
      keys.add(key.integer().intValue());
    }
    keys.sort(null);
    return keys;
  }

  private static List<String> requiredSigners(Cbor.Item item) {
    List<String> signers = new ArrayList<>();
    if (item == null) {
      return signers;
    }
    for (Cbor.Item signer : array(item, "required signers")) {
      if (signer.major() != Cbor.Major.BYTES || signer.bytes().length != 28) {
        throw new IllegalArgumentException("a required signer must be a 28-byte key hash");
      }
      signers.add(HEX.formatHex(signer.bytes()));
    }
    return signers;
  }

  /** How deeply metadata may nest. */
  private static final int MAX_METADATA_DEPTH = 64;

  /** The largest metadata byte or text string. */
  private static final int MAX_METADATA_STRING = 64;

  /**
   * Auxiliary data and its body commitment (field 7) come together: the commitment is untagged
   * bytes(32) equal to the blake2b-256 of the auxiliary data's exact wire bytes. Only metadata is
   * accepted, either as a plain map or as a tag 259 map holding only field 0; auxiliary scripts are
   * refused.
   */
  private static void checkAuxiliaryData(Cbor.Item commitment, Cbor.Item auxiliary) {
    boolean present = !auxiliary.isSimple(22);
    if (commitment == null && !present) {
      return;
    }
    if (commitment == null || !present) {
      throw new IllegalArgumentException("auxiliary data and its hash must both be present");
    }
    if (commitment.major() != Cbor.Major.BYTES || commitment.bytes().length != 32) {
      throw new IllegalArgumentException("the auxiliary data hash must be 32 bytes");
    }
    if (!java.security.MessageDigest.isEqual(commitment.bytes(), Blake2bUtil.blake2bHash256(auxiliary.raw()))) {
      throw new IllegalArgumentException("auxiliary data hash mismatch");
    }
    Cbor.Item metadata = auxiliary;
    if (metadata.major() == Cbor.Major.TAG) {
      Cbor.Item fields = metadata.tagged();
      if (!metadata.integer().equals(BigInteger.valueOf(259)) || fields.major() != Cbor.Major.MAP) {
        throw new IllegalArgumentException("unsupported auxiliary data envelope");
      }
      fields.requireUniqueKeys("auxiliary data");
      Cbor.Item inner = fields.get(0);
      if (fields.entries().size() != 1 || inner == null) {
        throw new IllegalArgumentException("auxiliary data may carry metadata only");
      }
      metadata = inner;
    }
    if (metadata.major() != Cbor.Major.MAP) {
      throw new IllegalArgumentException("unsupported auxiliary data envelope");
    }
    metadata.requireUniqueKeys("metadata");
    for (Map.Entry<Cbor.Item, Cbor.Item> entry : metadata.entries()) {
      Cbor.Item label = entry.getKey();
      if (label.major() != Cbor.Major.UNSIGNED || label.integer().bitLength() > 64) {
        throw new IllegalArgumentException("invalid metadata label");
      }
      checkMetadatum(entry.getValue(), 0);
    }
  }

  private static void checkMetadatum(Cbor.Item item, int depth) {
    if (depth > MAX_METADATA_DEPTH) {
      throw new IllegalArgumentException("metadata nests too deeply");
    }
    switch (item.major()) {
      case UNSIGNED, NEGATIVE -> {
        // Plain CBOR integers span exactly the metadata range; big-number tags are refused below.
      }
      case BYTES -> {
        if (item.bytes().length > MAX_METADATA_STRING) {
          throw new IllegalArgumentException("metadata bytes exceed 64 bytes");
        }
      }
      case TEXT -> {
        if (item.text().getBytes(java.nio.charset.StandardCharsets.UTF_8).length > MAX_METADATA_STRING) {
          throw new IllegalArgumentException("metadata text exceeds 64 bytes");
        }
      }
      case ARRAY -> {
        for (Cbor.Item child : item.items()) {
          checkMetadatum(child, depth + 1);
        }
      }
      case MAP -> {
        for (Map.Entry<Cbor.Item, Cbor.Item> entry : item.entries()) {
          checkMetadatum(entry.getKey(), depth + 1);
          checkMetadatum(entry.getValue(), depth + 1);
        }
      }
      default -> throw new IllegalArgumentException("invalid transaction metadatum");
    }
  }

  private static BigInteger unsigned(Cbor.Item item, String what) {
    if (item == null || item.major() != Cbor.Major.UNSIGNED) {
      throw new IllegalArgumentException(what + " must be an unsigned integer");
    }
    return item.integer();
  }

  private static BigInteger optionalUnsigned(Cbor.Item item, String what) {
    return item == null ? null : unsigned(item, what);
  }

  private static List<String> inputs(Cbor.Item item) {
    if (item == null) {
      throw new IllegalArgumentException("transaction has no inputs field");
    }
    Cbor.Item set = item.untagSet();
    if (set.major() != Cbor.Major.ARRAY) {
      throw new IllegalArgumentException("inputs must be an array");
    }
    List<String> result = new ArrayList<>();
    for (Cbor.Item input : set.items()) {
      if (input.major() != Cbor.Major.ARRAY
          || input.items().size() != 2
          || input.items().get(0).major() != Cbor.Major.BYTES
          || input.items().get(0).bytes().length != 32) {
        throw new IllegalArgumentException("invalid transaction input");
      }
      result.add(
          HEX.formatHex(input.items().get(0).bytes())
              + "#"
              + unsigned(input.items().get(1), "input index"));
    }
    return result;
  }

  private static List<DecodedCardanoTransaction.Output> outputs(Cbor.Item item) {
    if (item == null || item.major() != Cbor.Major.ARRAY) {
      throw new IllegalArgumentException("outputs must be an array");
    }
    List<DecodedCardanoTransaction.Output> result = new ArrayList<>();
    for (Cbor.Item output : item.items()) {
      result.add(output(output));
    }
    return result;
  }

  private static DecodedCardanoTransaction.Output output(Cbor.Item output) {
    Cbor.Item address;
    Cbor.Item value;
    Cbor.Item datumOption = null;
    boolean referenceScript = false;
    boolean datumHash = false;
    if (output.major() == Cbor.Major.ARRAY) {
      if (output.items().size() < 2 || output.items().size() > 3) {
        throw new IllegalArgumentException("invalid legacy output");
      }
      address = output.items().get(0);
      value = output.items().get(1);
      if (output.items().size() == 3) {
        Cbor.Item hash = output.items().get(2);
        if (hash.major() != Cbor.Major.BYTES || hash.bytes().length != 32) {
          throw new IllegalArgumentException("a legacy output's datum hash must be 32 bytes");
        }
        datumHash = true;
      }
    } else if (output.major() == Cbor.Major.MAP) {
      output.requireUniqueKeys("transaction output");
      for (Map.Entry<Cbor.Item, Cbor.Item> entry : output.entries()) {
        Cbor.Item key = entry.getKey();
        // Differs from TS (which accepts other keys, e.g. 4 or 9): the ledger CDDL allows only 0-3.
        if (key.major() != Cbor.Major.UNSIGNED
            || key.integer().compareTo(BigInteger.valueOf(3)) > 0) {
          throw new IllegalArgumentException("transaction output has an unknown key");
        }
      }
      address = output.get(0);
      value = output.get(1);
      datumOption = output.get(2);
      referenceScript = output.get(3) != null;
    } else {
      throw new IllegalArgumentException("invalid transaction output");
    }
    if (address == null || address.major() != Cbor.Major.BYTES || value == null) {
      throw new IllegalArgumentException("output needs an address and a value");
    }
    String bech32 = CardanoAddresses.toBech32(address.bytes());

    BigInteger coin;
    Map<String, BigInteger> assets = new LinkedHashMap<>();
    if (value.major() == Cbor.Major.UNSIGNED) {
      coin = value.integer();
    } else if (value.major() == Cbor.Major.ARRAY && value.items().size() == 2) {
      coin = unsigned(value.items().get(0), "output coin");
      Cbor.Item multiAsset = value.items().get(1);
      if (multiAsset.major() != Cbor.Major.MAP) {
        throw new IllegalArgumentException("multi-asset must be a map");
      }
      // Duplicate policy ids or asset names would collapse to one value here but not for
      // every reader, so the amount checked could differ from the one paid.
      multiAsset.requireUniqueKeys("multi-asset map");
      for (Map.Entry<Cbor.Item, Cbor.Item> policy : multiAsset.entries()) {
        if (policy.getKey().major() != Cbor.Major.BYTES
            || policy.getKey().bytes().length != 28
            || policy.getValue().major() != Cbor.Major.MAP) {
          throw new IllegalArgumentException("invalid policy entry");
        }
        String policyHex = HEX.formatHex(policy.getKey().bytes());
        policy.getValue().requireUniqueKeys("asset map");
        for (Map.Entry<Cbor.Item, Cbor.Item> asset : policy.getValue().entries()) {
          if (asset.getKey().major() != Cbor.Major.BYTES || asset.getKey().bytes().length > 32) {
            throw new IllegalArgumentException("invalid asset name");
          }
          assets.put(
              policyHex + "." + HEX.formatHex(asset.getKey().bytes()),
              unsigned(asset.getValue(), "asset quantity"));
        }
      }
    } else {
      throw new IllegalArgumentException("invalid output value");
    }

    String datum = null;
    if (datumOption != null) {
      if (datumOption.major() != Cbor.Major.ARRAY
          || datumOption.items().size() != 2
          || datumOption.items().get(0).major() != Cbor.Major.UNSIGNED) {
        throw new IllegalArgumentException("invalid datum option");
      }
      BigInteger kind = datumOption.items().get(0).integer();
      if (!kind.equals(BigInteger.ZERO) && !kind.equals(BigInteger.ONE)) {
        throw new IllegalArgumentException("invalid datum option kind");
      }
      if (kind.equals(BigInteger.ZERO)) {
        Cbor.Item hash = datumOption.items().get(1);
        if (hash.major() != Cbor.Major.BYTES || hash.bytes().length != 32) {
          throw new IllegalArgumentException("a datum hash must be 32 bytes");
        }
        datumHash = true;
      }
      if (kind.equals(BigInteger.ONE)) {
        Cbor.Item wrapped = datumOption.items().get(1);
        if (wrapped.major() != Cbor.Major.TAG
            || !wrapped.integer().equals(BigInteger.valueOf(24))
            || wrapped.tagged().major() != Cbor.Major.BYTES) {
          throw new IllegalArgumentException("inline datum must be #6.24(bytes)");
        }
        byte[] datumBytes = wrapped.tagged().bytes();
        PlutusEncoding.check(datumBytes);
        // As the TypeScript decoder: the datum is reported in its decode-then-encode form.
        datum = HEX.formatHex(PlutusEncoding.canonical(datumBytes));
      }
    }
    return new DecodedCardanoTransaction.Output(
        bech32, coin, assets, datum, output.size(), referenceScript, datumHash);
  }

  private static final class Witnesses {
    int vkeyCount;
    List<String> vkeyHashes = new ArrayList<>();
    int scriptCount;
    int redeemerCount;
    boolean signaturesValid = true;
  }

  private static Witnesses witnesses(Cbor.Item set, byte[] bodyHash) {
    Witnesses w = new Witnesses();
    Cbor.Item vkeys = set.get(0);
    if (vkeys != null) {
      for (Cbor.Item witness : array(vkeys, "vkey witnesses")) {
        if (witness.major() != Cbor.Major.ARRAY
            || witness.items().size() != 2
            || witness.items().get(0).major() != Cbor.Major.BYTES
            || witness.items().get(0).bytes().length != 32
            || witness.items().get(1).major() != Cbor.Major.BYTES
            || witness.items().get(1).bytes().length != 64) {
          throw new IllegalArgumentException("invalid vkey witness");
        }
        byte[] vkey = witness.items().get(0).bytes();
        byte[] signature = witness.items().get(1).bytes();
        w.vkeyCount++;
        w.vkeyHashes.add(HEX.formatHex(Blake2bUtil.blake2bHash224(vkey)).toLowerCase(Locale.ROOT));
        if (w.signaturesValid && !verify(signature, bodyHash, vkey)) {
          w.signaturesValid = false;
        }
      }
    }
    w.vkeyCount += count(set.get(2), "bootstrap witnesses");
    w.scriptCount += count(set.get(1), "native scripts");
    w.scriptCount += count(set.get(3), "plutus v1 scripts");
    w.scriptCount += count(set.get(6), "plutus v2 scripts");
    w.scriptCount += count(set.get(7), "plutus v3 scripts");
    Cbor.Item redeemers = set.get(5);
    if (redeemers != null) {
      if (redeemers.major() == Cbor.Major.MAP) {
        w.redeemerCount = redeemers.entries().size();
      } else {
        w.redeemerCount = array(redeemers, "redeemers").size();
      }
    }
    w.scriptCount += w.redeemerCount;
    return w;
  }

  private static boolean verify(byte[] signature, byte[] message, byte[] vkey) {
    try {
      return ED25519.verify(signature, message, vkey);
    } catch (RuntimeException e) {
      return false;
    }
  }

  private static List<Cbor.Item> array(Cbor.Item item, String what) {
    Cbor.Item set = item.untagSet();
    if (set.major() != Cbor.Major.ARRAY) {
      throw new IllegalArgumentException(what + " must be an array");
    }
    return set.items();
  }

  private static int count(Cbor.Item item, String what) {
    return item == null ? 0 : array(item, what).size();
  }
}
