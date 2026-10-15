package org.x402.mechanisms.cardano.exact.masumi;

import com.bloxbean.cardano.client.common.model.SlotConfig;
import java.math.BigInteger;
import java.time.Clock;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;
import org.x402.mechanisms.cardano.utils.CardanoAddresses;
import org.x402.mechanisms.cardano.utils.CardanoConstants;
import org.x402.mechanisms.cardano.utils.CardanoErrors;
import org.x402.mechanisms.cardano.utils.CardanoNetworks;
import org.x402.mechanisms.cardano.utils.DecodedCardanoTransaction;
import org.x402.mechanisms.cardano.exact.masumi.MasumiDatum.AddressCredentials;

/**
 * Masumi verification: the seller authorization a client
 * checks before paying, and the escrow lock a facilitator checks before settling.
 */
public final class MasumiVerifier {

  private static final Object UNDEFINED = new Object();

  private MasumiVerifier() {}

  /**
   * A check outcome.
   *
   * @param ok whether the check passed
   * @param reason the error code when failed
   * @param detail optional detail
   */
  public record Check(boolean ok, String reason, String detail) {
    /** Success. */
    public static final Check OK = new Check(true, null, null);

    static Check fail(String reason, String detail) {
      return new Check(false, reason, detail);
    }
  }

  /**
   * The authorization outcome.
   *
   * @param ok whether it verified
   * @param reason the error code when failed
   * @param detail optional detail
   * @param escrowAddress the derived escrow address when verified
   * @param termsDigest the terms digest when verified
   */
  public record Authorization(boolean ok, String reason, String detail, String escrowAddress, String termsDigest) {
    static Authorization fail(String reason, String detail) {
      return new Authorization(false, reason, detail, null, null);
    }

    Check check() {
      return ok ? Check.OK : Check.fail(reason, detail);
    }
  }

  /**
   * Options of {@link #verifyAuthorization}.
   *
   * @param validateRegistryClaim validates a non-empty {@code agentIdentifier}, or {@code null}
   * @param resource the protected resource, or {@code null}
   * @param validateCustomDeployment approves a custom deployment, or {@code null}
   * @param localCommitmentContent the buyer's content for parts the issuer did not echo
   * @param requireAllPartContent refuse a part with no content to check (clients must set it)
   * @param maxDeadlineHorizonMs buyer policy: how far past now the last deadline may sit, or
   *     {@code null} to skip (verifiers leave it unset)
   * @param clock the clock for the horizon
   * @param allowedScriptHashes escrow script hashes accepted on the network; when non-empty every
   *     other escrow is refused (the canonical one included) and an allowlisted custom deployment
   *     needs no approval. Empty or {@code null} keeps the default rules.
   */
  public record AuthorizationOptions(
      MasumiRegistryValidator validateRegistryClaim,
      ResourceInfo resource,
      MasumiDeploymentValidator validateCustomDeployment,
      Map<String, Object> localCommitmentContent,
      boolean requireAllPartContent,
      BigInteger maxDeadlineHorizonMs,
      Clock clock,
      Set<String> allowedScriptHashes) {

    /** No validators, no local content, no horizon. */
    public static final AuthorizationOptions NONE =
        new AuthorizationOptions(null, null, null, null, false, null, Clock.systemUTC());

    /** Lowercases the allowlist. */
    public AuthorizationOptions {
      allowedScriptHashes = lowercase(allowedScriptHashes);
    }

    /**
     * Options without an allowlist.
     *
     * @param validateRegistryClaim see the record
     * @param resource see the record
     * @param validateCustomDeployment see the record
     * @param localCommitmentContent see the record
     * @param requireAllPartContent see the record
     * @param maxDeadlineHorizonMs see the record
     * @param clock see the record
     */
    public AuthorizationOptions(MasumiRegistryValidator validateRegistryClaim, ResourceInfo resource,
        MasumiDeploymentValidator validateCustomDeployment, Map<String, Object> localCommitmentContent,
        boolean requireAllPartContent, BigInteger maxDeadlineHorizonMs, Clock clock) {
      this(validateRegistryClaim, resource, validateCustomDeployment, localCommitmentContent,
          requireAllPartContent, maxDeadlineHorizonMs, clock, Set.of());
    }
  }

