package org.x402.mechanisms.cardano.exact.masumi;

import com.bloxbean.cardano.client.address.Credential;
import com.bloxbean.cardano.client.plutus.spec.BigIntPlutusData;
import com.bloxbean.cardano.client.plutus.spec.BytesPlutusData;
import com.bloxbean.cardano.client.plutus.spec.ConstrPlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import java.math.BigInteger;
import java.util.List;
import java.util.Objects;
import org.x402.mechanisms.cardano.utils.CardanoAddresses;
import org.x402.mechanisms.cardano.utils.Cbor;
import org.x402.mechanisms.cardano.utils.CardanoAddresses.Pointer;
import org.x402.mechanisms.cardano.utils.PlutusEncoding;

/**
 * Codec for the Masumi {@code vested_pay} lock datum: the
 * 19-field {@code Constr 0} built for a fresh lock and parsed back for verification.
 */
public final class MasumiDatum {

  /** The state constructor index of a fresh lock. */
  public static final BigInteger STATE_FUNDS_LOCKED = BigInteger.ZERO;

  private static final int CREDENTIAL_HASH_HEX_LENGTH = 56;

  private MasumiDatum() {}

  /**
   * An address split into payment and optional stake credential or pointer.
   *
   * @param payment the payment credential
   * @param stake the stake credential, or {@code null}
   * @param pointer the pointer, or {@code null}
   */
  public record AddressCredentials(Credential payment, Credential stake, Pointer pointer) {}

  /**
   * The decoded lock datum.
   *
   * @param buyer buyer address
   * @param buyerReturnAddress {@code Some} address, or {@code null} for {@code None}
   * @param seller seller address
   * @param sellerReturnAddress {@code Some} address, or {@code null} for {@code None}
   * @param referenceKey lowercase hex
   * @param referenceSignature lowercase hex
   * @param sellerNonce lowercase hex
   * @param buyerNonce lowercase hex
   * @param agentIdentifier lowercase hex
   * @param collateralReturnLovelace collateral
   * @param inputHash lowercase hex
   * @param resultHash lowercase hex
   * @param payByTime POSIX ms
   * @param submitResultTime POSIX ms
   * @param unlockTime POSIX ms
   * @param externalDisputeUnlockTime POSIX ms
   * @param sellerCooldownTime POSIX ms
   * @param buyerCooldownTime POSIX ms
   * @param state the state constructor index
   */
  public record View(
      AddressCredentials buyer,
      AddressCredentials buyerReturnAddress,
      AddressCredentials seller,
      AddressCredentials sellerReturnAddress,
      String referenceKey,
      String referenceSignature,
      String sellerNonce,
      String buyerNonce,
      String agentIdentifier,
      BigInteger collateralReturnLovelace,
      String inputHash,
      String resultHash,
      BigInteger payByTime,
      BigInteger submitResultTime,
      BigInteger unlockTime,
      BigInteger externalDisputeUnlockTime,
      BigInteger sellerCooldownTime,
      BigInteger buyerCooldownTime,
      BigInteger state) {}

  /**
   * The inputs of a fresh lock datum.
   *
   * @param buyerAddress buyer
   * @param sellerAddress seller
   * @param buyerReturnAddress optional buyer payout address, or {@code null}
   * @param sellerReturnAddress optional seller payout address, or {@code null}
   * @param referenceKey COSE_Key hex
   * @param referenceSignature COSE_Sign1 hex
   * @param sellerNonce hex
   * @param buyerNonce hex
   * @param agentIdentifier hex, possibly empty
   * @param collateralReturnLovelace the collateral
   * @param inputHash hex
   * @param payByTime POSIX ms
   * @param submitResultTime POSIX ms
   * @param unlockTime POSIX ms
   * @param externalDisputeUnlockTime POSIX ms
   */
  public record LockInput(
      String buyerAddress,
      String sellerAddress,
      String buyerReturnAddress,
      String sellerReturnAddress,
      String referenceKey,
      String referenceSignature,
      String sellerNonce,
      String buyerNonce,
      String agentIdentifier,
      BigInteger collateralReturnLovelace,
      String inputHash,
      BigInteger payByTime,
      BigInteger submitResultTime,
      BigInteger unlockTime,
      BigInteger externalDisputeUnlockTime) {}

  /**
   * The payment and stake credentials of a bech32 address (base, enterprise or pointer).
   *
   * @param bech32 the address
   * @return the credentials
   * @throws IllegalArgumentException for other address forms
   */
  public static AddressCredentials addressCredentials(String bech32) {
    CardanoAddresses.Parsed p = CardanoAddresses.parse(bech32);
    return new AddressCredentials(p.payment(), p.stake(), p.pointer());
  }