  private static Set<String> lowercase(Set<String> hashes) {
    if (hashes == null) {
      return Set.of();
    }
    Set<String> lower = new java.util.HashSet<>();
    for (String hash : hashes) {
      lower.add(hash.toLowerCase(Locale.ROOT));
    }
    return Set.copyOf(lower);
  }

  /**
   * Context of {@link #verifyLock}.
   *
   * @param payer the nonce UTxO owner, i.e. the resolved buyer
   * @param coinsPerUtxoByte live {@code coinsPerUtxoByte}, or {@code null} to skip min-UTxO
   * @param validateRegistryClaim registry validator, or {@code null}
   * @param resource the protected resource, or {@code null}
   * @param validateCustomDeployment deployment validator, or {@code null}
   * @param slotConfig the slot configuration of the network, or {@code null} for the built-in one
   * @param allowedScriptHashes the network's escrow allowlist (see {@link AuthorizationOptions})
   */
  public record LockContext(
      String payer,
      BigInteger coinsPerUtxoByte,
      MasumiRegistryValidator validateRegistryClaim,
      ResourceInfo resource,
      MasumiDeploymentValidator validateCustomDeployment,
      SlotConfig slotConfig,
      Set<String> allowedScriptHashes) {

    /** Lowercases the allowlist. */
    public LockContext {
      allowedScriptHashes = lowercase(allowedScriptHashes);
    }

    /**
     * A context without an allowlist.
     *
     * @param payer the payer
     * @param coinsPerUtxoByte the protocol parameter, or {@code null}
     * @param validateRegistryClaim the registry validator, or {@code null}
     * @param resource the resource
     * @param validateCustomDeployment the deployment validator, or {@code null}
     * @param slotConfig the slot configuration, or {@code null}
     */
    public LockContext(String payer, BigInteger coinsPerUtxoByte,
        MasumiRegistryValidator validateRegistryClaim, ResourceInfo resource,
        MasumiDeploymentValidator validateCustomDeployment, SlotConfig slotConfig) {
      this(payer, coinsPerUtxoByte, validateRegistryClaim, resource, validateCustomDeployment, slotConfig,
          Set.of());
    }

    /**
     * A context using the network's built-in slot configuration.
     *
     * @param payer the payer
     * @param coinsPerUtxoByte the protocol parameter, or {@code null}
     * @param validateRegistryClaim the registry validator, or {@code null}
     * @param resource the resource
     * @param validateCustomDeployment the deployment validator, or {@code null}
     */
    public LockContext(String payer, BigInteger coinsPerUtxoByte,
        MasumiRegistryValidator validateRegistryClaim, ResourceInfo resource,
        MasumiDeploymentValidator validateCustomDeployment) {
      this(payer, coinsPerUtxoByte, validateRegistryClaim, resource, validateCustomDeployment, null);
    }
  }

  private static Check verifyTermDeadlines(MasumiTerms terms, BigInteger maxDeadlineHorizonMs, Clock clock) {
    BigInteger externalDisputeUnlockTime = new BigInteger(terms.externalDisputeUnlockTime());
    if (!MasumiConstants.deadlineIntervalsHold(
        new BigInteger(terms.payByTime()),
        new BigInteger(terms.submitResultTime()),
        new BigInteger(terms.unlockTime()),
        externalDisputeUnlockTime)) {
      return Check.fail(CardanoErrors.MASUMI_DEADLINE, "deadline intervals below the minimum");
    }
    if (maxDeadlineHorizonMs != null
        && externalDisputeUnlockTime.compareTo(BigInteger.valueOf(clock.millis()).add(maxDeadlineHorizonMs)) > 0) {
      return Check.fail(CardanoErrors.MASUMI_DEADLINE, "deadlines extend beyond the accepted horizon");
    }
    return Check.OK;
  }