  /**
   * Whether two addresses share payment, stake and pointer parts.
   *
   * @param a the first
   * @param b the second
   * @return true when equal
   */
  public static boolean sameCredentials(AddressCredentials a, AddressCredentials b) {
    // Credentials compare by type and hash bytes.
    if (!a.payment().equals(b.payment()) || !Objects.equals(a.stake(), b.stake())) {
      return false;
    }
    return Objects.equals(pointerParts(a.pointer()), pointerParts(b.pointer()));
  }

  private static List<BigInteger> pointerParts(Pointer p) {
    BigInteger none = BigInteger.ONE.negate();
    return p == null ? List.of(none, none, none) : List.of(p.slot(), p.txIndex(), p.certIndex());
  }

  // ---------------------------------------------------------------- build

  private static PlutusData credentialToData(Credential c) {
    return PlutusEncoding.constr(CardanoAddresses.isScript(c) ? 1 : 0, BytesPlutusData.of(c.getBytes()));
  }

  private static PlutusData addressToData(String bech32) {
    AddressCredentials creds = addressCredentials(bech32);
    PlutusData stake;
    if (creds.stake() != null) {
      stake = PlutusEncoding.constr(0, PlutusEncoding.constr(0, credentialToData(creds.stake())));
    } else if (creds.pointer() != null) {
      stake =
          PlutusEncoding.constr(
              0,
              PlutusEncoding.constr(
                  1,
                  PlutusEncoding.integer(creds.pointer().slot()),
                  PlutusEncoding.integer(creds.pointer().txIndex()),
                  PlutusEncoding.integer(creds.pointer().certIndex())));
    } else {
      stake = PlutusEncoding.constr(1);
    }
    return PlutusEncoding.constr(0, credentialToData(creds.payment()), stake);
  }

  private static PlutusData optionAddress(String bech32) {
    return bech32 == null || bech32.isEmpty() ? PlutusEncoding.constr(1) : PlutusEncoding.constr(0, addressToData(bech32));
  }

  /**
   * Builds the 19-field lock datum of a fresh lock.
   *
   * @param input the field values
   * @return the datum
   */
  public static PlutusData build(LockInput input) {
    return PlutusEncoding.constr(
        0,
        addressToData(input.buyerAddress()),
        optionAddress(input.buyerReturnAddress()),
        addressToData(input.sellerAddress()),
        optionAddress(input.sellerReturnAddress()),
        PlutusEncoding.bytes(input.referenceKey()),
        PlutusEncoding.bytes(input.referenceSignature()),
        PlutusEncoding.bytes(input.sellerNonce()),
        PlutusEncoding.bytes(input.buyerNonce()),
        PlutusEncoding.bytes(input.agentIdentifier()),
        PlutusEncoding.integer(input.collateralReturnLovelace()),
        PlutusEncoding.bytes(input.inputHash()),
        PlutusEncoding.bytes(""),
        PlutusEncoding.integer(input.payByTime()),
        PlutusEncoding.integer(input.submitResultTime()),
        PlutusEncoding.integer(input.unlockTime()),
        PlutusEncoding.integer(input.externalDisputeUnlockTime()),
        BigIntPlutusData.of(0),
        BigIntPlutusData.of(0),
        PlutusEncoding.constr(0));
  }

  // ---------------------------------------------------------------- parse

  private static boolean containsMap(Cbor.Item item) {
    switch (item.major()) {
      case MAP:
        return true;
      case ARRAY:
        return item.items().stream().anyMatch(MasumiDatum::containsMap);
      case TAG:
        return containsMap(item.tagged());
      default:
        return false;
    }
  }

  /** A constructor: its index and fields. */
  private record C(BigInteger index, List<PlutusData> fields) {}

  private static C constr(PlutusData d) {
    return d instanceof ConstrPlutusData c
        ? new C(BigInteger.valueOf(c.getAlternative()), PlutusEncoding.fields(c))
        : null;
  }

  private static BigInteger integer(PlutusData d) {
    return d instanceof BigIntPlutusData i ? i.getValue() : null;
  }

  private static String hex(PlutusData d) {
    return PlutusEncoding.hex(d);
  }

  private static Credential credential(PlutusData d) {
    C c = constr(d);
    if (c == null || c.fields().size() != 1 || c.index().compareTo(BigInteger.ONE) > 0 || c.index().signum() < 0) {
      return null;
    }
    String hash = hex(c.fields().get(0));
    if (hash == null || hash.length() != CREDENTIAL_HASH_HEX_LENGTH) {
      return null;
    }
    return c.index().equals(BigInteger.ONE) ? Credential.fromScript(hash) : Credential.fromKey(hash);
  }