  /**
   * Verifies the seller authorization: commitment digests, escrow derivation, the COSE
   * signature over {@code termsDigest}, deployment approval, registry claim and identifier.
   *
   * @param extra the schema-validated extra
   * @param requirements the requirements
   * @param options the options
   * @return the outcome with the escrow address and terms digest when verified
   */
  public static Authorization verifyAuthorization(
      MasumiExtra extra, PaymentRequirements requirements, AuthorizationOptions options) {
    MasumiTerms terms = extra.terms();
    Check deadlines =
        verifyTermDeadlines(
            terms, options.maxDeadlineHorizonMs(), options.clock() == null ? Clock.systemUTC() : options.clock());
    if (!deadlines.ok()) {
      return Authorization.fail(deadlines.reason(), deadlines.detail());
    }

    for (MasumiCommitmentPart part : extra.inputCommitment().parts()) {
      Object content = part.hasContent() && part.content() != null ? part.content() : UNDEFINED;
      if (content == UNDEFINED
          && options.localCommitmentContent() != null
          && options.localCommitmentContent().containsKey(part.name())) {
        content = options.localCommitmentContent().get(part.name());
      }
      if (content == UNDEFINED) {
        if (options.requireAllPartContent()) {
          return Authorization.fail(
              CardanoErrors.MASUMI_COMMITMENT,
              "part " + part.name() + " carries no content to verify its digest against");
        }
        continue;
      }
      String digest;
      try {
        digest = MasumiDigests.commitmentPartDigest(part.canonicalization(), content);
      } catch (RuntimeException e) {
        return Authorization.fail(CardanoErrors.MASUMI_COMMITMENT, e.getMessage());
      }
      if (!digest.equals(part.digest())) {
        return Authorization.fail(CardanoErrors.MASUMI_COMMITMENT, "part " + part.name() + " digest mismatch");
      }
    }
    if (!MasumiDigests.computeInputHash(extra.inputCommitment()).equals(extra.inputCommitment().digest())) {
      return Authorization.fail(CardanoErrors.MASUMI_COMMITMENT, "commitment digest mismatch");
    }

    MasumiDeployment deployment = MasumiBlueprint.resolveDeployment(requirements.network(), extra.deployment());
    if (deployment == null) {
      return Authorization.fail(
          CardanoErrors.MASUMI_DEPLOYMENT, "network has no canonical deployment; extra.deployment is required");
    }
    String escrowAddress;
    try {
      escrowAddress = MasumiBlueprint.escrowAddress(requirements.network(), deployment);
    } catch (RuntimeException e) {
      return Authorization.fail(CardanoErrors.MASUMI_DEPLOYMENT, e.getMessage());
    }
    if (!escrowAddress.equals(requirements.payTo())) {
      return Authorization.fail(
          CardanoErrors.MASUMI_DEPLOYMENT, "derived escrow " + escrowAddress + " does not equal payTo");
    }
    String termsDigest = MasumiDigests.computeTermsDigest(MasumiDigests.buildSignedTerms(extra, requirements));
    if (!MasumiCose.verifySellerTermsSignature(
        extra.referenceKey(), extra.referenceSignature(), terms.sellerAddress(), termsDigest)) {
      return Authorization.fail(CardanoErrors.MASUMI_SELLER_SIGNATURE, null);
    }

    // Operator policy runs only once the seller is authenticated.
    Set<String> allowed = options.allowedScriptHashes();
    String escrowHash = CardanoAddresses.scriptPaymentCredentialHex(requirements.payTo());
    boolean allowlisted = escrowHash != null && allowed.contains(escrowHash.toLowerCase(Locale.ROOT));
    if (!allowed.isEmpty() && !allowlisted) {
      return Authorization.fail(
          CardanoErrors.MASUMI_CONTRACT_MISMATCH, "escrow script " + escrowHash + " is not on the allowlist");
    }
    if (extra.deployment() != null && !allowlisted) {
      if (options.validateCustomDeployment() == null) {
        return Authorization.fail(
            CardanoErrors.MASUMI_DEPLOYMENT, "custom deployment requires explicit application approval");
      }
      if (!options
          .validateCustomDeployment()
          .approve(new MasumiDeploymentClaim(requirements.network(), requirements.payTo(), extra.deployment()))) {
        return Authorization.fail(CardanoErrors.MASUMI_DEPLOYMENT, "custom deployment was not approved");
      }
    }

    String agentIdentifier = terms.agentIdentifierOrEmpty();
    if (!agentIdentifier.isEmpty()) {
      if (!agentIdentifier.startsWith(MasumiConstants.REGISTRY_POLICY_ID)) {
        return Authorization.fail(
            CardanoErrors.MASUMI_AGENT_IDENTIFIER, "agentIdentifier does not carry the Masumi V2 registry policy id");
      }
      if (options.validateRegistryClaim() == null) {
        return Authorization.fail(
            CardanoErrors.MASUMI_AGENT_IDENTIFIER, "registry claims require an independent on-network validator");
      }
      if (options.resource() == null) {
        return Authorization.fail(
            CardanoErrors.MASUMI_AGENT_IDENTIFIER,
            "registry claims require the protected resource for endpoint validation");
      }
      if (!options
          .validateRegistryClaim()
          .validate(
              new MasumiRegistryClaim(
                  agentIdentifier,
                  terms.sellerAddress(),
                  requirements.network(),
                  requirements.amount(),
                  requirements.asset(),
                  options.resource()))) {
        return Authorization.fail(CardanoErrors.MASUMI_AGENT_IDENTIFIER, "registry validation rejected the claim");
      }
    }

    MasumiIdentifier.Parts decoded = MasumiIdentifier.decode(extra.blockchainIdentifier());
    if (decoded == null
        || !decoded.sellerNonce().equals(terms.sellerNonce())
        || !decoded.agentIdentifier().equals(agentIdentifier)
        || !decoded.buyerNonce().equals(terms.buyerNonce())
        || !decoded.referenceSignature().equals(extra.referenceSignature())
        || !decoded.referenceKey().equals(extra.referenceKey())
        || !decoded.contractAddress().equals(requirements.payTo())) {
      return Authorization.fail(CardanoErrors.MASUMI_IDENTIFIER, null);
    }
    return new Authorization(true, null, null, escrowAddress, termsDigest);
  }