  private static AddressCredentials address(PlutusData d) {
    C c = constr(d);
    if (c == null || c.index().signum() != 0 || c.fields().size() != 2) {
      return null;
    }
    Credential payment = credential(c.fields().get(0));
    C option = constr(c.fields().get(1));
    if (payment == null || option == null) {
      return null;
    }
    if (option.index().equals(BigInteger.ONE)) {
      return option.fields().isEmpty() ? new AddressCredentials(payment, null, null) : null;
    }
    if (option.index().signum() != 0 || option.fields().size() != 1) {
      return null;
    }
    C ref = constr(option.fields().get(0));
    if (ref == null) {
      return null;
    }
    if (ref.index().signum() == 0 && ref.fields().size() == 1) {
      Credential stake = credential(ref.fields().get(0));
      return stake == null ? null : new AddressCredentials(payment, stake, null);
    }
    if (ref.index().equals(BigInteger.ONE) && ref.fields().size() == 3) {
      BigInteger slot = integer(ref.fields().get(0));
      BigInteger txIndex = integer(ref.fields().get(1));
      BigInteger certIndex = integer(ref.fields().get(2));
      if (slot == null
          || txIndex == null
          || certIndex == null
          || slot.signum() < 0
          || txIndex.signum() < 0
          || certIndex.signum() < 0) {
        return null;
      }
      return new AddressCredentials(payment, null, new Pointer(slot, txIndex, certIndex));
    }
    return null;
  }

  /** {@code Some(addr)} → the address; {@code None} → {@code NONE}; else {@code null}. */
  private static final AddressCredentials NONE = new AddressCredentials(Credential.fromKey(new byte[0]), null, null);

  private static AddressCredentials optionAddress(PlutusData d) {
    C c = constr(d);
    if (c == null) {
      return null;
    }
    if (c.index().equals(BigInteger.ONE) && c.fields().isEmpty()) {
      return NONE;
    }
    if (c.index().signum() != 0 || c.fields().size() != 1) {
      return null;
    }
    return address(c.fields().get(0));
  }

  /**
   * Parses a lock datum. Total: {@code null} on any structural mismatch.
   *
   * @param datumCbor the datum's CBOR bytes
   * @return the view, or {@code null}
   */
  public static View parse(byte[] datumCbor) {
    PlutusData data;
    try {
      Cbor.Item item = Cbor.decode(datumCbor);
      if (containsMap(item)) {
        // The lock datum has no maps; refusing them here also avoids hashing attacker-chosen keys.
        return null;
      }
      data = PlutusEncoding.decode(item);
    } catch (RuntimeException e) {
      return null;
    }
    C root = constr(data);
    if (root == null || root.index().signum() != 0 || root.fields().size() != 19) {
      return null;
    }
    List<PlutusData> f = root.fields();
    AddressCredentials buyer = address(f.get(0));
    AddressCredentials buyerReturn = optionAddress(f.get(1));
    AddressCredentials seller = address(f.get(2));
    AddressCredentials sellerReturn = optionAddress(f.get(3));
    C state = constr(f.get(18));
    if (state != null && !state.fields().isEmpty()) {
      return null;
    }
    String referenceKey = hex(f.get(4));
    String referenceSignature = hex(f.get(5));
    String sellerNonce = hex(f.get(6));
    String buyerNonce = hex(f.get(7));
    String agentIdentifier = hex(f.get(8));
    BigInteger collateral = integer(f.get(9));
    String inputHash = hex(f.get(10));
    String resultHash = hex(f.get(11));
    BigInteger payByTime = integer(f.get(12));
    BigInteger submitResultTime = integer(f.get(13));
    BigInteger unlockTime = integer(f.get(14));
    BigInteger externalDisputeUnlockTime = integer(f.get(15));
    BigInteger sellerCooldown = integer(f.get(16));
    BigInteger buyerCooldown = integer(f.get(17));
    if (buyer == null
        || buyerReturn == null
        || seller == null
        || sellerReturn == null
        || referenceKey == null
        || referenceSignature == null
        || sellerNonce == null
        || buyerNonce == null
        || agentIdentifier == null
        || collateral == null
        || inputHash == null
        || resultHash == null
        || payByTime == null
        || submitResultTime == null
        || unlockTime == null
        || externalDisputeUnlockTime == null
        || sellerCooldown == null
        || buyerCooldown == null
        || state == null) {
      return null;
    }
    return new View(
        buyer,
        buyerReturn == NONE ? null : buyerReturn,
        seller,
        sellerReturn == NONE ? null : sellerReturn,
        referenceKey,
        referenceSignature,
        sellerNonce,
        buyerNonce,
        agentIdentifier,
        collateral,
        inputHash,
        resultHash,
        payByTime,
        submitResultTime,
        unlockTime,
        externalDisputeUnlockTime,
        sellerCooldown,
        buyerCooldown,
        state.index());
  }
}