  private static String unsupportedAddressForm(AddressCredentials c) {
    if (CardanoAddresses.isScript(c.payment())) {
      return "script payment credential";
    }
    if (c.stake() != null && CardanoAddresses.isScript(c.stake())) {
      return "script stake credential";
    }
    if (c.pointer() != null) {
      return "pointer stake reference";
    }
    return null;
  }

  /**
   * Invariants a fresh lock datum must hold (shared by client preflight and facilitator).
   *
   * @param view the parsed datum
   * @param escrowAddress the derived escrow address
   * @return the first failed invariant, or OK
   */
  public static Check verifyDatumInvariants(MasumiDatum.View view, String escrowAddress) {
    if (view.state().signum() != 0) {
      return Check.fail(CardanoErrors.MASUMI_DATUM_INVALID, "state");
    }
    if (!view.resultHash().isEmpty()) {
      return Check.fail(CardanoErrors.MASUMI_DATUM_INVALID, "result_hash");
    }
    if (view.sellerCooldownTime().signum() != 0 || view.buyerCooldownTime().signum() != 0) {
      return Check.fail(CardanoErrors.MASUMI_DATUM_INVALID, "cooldown");
    }
    List<Map.Entry<String, AddressCredentials>> forms =
        java.util.Arrays.asList(
            new java.util.AbstractMap.SimpleImmutableEntry<>("buyer", view.buyer()),
            new java.util.AbstractMap.SimpleImmutableEntry<>("seller", view.seller()),
            new java.util.AbstractMap.SimpleImmutableEntry<>("buyer_return_address", view.buyerReturnAddress()),
            new java.util.AbstractMap.SimpleImmutableEntry<>("seller_return_address", view.sellerReturnAddress()));
    for (Map.Entry<String, AddressCredentials> form : forms) {
      if (form.getValue() == null) {
        continue;
      }
      String unsupported = unsupportedAddressForm(form.getValue());
      if (unsupported != null) {
        return Check.fail(CardanoErrors.MASUMI_DATUM_INVALID, form.getKey() + " is a " + unsupported);
      }
    }
    if (view.referenceSignature().length() < 32) {
      return Check.fail(CardanoErrors.MASUMI_DATUM_INVALID, "reference_signature shorter than 16 bytes");
    }
    AddressCredentials escrow = MasumiDatum.addressCredentials(escrowAddress);
    AddressCredentials buyerTarget = view.buyerReturnAddress() != null ? view.buyerReturnAddress() : view.buyer();
    AddressCredentials sellerTarget = view.sellerReturnAddress() != null ? view.sellerReturnAddress() : view.seller();
    if (MasumiDatum.sameCredentials(view.buyer(), escrow)
        || MasumiDatum.sameCredentials(view.seller(), escrow)
        || MasumiDatum.sameCredentials(buyerTarget, escrow)
        || MasumiDatum.sameCredentials(sellerTarget, escrow)) {
      return Check.fail(CardanoErrors.MASUMI_DATUM_INVALID, "datum address is the escrow");
    }
    if (MasumiDatum.sameCredentials(buyerTarget, sellerTarget)) {
      return Check.fail(CardanoErrors.MASUMI_DATUM_INVALID, "buyer and seller payout targets are equal");
    }
    if (!MasumiConstants.deadlineIntervalsHold(
        view.payByTime(), view.submitResultTime(), view.unlockTime(), view.externalDisputeUnlockTime())) {
      return Check.fail(CardanoErrors.MASUMI_DEADLINE, "deadline intervals below the minimum");
    }
    return Check.OK;
  }

  private static boolean returnAddressMatches(String declared, AddressCredentials actual) {
    if (declared == null) {
      return actual == null;
    }
    return actual != null && MasumiDatum.sameCredentials(actual, MasumiDatum.addressCredentials(declared));
  }

  /**
   * Verifies that a transaction locks the payment into the Masumi escrow with a valid
   * FundsLocked datum matching the seller-signed terms.
   *
   * @param rawExtra the canonical {@code requirements.extra}
   * @param requirements the requirements
   * @param decoded the decoded transaction
   * @param context payer, live parameters and validators
   * @return OK or the first failure
   */
  public static Check verifyLock(
      Object rawExtra, PaymentRequirements requirements, DecodedCardanoTransaction decoded, LockContext context) {
    MasumiSchema.Result schema = MasumiSchema.validate(rawExtra, requirements.network());
    if (!schema.ok()) {
      return Check.fail(CardanoErrors.MASUMI_SCHEMA, schema.detail());
    }
    MasumiExtra extra = schema.extra();
    MasumiTerms terms = extra.terms();
    Authorization authorization =
        verifyAuthorization(
            extra,
            requirements,
            new AuthorizationOptions(
                context.validateRegistryClaim(),
                context.resource(),
                context.validateCustomDeployment(),
                null,
                false,
                null,
                Clock.systemUTC(),
                context.allowedScriptHashes()));
    if (!authorization.ok()) {
      return authorization.check();
    }
    String escrowAddress = authorization.escrowAddress();

    List<DecodedCardanoTransaction.Output> escrowOutputs =
        decoded.outputs().stream().filter(o -> o.address().equals(escrowAddress)).toList();
    if (escrowOutputs.size() != 1) {
      return Check.fail(CardanoErrors.MASUMI_ESCROW_OUTPUT_COUNT, null);
    }
    DecodedCardanoTransaction.Output output = escrowOutputs.get(0);
    if (output.datum() == null) {
      return Check.fail(CardanoErrors.MASUMI_DATUM_MISSING, null);
    }
    if (output.hasReferenceScript()) {
      return Check.fail(CardanoErrors.MASUMI_REFERENCE_SCRIPT, null);
    }
    String datumHex = output.datum();
    MasumiDatum.View view = MasumiDatum.parse(HexFormat.of().parseHex(datumHex));
    if (view == null) {
      return Check.fail(CardanoErrors.MASUMI_DATUM_INVALID, "datum does not match masumi.vested_pay.v2");
    }
    Check invariants = verifyDatumInvariants(view, escrowAddress);
    if (!invariants.ok()) {
      return invariants;
    }
    if (decoded.ttlSlot() == null) {
      return Check.fail(CardanoErrors.MASUMI_DEADLINE, "no validity upper bound");
    }
    SlotConfig slots = context.slotConfig() != null
        ? context.slotConfig() : CardanoNetworks.slotConfig(requirements.network());
    if (CardanoNetworks.slotToPosixMs(slots, decoded.ttlSlot()).compareTo(view.payByTime()) > 0) {
      return Check.fail(CardanoErrors.MASUMI_DEADLINE, "TTL is after pay_by_time");
    }

    AddressCredentials payer = MasumiDatum.addressCredentials(context.payer());
    if (!CardanoAddresses.hashHex(view.buyer().payment()).equals(CardanoAddresses.hashHex(payer.payment()))) {
      return Check.fail(CardanoErrors.MASUMI_DATUM_MISMATCH, "buyer does not control the nonce input");
    }
    if (!decoded.vkeyHashes().contains(CardanoAddresses.hashHex(view.buyer().payment()))) {
      return Check.fail(CardanoErrors.MASUMI_DATUM_MISMATCH, "no witness for the buyer credential");
    }
    if (!MasumiDatum.sameCredentials(view.seller(), MasumiDatum.addressCredentials(terms.sellerAddress()))) {
      return Check.fail(CardanoErrors.MASUMI_DATUM_MISMATCH, "seller");
    }
    if (!returnAddressMatches(terms.sellerReturnAddress(), view.sellerReturnAddress())) {
      return Check.fail(CardanoErrors.MASUMI_DATUM_MISMATCH, "seller_return_address");
    }
    String[][] byteFields = {
      {"reference_key", extra.referenceKey(), view.referenceKey()},
      {"reference_signature", extra.referenceSignature(), view.referenceSignature()},
      {"seller_nonce", terms.sellerNonce(), view.sellerNonce()},
      {"buyer_nonce", terms.buyerNonce(), view.buyerNonce()},
      {"agent_identifier", terms.agentIdentifierOrEmpty(), view.agentIdentifier()},
      {"input_hash", terms.inputHash(), view.inputHash()},
    };
    for (String[] field : byteFields) {
      if (!field[1].toLowerCase(Locale.ROOT).equals(field[2])) {
        return Check.fail(CardanoErrors.MASUMI_DATUM_MISMATCH, field[0]);
      }
    }
    Object[][] timeFields = {
      {"pay_by_time", terms.payByTime(), view.payByTime()},
      {"submit_result_time", terms.submitResultTime(), view.submitResultTime()},
      {"unlock_time", terms.unlockTime(), view.unlockTime()},
      {"external_dispute_unlock_time", terms.externalDisputeUnlockTime(), view.externalDisputeUnlockTime()},
    };
    for (Object[] field : timeFields) {
      if (!new BigInteger((String) field[1]).equals(field[2])) {
        return Check.fail(CardanoErrors.MASUMI_DATUM_MISMATCH, (String) field[0]);
      }
    }

    BigInteger amount = new BigInteger(requirements.amount());
    String assetKey = requirements.asset().toLowerCase(Locale.ROOT);
    boolean isLovelace = CardanoConstants.LOVELACE.equals(assetKey);
    BigInteger requestedLovelace = isLovelace ? amount : BigInteger.ZERO;
    BigInteger collateral = view.collateralReturnLovelace();
    if (collateral.signum() < 0
        || (collateral.signum() > 0 && collateral.compareTo(MasumiConstants.MIN_COLLATERAL_LOVELACE) < 0)) {
      return Check.fail(CardanoErrors.MASUMI_COLLATERAL, "collateral " + collateral + " below the floor");
    }
    BigInteger expected = requestedLovelace.add(collateral);
    if (!output.coin().equals(expected)) {
      return Check.fail(CardanoErrors.MASUMI_COLLATERAL, "locked " + output.coin() + " lovelace, expected " + expected);
    }
    if (!isLovelace && !amount.equals(output.assets().get(assetKey))) {
      return Check.fail(CardanoErrors.MASUMI_ASSET, "native token amount is not exact");
    }
    if (output.assets().size() != (isLovelace ? 0 : 1)) {
      return Check.fail(CardanoErrors.MASUMI_ASSET, "escrow output carries extra native tokens");
    }
    if (context.coinsPerUtxoByte() != null) {
      BigInteger required =
          MasumiConstants.minUtxoLovelace(datumHex.length() / 2, output.assets().size(), context.coinsPerUtxoByte());
      if (output.coin().compareTo(required) < 0) {
        return Check.fail(CardanoErrors.MASUMI_MIN_UTXO, "locked " + output.coin() + ", post-result minimum " + required);
      }
    }
    return Check.OK;
  }
}
