package org.x402.mechanisms.cardano.exact.facilitator;

import com.bloxbean.cardano.client.api.model.ProtocolParams;
import com.bloxbean.cardano.client.common.model.SlotConfig;
import java.math.BigInteger;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Objects;
import java.util.Set;
import org.x402.core.FacilitatorContext;
import org.x402.core.SchemeNetworkFacilitator;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.core.types.VerifyResponse;
import org.x402.mechanisms.cardano.utils.CardanoAddresses;
import org.x402.mechanisms.cardano.utils.CardanoConstants;
import org.x402.mechanisms.cardano.utils.CardanoErrors;
import org.x402.mechanisms.cardano.utils.CardanoNetworks;
import org.x402.mechanisms.cardano.utils.CardanoPolicies;
import org.x402.mechanisms.cardano.utils.CardanoTransactionDecoder;
import org.x402.mechanisms.cardano.utils.CardanoUtils;
import org.x402.mechanisms.cardano.utils.DecodedCardanoTransaction;
import org.x402.mechanisms.cardano.chain.BlockfrostChainBackend;
import org.x402.mechanisms.cardano.chain.CardanoChainBackend;
import org.x402.mechanisms.cardano.chain.SettlementEvidence;
import org.x402.mechanisms.cardano.chain.SubmissionResult;
import org.x402.mechanisms.cardano.chain.UtxoSnapshot;
import org.x402.mechanisms.cardano.exact.masumi.MasumiDigests;
import org.x402.mechanisms.cardano.exact.masumi.MasumiSchema;
import org.x402.mechanisms.cardano.exact.masumi.MasumiVerifier;
import org.x402.mechanisms.cardano.exact.script.ScriptAddresses;

/**
 * Cardano facilitator for the {@code exact} scheme. It enforces the spec's
 * facilitator verification rules 1–9 plus the Masumi and script checks before accepting a
 * payment, then broadcasts the client's signed transaction and waits, bounded, for the evidence
 * the selected {@code confirmationPolicy} requires. Below it the answer is {@code
 * settlement_pending} with the transaction id; the retry resumes observing the same
 * transaction, never broadcasting it again while its claim is retained.
 *
 * <p><b>Replay protection:</b> ledger evidence of a transaction is never accepted as validity, so a
 * landed payment cannot be replayed. Public verify enforces the TTL window and unspent inputs for
 * any
 * transaction this facilitator has not broadcast, refuses one that is in flight, rejected or
 * settled, and re-checks a submitted one (the retry after a pending answer) as settle's resume
 * does; a transaction is reported settled exactly once.
 *
 * <p>The duplicate-settlement guard is keyed by the canonical transaction id. The default store
 * is process-local and bounded; several replicas need a shared {@link
 * SettlementClaimStore}. With a {@code null} signer the facilitator runs provider-only.
 */
public class ExactCardanoFacilitatorScheme implements SchemeNetworkFacilitator {

  private static final System.Logger LOG = System.getLogger(ExactCardanoFacilitatorScheme.class.getName());
  private static final long VALIDITY_CLOSE_GRACE_MS = 120_000L;
  private static final SecureRandom RANDOM = new SecureRandom();
  private static final String STORE_UNAVAILABLE = "settlement store unavailable";
  private static final String BOUND_ELSEWHERE =
      "this transaction is bound to different payment requirements or resource";
  private static final String NO_USABLE_TTL =
      "a transaction without a usable TTL cannot be settled: its claim could never expire";

  private final CardanoChainBackend backend;
  private final CardanoFacilitatorSigner signer;
  private final ExactCardanoFacilitatorOptions options;

  /**
   * A provider-only facilitator with the default options.
   *
   * @param backend the chain backend
   */
  public ExactCardanoFacilitatorScheme(CardanoChainBackend backend) {
    this(backend, null, ExactCardanoFacilitatorOptions.defaults());
  }

  /**
   * Creates the facilitator scheme.
   *
   * @param backend the chain backend
   * @param signer the facilitator's addresses for {@code /supported}, or {@code null}
   *     (provider-only)
   * @param options the options, or {@code null} for the defaults
   */
  public ExactCardanoFacilitatorScheme(
      CardanoChainBackend backend, CardanoFacilitatorSigner signer, ExactCardanoFacilitatorOptions options) {
    this.backend = Objects.requireNonNull(backend, "backend");
    this.signer = signer;
    this.options = options == null ? ExactCardanoFacilitatorOptions.defaults() : options;
    for (String warning : configurationWarnings(this.backend, this.options)) {
      LOG.log(System.Logger.Level.WARNING, "[x402] " + warning);
    }
  }

  /**
   * Settings that do not do what they suggest: a configured confirmation wait longer than the
   * settle's budget for chain calls ({@code settleTimeout - chainCallReserve}), which always ends
   * the wait first, and a Blockfrost backend that waits for inclusion inside {@code
   * submitTransaction}, outside the settle timeout. The default confirmation timeout is not
   * reported: it stands for "as long as the settle allows" (the budget decides with the defaults).
   */
  static List<String> configurationWarnings(CardanoChainBackend backend, ExactCardanoFacilitatorOptions options) {
    List<String> warnings = new ArrayList<>();
    Duration budget = options.settleTimeout().minus(options.chainCallReserve());
    if (!options.confirmationTimeout().equals(ExactCardanoFacilitatorOptions.DEFAULT_CONFIRMATION_TIMEOUT)
        && options.confirmationTimeout().compareTo(budget) > 0) {
      warnings.add("Cardano confirmationTimeout (" + options.confirmationTimeout().toMillis()
          + " ms) exceeds what a settle leaves for it: settleTimeout (" + options.settleTimeout().toMillis()
          + " ms) less chainCallReserve (" + options.chainCallReserve().toMillis() + " ms) = "
          + budget.toMillis() + " ms, less the time verification and the broadcast took; the wait ends there,"
          + " so the longer value has no effect");
    }
    if (backend instanceof BlockfrostChainBackend blockfrost && blockfrost.config().awaitConfirmation()) {
      warnings.add("BlockfrostChainBackend is built with awaitConfirmation(true): submitTransaction then waits"
          + " up to requestTimeout (" + blockfrost.config().requestTimeout().toMillis() + " ms) for inclusion,"
          + " outside the settle timeout; build it with awaitConfirmation(false) for a facilitator, which"
          + " reads the evidence itself");
    }
    return warnings;
  }

  @Override
  public String scheme() {
    return CardanoConstants.SCHEME_EXACT;
  }

  @Override
  public String caipFamily() {
    return "cardano:*";
  }

  /**
   * The capabilities advertised in {@code /supported}: transfer methods, no fee sponsorship, and
   * the {@code l1Confirmations} range this facilitator can settle.
   *
   * @param network the network
   * @return the capability block
   */
  @Override
  public Map<String, Object> getExtra(String network) {
    Map<String, Object> range = new LinkedHashMap<>();
    range.put("minimum", options.acceptMempool() ? CardanoConstants.MIN_L1_CONFIRMATIONS : 0);
    range.put("maximum", canAuthenticateEvidence() ? CardanoConstants.MAX_L1_CONFIRMATIONS : 0);
    Map<String, Object> extra = new LinkedHashMap<>();
    extra.put(
        "assetTransferMethods",
        List.of(CardanoConstants.METHOD_DEFAULT, CardanoConstants.METHOD_MASUMI, CardanoConstants.METHOD_SCRIPT));
    extra.put("areFeesSponsored", false);
    extra.put("l1Confirmations", range);
    return extra;
  }

  @Override
  public List<String> getSigners(String network) {
    return signer == null ? List.of() : List.copyOf(signer.getAddresses());
  }

  @Override
  public final VerifyResponse verify(
      PaymentPayload payload, PaymentRequirements requirements, FacilitatorContext context) {
    return verify(payload, requirements);
  }

  @Override
  public final SettleResponse settle(
      PaymentPayload payload, PaymentRequirements requirements, FacilitatorContext context) {
    return settle(payload, requirements);
  }

  /**
   * Verifies a payment without broadcasting it.
   *
   * @param payload the payload
   * @param requirements the requirements
   * @return the verdict
   */
  public final VerifyResponse verify(PaymentPayload payload, PaymentRequirements requirements) {
    // An overriding verifyPayment or a backend may throw; verify answers a verdict either way.
    VerifyResponse verdict;
    try {
      verdict = verifyByClaimState(payload, requirements);
    } catch (RuntimeException e) {
      return invalid(CardanoErrors.INVALID_PAYLOAD + "_verification_error", message(e), "");
    }
    return verdict != null
        ? verdict
        : invalid(CardanoErrors.INVALID_PAYLOAD + "_verification_error", "verification returned no result", "");
  }

  private VerifyResponse verifyByClaimState(PaymentPayload payload, PaymentRequirements requirements) {
    // The claim store's state decides which verification applies; ledger
    // evidence alone never does.
    String txHash;
    try {
      String transaction = CardanoUtils.decodePayload(payload.payload()).transaction();
      txHash = CardanoTransactionDecoder.decode(transaction).txHash();
    } catch (RuntimeException e) {
      // Undecodable payloads are reported by the verification below.
      return verifyPayment(payload, requirements);
    }
    Optional<SettlementClaimDetails> details;
    try {
      details = options.settlementStore().claimDetails(txHash);
    } catch (RuntimeException e) {
      return invalid(CardanoErrors.SETTLEMENT_FAILED, "settlement store unavailable", "");
    }
    if (details == null || details.isEmpty()) {
      return verifyPayment(payload, requirements);
    }
    SettlementClaimDetails claim = details.get();
    if (claim.state() == SettlementClaimState.SUBMITTING || claim.state() == SettlementClaimState.SUBMITTED) {
      if (claim.bindingDigest() != null
          && !SettlementBinding.of(requirements, payload.resource()).matches(claim.bindingDigest())) {
        return invalid(CardanoErrors.DUPLICATE_SETTLEMENT, BOUND_ELSEWHERE, "");
      }
      // The spec's paid retry after a pending outcome repeats the same signature: verify the
      // broadcast transaction as settle's resume does, but only with proof that it was broadcast
      // (the ledger or a mempool shows it). Otherwise the skipped pre-broadcast checks (unspent
      // inputs, TTL, phase-1) would make a transaction the node rejected look valid.
      String unproven = "the transaction was broadcast but neither the ledger nor a mempool shows it";
      if (!canAuthenticateEvidence()) {
        return invalid(CardanoErrors.SETTLEMENT_PENDING, unproven, "");
      }
      SettlementEvidence evidence;
      try {
        evidence = readEvidence(txHash, requirements.network());
      } catch (RuntimeException e) {
        return invalid(CardanoErrors.SETTLEMENT_PENDING, "the evidence lookup failed: " + message(e), "");
      }
      if (evidence.status() == SettlementEvidence.Status.UNKNOWN) {
        return invalid(CardanoErrors.SETTLEMENT_PENDING, unproven, "");
      }
      VerifyResponse recheck = verifyBroadcast(payload, requirements, claim.payer());
      if (recheck.isValid() || resumeTerminal(recheck)) {
        return recheck;
      }
      // As settle's resume: a re-check that failed for the moment is no verdict on a broadcast
      // payment. Bound to these exact requirements (the binding matched above), which the
      // pre-broadcast verification passed, and shown by the ledger or a mempool, the payment goes on
      // to settle, whose resume lets the chain decide (success, pending or expired) and never
      // broadcasts again: a refusal here would keep a landed payment from ever being served.
      String payer = resumedPayer(recheck, claim);
      if (claim.bindingDigest() != null && !payer.isEmpty() && resumeMomentary(recheck)) {
        return VerifyResponse.valid(payer);
      }
      // Without a binding the re-check is the only content check, and a reason not known to
      // depend on the moment may be about the content: pending, never valid.
      return invalid(CardanoErrors.SETTLEMENT_PENDING, "re-verifying the broadcast transaction failed ("
          + recheck.invalidReason() + "); retry later", payer);
    }
    return invalid(CardanoErrors.DUPLICATE_SETTLEMENT, null, "");
  }

  /**
   * Verification rules 1-9 and the method checks for a payment that has not been broadcast. It
   * never accepts ledger evidence as validity: the TTL window and unspent inputs always apply.
   * Public verify and settle run it for every transaction this facilitator has not broadcast, so
   * an override tightens both. A transaction already broadcast (a retry after a pending answer)
   * is re-checked by a fixed internal verification instead, which an override does not change.
   * The public entry points are final; to adjust policy, prefer wrapping the scheme or a
   * facilitator hook over subclassing. A valid verdict's payer must be the nonce owner's address
   * (or {@code null}): settle records it at the broadcast fence, and a resume refuses a recorded
   * payer that differs from the nonce owner.
   *
   * @param payload the payload
   * @param requirements the requirements
   * @return the verdict
   */
  protected VerifyResponse verifyPayment(PaymentPayload payload, PaymentRequirements requirements) {
    return runVerification(payload, requirements, false, null);
  }

  /**
   * Verification of a transaction this facilitator already broadcast: the pre-broadcast
   * preconditions (unspent inputs, unexpired TTL, phase-1, dry-run) are skipped; recipient,
   * asset, amount and method checks still run. Only the nonce is looked up; its owner must be
   * a witness, and must equal the payer recorded at the broadcast fence when both are known.
   * Internal to settle's resume of its own retained claim.
   */
  private VerifyResponse verifyBroadcast(
      PaymentPayload payload, PaymentRequirements requirements, String journaledPayer) {
    return runVerification(payload, requirements, true, journaledPayer);
  }

  private boolean canAuthenticateEvidence() {
    try {
      return backend.supportsTransactionEvidence();
    } catch (RuntimeException e) {
      // A capability that cannot be read is not offered.
      return false;
    }
  }

  /** A custom backend's {@code null} evidence or status means "not known". */
  private SettlementEvidence readEvidence(String txHash, String network) {
    SettlementEvidence evidence = backend.getTransactionEvidence(txHash, network);
    return evidence == null || evidence.status() == null ? SettlementEvidence.unknown() : evidence;
  }

  private static String message(Throwable e) {
    return e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
  }

  private static VerifyResponse invalid(String reason, String message, String payer) {
    return new VerifyResponse(false, reason, message, payer, null, null, null);
  }

  // ---------------------------------------------------------------- verify

  private VerifyResponse runVerification(
      PaymentPayload payload, PaymentRequirements requirements, boolean alreadyBroadcast, String journaledPayer) {
    try {
      return verification(payload, requirements, alreadyBroadcast, journaledPayer);
    } catch (RuntimeException e) {
      return invalid(CardanoErrors.INVALID_PAYLOAD + "_verification_error", message(e), "");
    }
  }

  @SuppressWarnings("checkstyle:MethodLength")
  private VerifyResponse verification(
      PaymentPayload payload, PaymentRequirements requirements, boolean alreadyBroadcast, String journaledPayer) {
    if (payload.x402Version() != 2) {
      return invalid(CardanoErrors.INVALID_PAYLOAD + "_unsupported_version", null, "");
    }
    PaymentRequirements accepted = payload.accepted();
    if (accepted == null
        || !CardanoConstants.SCHEME_EXACT.equals(accepted.scheme())
        || !CardanoConstants.SCHEME_EXACT.equals(requirements.scheme())) {
      return invalid(CardanoErrors.UNSUPPORTED_SCHEME, null, "");
    }
    if (!Objects.equals(CardanoNetworks.normalize(accepted.network()), CardanoNetworks.normalize(requirements.network()))) {
      return invalid(CardanoErrors.NETWORK_MISMATCH, null, "");
    }
    if (!CardanoNetworks.isCardanoNetwork(requirements.network())) {
      return invalid(CardanoErrors.NETWORK_MISMATCH, null, "");
    }
    if (requirements.amount() == null
        || requirements.asset() == null
        || !CardanoConstants.POSITIVE_CANONICAL_AMOUNT.matcher(requirements.amount()).matches()
        || !CardanoConstants.CANONICAL_ASSET.matcher(requirements.asset()).matches()) {
      return invalid(
          CardanoErrors.REQUIREMENTS_INVALID, "amount and asset must use their positive canonical wire forms", "");
    }
    if (!alreadyBroadcast && requirements.maxTimeoutSeconds() <= 0) {
      return invalid(CardanoErrors.REQUIREMENTS_INVALID, "maxTimeoutSeconds must be positive", "");
    }
    int expectedNetworkId = CardanoNetworks.networkId(requirements.network());
    if (!isPaymentAddressOn(requirements.payTo(), expectedNetworkId)) {
      return invalid(CardanoErrors.REQUIREMENTS_INVALID,
          "payTo must be a Shelley payment address on " + requirements.network(), "");
    }

    CardanoUtils.ExactCardanoPayload cardanoPayload;
    try {
      cardanoPayload = CardanoUtils.decodePayload(payload.payload());
    } catch (IllegalArgumentException e) {
      return invalid(CardanoErrors.INVALID_PAYLOAD, message(e), "");
    }

    // The confirmation policy always comes from the canonical requirements, never from `accepted`.
    Integer l1Confirmations = CardanoPolicies.l1Confirmations(requirements.extra());
    if (l1Confirmations == null) {
      return invalid(CardanoErrors.POLICY_INVALID, null, "");
    }

    CardanoUtils.UtxoRef nonce;
    try {
      if (cardanoPayload.nonce() != null && cardanoPayload.nonce().length() > MAX_NONCE_LENGTH) {
        throw new IllegalArgumentException("nonce too long");
      }
      nonce = CardanoUtils.parseUtxoRef(cardanoPayload.nonce());
    } catch (IllegalArgumentException e) {
      return invalid(CardanoErrors.NONCE_INVALID, null, "");
    }

    DecodedCardanoTransaction decoded;
    try {
      decoded = CardanoTransactionDecoder.decode(cardanoPayload.transaction());
    } catch (RuntimeException e) {
      return invalid(CardanoErrors.TRANSACTION_DECODE_FAILED, message(e), "");
    }

    if (decoded.inputs().size() > CardanoConstants.MAX_TRANSACTION_INPUTS) {
      return invalid(
          CardanoErrors.TRANSACTION_PHASE1_INVALID,
          "transaction has " + decoded.inputs().size() + " inputs; verification permits at most "
              + CardanoConstants.MAX_TRANSACTION_INPUTS,
          "");
    }

    // Rule 1: a declared body network id must match; absence is allowed (rule 2 checks the
    // network-tagged address).
    if (decoded.networkId() != null && decoded.networkId() != expectedNetworkId) {
      return invalid(CardanoErrors.NETWORK_ID_MISMATCH, null, "");
    }
    if (decoded.vkeyWitnessCount() == 0 && decoded.scriptWitnessCount() == 0) {
      return invalid(CardanoErrors.TRANSACTION_UNSIGNED, null, "");
    }
    if (!decoded.signaturesValid()) {
      return invalid(CardanoErrors.INVALID_SIGNATURE, null, "");
    }

    // Rule 5 (input check): unique inputs, nonce among them.
    Set<String> inputSet = new HashSet<>();
    for (String input : decoded.inputs()) {
      inputSet.add(input.toLowerCase(Locale.ROOT));
    }
    if (inputSet.size() != decoded.inputs().size()) {
      return invalid(CardanoErrors.TRANSACTION_PHASE1_INVALID, "transaction contains duplicate inputs", "");
    }
    String nonceRef = nonce.txHash() + "#" + nonce.index();
    if (!inputSet.contains(nonceRef)) {
      return invalid(CardanoErrors.NONCE_NOT_IN_INPUTS, null, "");
    }
    if (!decoded.isValid()) {
      return invalid(CardanoErrors.TRANSACTION_PHASE2_INVALID, null, "");
    }

    // Ledger evidence alone is never accepted here:
    // only settle's resume of its own retained claim may skip the pre-broadcast checks.
    boolean acceptedByLedger = alreadyBroadcast;

    // Rule 7: TTL bounds through the network's slot configuration. A TTL is required: rule 7's
    // upper bound cannot hold without one, and a claim on a transaction without one could never
    // expire. A transaction already broadcast is judged by the ledger instead.
    if (!acceptedByLedger && decoded.ttlSlot() == null) {
      return invalid(CardanoErrors.TTL_TOO_FAR, "transaction has no TTL; maxTimeoutSeconds bounds it", "");
    }
    if (decoded.ttlSlot() != null || decoded.validityStartSlot() != null) {
      BigInteger currentSlot;
      try {
        currentSlot = BigInteger.valueOf(backend.getCurrentSlot(requirements.network()));
      } catch (RuntimeException e) {
        return invalid(CardanoErrors.CHAIN_LOOKUP_FAILED, message(e), "");
      }
      if (decoded.ttlSlot() != null) {
        if (!acceptedByLedger && decoded.ttlSlot().compareTo(currentSlot) <= 0) {
          return invalid(CardanoErrors.TTL_EXPIRED, null, "");
        }
        SlotConfig slots = options.slotConfigFor(requirements.network());
        BigInteger ttlMs = CardanoNetworks.slotToPosixMs(slots, decoded.ttlSlot());
        BigInteger latestMs =
            CardanoNetworks.slotToPosixMs(slots, currentSlot)
                .add(BigInteger.valueOf(requirements.maxTimeoutSeconds()).multiply(BigInteger.valueOf(1000)));
        if (ttlMs.compareTo(latestMs) > 0) {
          return invalid(CardanoErrors.TTL_TOO_FAR, null, "");
        }
      }
      if (decoded.validityStartSlot() != null && decoded.validityStartSlot().compareTo(currentSlot) > 0) {
        return invalid(CardanoErrors.VALIDITY_NOT_YET_VALID, null, "");
      }
    }

    List<UtxoSnapshot> inputSnapshots = new ArrayList<>();
    String payer;
    if (acceptedByLedger) {
      // A broadcast transaction: only the nonce is looked up, for its owner. A failed lookup
      // leaves the owner unknown, and the payer recorded at the broadcast fence stands in; an
      // unauthenticated payer never does.
      UtxoSnapshot nonceOnly;
      try {
        nonceOnly = backend.getUtxo(nonceRef, requirements.network());
      } catch (RuntimeException e) {
        nonceOnly = null;
      }
      String owner = nonceOnly == null || nonceOnly.address() == null || nonceOnly.address().isBlank()
          ? null : nonceOnly.address();
      String journaled = journaledPayer == null || journaledPayer.isBlank() ? null : journaledPayer;
      if (owner != null && journaled != null && !owner.equals(journaled)) {
        return invalid(CardanoErrors.TRANSACTION_PHASE1_INVALID,
            "the payer recorded at broadcast differs from the nonce owner", owner);
      }
      payer = owner != null ? owner : journaled;
      if (payer == null) {
        return invalid(CardanoErrors.NONCE_NOT_ON_CHAIN, "could not resolve the owner of the nonce UTXO", "");
      }
      if (!payerWitnessed(payer, decoded)) {
        return invalid(CardanoErrors.TRANSACTION_PHASE1_INVALID,
            "the payer " + payer + " is not a witness of the transaction", payer);
      }
    } else {
      // Rule 5 (on chain): resolve every input. The nonce first: a payment whose nonce is spent,
      // or whose nonce owner did not sign, is refused before the other inputs cost a lookup each.
      // Every input that does not exist is refused as it is resolved.
      UtxoSnapshot nonceSnapshot;
      String unanswered = null;
      try {
        if (decoded.inputs().size() > options.maxInputLookups()) {
          return invalid(CardanoErrors.CHAIN_LOOKUP_FAILED, "transaction has " + decoded.inputs().size()
              + " inputs; one verification resolves at most " + options.maxInputLookups(), "");
        }
        long deadline = System.nanoTime() + options.lookupTimeout().toNanos();
        nonceSnapshot = backend.getUtxo(nonceRef, requirements.network());
        if (nonceSnapshot == null || !nonceSnapshot.exists()) {
          return invalid(CardanoErrors.NONCE_NOT_ON_CHAIN, null,
              nonceSnapshot == null || nonceSnapshot.address() == null ? "" : nonceSnapshot.address());
        }
        String owner = nonceSnapshot.address() == null ? "" : nonceSnapshot.address();
        String unsigned = unsignedNonceOwner(nonceSnapshot, decoded);
        if (unsigned != null) {
          return invalid(CardanoErrors.TRANSACTION_PHASE1_INVALID, "the nonce UTXO is owned by key hash " + unsigned
              + " but the transaction carries no witness for it", owner);
        }
        for (String ref : decoded.inputs()) {
          if (ref.toLowerCase(Locale.ROOT).equals(nonceRef)) {
            inputSnapshots.add(nonceSnapshot);
            continue;
          }
          if (System.nanoTime() - deadline > 0) {
            return invalid(CardanoErrors.CHAIN_LOOKUP_FAILED,
                "chain lookups exceeded the verification budget", "");
          }
          UtxoSnapshot snapshot = backend.getUtxo(ref, requirements.network());
          if (snapshot == null) {
            // Noted, not refused yet: a later spent input, failed lookup or spent budget keeps
            // its own reason.
            unanswered = unanswered == null ? ref : unanswered;
            continue;
          }
          if (!snapshot.exists()) {
            return invalid(CardanoErrors.INPUT_NOT_AVAILABLE, null, owner);
          }
          inputSnapshots.add(snapshot);
        }
      } catch (RuntimeException e) {
        return invalid(CardanoErrors.CHAIN_LOOKUP_FAILED, message(e), "");
      }
      if (unanswered != null) {
        // A backend that answers no snapshot breaks its contract: no verdict on the payment.
        return invalid(CardanoErrors.INVALID_PAYLOAD + "_verification_error",
            "the chain backend answered no snapshot for input " + unanswered, "");
      }
      payer = nonceSnapshot.address() == null ? "" : nonceSnapshot.address();
      if (payer.isEmpty()) {
        return invalid(CardanoErrors.NONCE_NOT_ON_CHAIN, "could not resolve the owner of the nonce UTXO", "");
      }
    }

    ProtocolParams protocolParameters;
    try {
      protocolParameters = backend.getProtocolParameters(requirements.network());
      if (protocolParameters != null) {
        // Read every value used below now, so a malformed answer is a lookup failure.
        CardanoUtils.requireComplete(protocolParameters);
      }
    } catch (RuntimeException e) {
      return invalid(CardanoErrors.CHAIN_LOOKUP_FAILED, message(e), payer);
    }

    // Rule 6 (phase-1), before the ledger has the transaction.
    if (!acceptedByLedger) {
      Phase1Checks.Result phase1 =
          checkPhase1(cardanoPayload.transaction(), decoded, inputSnapshots, protocolParameters, requirements.network());
      if (!phase1.ok()) {
        return invalid(phase1.reason(), phase1.detail(), payer);
      }
    }

    // Rules 2, 3, 4, 8.
    BigInteger requestedAmount = new BigInteger(requirements.amount());
    String assetKey = requirements.asset().toLowerCase(Locale.ROOT);
    boolean isLovelace = CardanoConstants.LOVELACE.equals(assetKey);
    boolean recipientFound = false;
    boolean assetFoundForRecipient = false;
    BigInteger bestAvailable = BigInteger.ZERO;
    for (DecodedCardanoTransaction.Output output : decoded.outputs()) {
      if (!output.address().equals(requirements.payTo())) {
        continue;
      }
      recipientFound = true;
      BigInteger available = isLovelace ? output.coin() : output.assets().get(assetKey);
      if (available == null) {
        continue;
      }
      assetFoundForRecipient = true;
      if (available.compareTo(bestAvailable) > 0) {
        bestAvailable = available;
      }
      if (available.compareTo(requestedAmount) < 0) {
        continue;
      }
      BigInteger coinsPerUtxoByte = protocolParameters == null ? null : CardanoUtils.coinsPerUtxoByte(protocolParameters);
      if (coinsPerUtxoByte != null) {
        BigInteger minUtxo = CardanoUtils.minUtxoLovelace(output.serializedSize(), coinsPerUtxoByte);
        if (output.coin().compareTo(minUtxo) < 0) {
          return invalid(
              CardanoErrors.MIN_UTXO_INSUFFICIENT,
              "output to " + requirements.payTo() + " carries " + output.coin() + " lovelace, min-UTXO requires "
                  + minUtxo,
              payer);
        }
      }
      // Every other output (change included) on the same network. Checked once the payment itself
      // matched, so the recipient, asset and amount reasons keep their precedence.
      for (DecodedCardanoTransaction.Output other : decoded.outputs()) {
        if (!isPaymentAddressOn(other.address(), expectedNetworkId)) {
          return invalid(CardanoErrors.NETWORK_ID_MISMATCH, "output to " + other.address() + " is on another network",
              payer);
        }
      }
      // The method comes from the canonical requirements, never from the client-echoed `accepted`.
      MasumiVerifier.Check methodCheck =
          runMethodSpecificChecks(requirements, decoded, payload, payer, coinsPerUtxoByte);
      if (!methodCheck.ok()) {
        String detail = methodCheck.detail() == null || methodCheck.detail().isEmpty() ? null : methodCheck.detail();
        return invalid(methodCheck.reason(), detail, payer);
      }
      if (!acceptedByLedger) {
        try {
          backend.evaluateTransaction(cardanoPayload.transaction(), requirements.network());
        } catch (RuntimeException e) {
          return invalid(CardanoErrors.CHAIN_LOOKUP_FAILED, message(e), payer);
        }
      }
      if (l1Confirmations > 0 && !canAuthenticateEvidence()) {
        return invalid(
            CardanoErrors.EVIDENCE_UNAVAILABLE,
            "confirmation depth above canonical inclusion requires transaction evidence",
            payer);
      }
      return VerifyResponse.valid(payer);
    }

    if (!recipientFound) {
      return invalid(CardanoErrors.RECIPIENT_MISMATCH, null, payer);
    }
    if (!assetFoundForRecipient) {
      return invalid(CardanoErrors.ASSET_MISMATCH, null, payer);
    }
    return invalid(
        CardanoErrors.AMOUNT_INSUFFICIENT,
        "output to " + requirements.payTo() + " pays " + bestAvailable + ", requires " + requestedAmount,
        payer);
  }

  /**
   * The checks of the transfer method in {@code requirements.extra.assetTransferMethod}:
   * nothing more for {@code default}, the escrow lock for {@code masumi}, the script address for
   * {@code script}.
   *
   * @param requirements the canonical requirements
   * @param decoded the decoded transaction
   * @param payload the payment payload
   * @param payer the nonce owner
   * @param coinsPerUtxoByte live {@code coinsPerUtxoByte}, or {@code null}
   * @return OK or the failure
   */
  protected MasumiVerifier.Check runMethodSpecificChecks(
      PaymentRequirements requirements,
      DecodedCardanoTransaction decoded,
      PaymentPayload payload,
      String payer,
      BigInteger coinsPerUtxoByte) {
    Map<String, Object> extra = requirements.extra();
    Object method = extra.get("assetTransferMethod");
    if (method == null || CardanoConstants.METHOD_DEFAULT.equals(method)) {
      return MasumiVerifier.Check.OK;
    }
    if (CardanoConstants.METHOD_MASUMI.equals(method)) {
      return MasumiVerifier.verifyLock(
          extra,
          requirements,
          decoded,
          new MasumiVerifier.LockContext(
              payer, coinsPerUtxoByte, options.registryValidator(), payload.resource(), options.deploymentValidator(),
              options.slotConfigFor(requirements.network()), options.masumiAllowedScriptHashes()));
    }
    if (CardanoConstants.METHOD_SCRIPT.equals(method)) {
      if (!ScriptAddresses.truthy(extra.get("scriptHash")) && !ScriptAddresses.truthy(extra.get("script"))) {
        return new MasumiVerifier.Check(false, CardanoErrors.SCRIPT_ADDRESS_MISMATCH, null);
      }
      if (!ScriptAddresses.scriptAddressMatches(extra, requirements.payTo())) {
        return new MasumiVerifier.Check(false, CardanoErrors.SCRIPT_ADDRESS_MISMATCH, null);
      }
      return scriptDatumCheck(extra, requirements, decoded);
    }
    return new MasumiVerifier.Check(false, CardanoErrors.UNSUPPORTED_SCHEME, null);
  }

  /**
   * The script datum policy on the locked output (the first payTo output that pays the amount).
   * Datum contents are never interpreted.
   */
  private MasumiVerifier.Check scriptDatumCheck(
      Map<String, Object> extra, PaymentRequirements requirements, DecodedCardanoTransaction decoded) {
    DecodedCardanoTransaction.Output locked = lockedOutput(requirements, decoded);
    if (locked == null) {
      return new MasumiVerifier.Check(false, CardanoErrors.SCRIPT_DATUM_MISSING, null);
    }
    boolean inline = locked.datum() != null;
    boolean hash = locked.hasDatumHash();
    Object script = extra.get("script");
    Object type = script instanceof Map<?, ?> m ? m.get("type") : null;
    String version = type instanceof String t ? t : "unknown";
    ScriptDatumPolicy policy = options.scriptDatumPolicy();
    boolean missing;
    if (policy == ScriptDatumPolicy.REFERENCE) {
      // Plutus V1 has no inline datums: such an output can never be spent.
      missing = "plutusV1".equals(version) && inline;
    } else {
      missing = switch (version) {
        case "plutusV1" -> !hash;
        case "plutusV3" -> !inline && !hash && policy != ScriptDatumPolicy.V3_OPTIONAL;
        default -> !inline && !hash;
      };
    }
    return missing
        ? new MasumiVerifier.Check(false, CardanoErrors.SCRIPT_DATUM_MISSING,
            "the locked output carries no datum a " + version + " script can spend under the "
                + policy.name().toLowerCase(Locale.ROOT).replace('_', '-') + " policy")
        : MasumiVerifier.Check.OK;
  }

  private static DecodedCardanoTransaction.Output lockedOutput(
      PaymentRequirements requirements, DecodedCardanoTransaction decoded) {
    BigInteger amount = new BigInteger(requirements.amount());
    String assetKey = requirements.asset().toLowerCase(Locale.ROOT);
    boolean isLovelace = CardanoConstants.LOVELACE.equals(assetKey);
    for (DecodedCardanoTransaction.Output output : decoded.outputs()) {
      if (!output.address().equals(requirements.payTo())) {
        continue;
      }
      BigInteger available = isLovelace ? output.coin() : output.assets().get(assetKey);
      if (available != null && available.compareTo(amount) >= 0) {
        return output;
      }
    }
    return null;
  }

  /** Body fields a plain payment may carry: inputs, outputs, fee, TTL, aux hash, start, signers, network. */
  private static final Set<Integer> PLAIN_BODY_KEYS = Set.of(0, 1, 2, 3, 7, 8, 14, 15);

  /** Balance-changing body fields, refused with their own message without a full validator. */
  private static final Set<Integer> BALANCE_CHANGING_KEYS = Set.of(4, 5, 9, 20, 22);

  /** A 64-hex transaction id, {@code #}, and an index of at most ten digits. */
  private static final int MAX_NONCE_LENGTH = 75;

  private static boolean isPaymentAddressOn(String address, int networkId) {
    try {
      return address != null && CardanoAddresses.parse(address).networkId() == networkId;
    } catch (RuntimeException e) {
      return false;
    }
  }

  /** Whether the transaction carries the payer's witness: its key, or a script for a script payer. */
  private static boolean payerWitnessed(String payer, DecodedCardanoTransaction decoded) {
    try {
      var credential = CardanoAddresses.parse(payer).payment();
      if (credential == null) {
        return false;
      }
      if (CardanoAddresses.isScript(credential)) {
        return decoded.scriptWitnessCount() > 0;
      }
      return decoded.vkeyHashes().contains(CardanoAddresses.hashHex(credential).toLowerCase(Locale.ROOT));
    } catch (RuntimeException e) {
      return false;
    }
  }

  /** The nonce owner's key hash when the transaction does not witness it, else {@code null}. */
  private static String unsignedNonceOwner(UtxoSnapshot nonce, DecodedCardanoTransaction decoded) {
    if (nonce == null || !nonce.exists()) {
      return null;
    }
    String keyHash;
    try {
      keyHash = nonce.address() != null ? CardanoAddresses.paymentKeyHash(nonce.address()) : nonce.paymentKeyHash();
    } catch (RuntimeException e) {
      return null;
    }
    return keyHash == null || decoded.vkeyHashes().contains(keyHash.toLowerCase(Locale.ROOT)) ? null : keyHash;
  }

  private Phase1Checks.Result checkPhase1(
      String transaction,
      DecodedCardanoTransaction decoded,
      List<UtxoSnapshot> inputs,
      ProtocolParams protocolParameters,
      String network) {
    boolean fullValidator = backend.supportsPhase1Validation();
    Set<String> keyWitnesses = new HashSet<>(decoded.vkeyHashes());
    for (String signer : decoded.requiredSigners()) {
      if (!keyWitnesses.contains(signer)) {
        return new Phase1Checks.Result(false, CardanoErrors.TRANSACTION_PHASE1_INVALID,
            "required signer " + signer + " has no witness");
      }
    }
    if (!fullValidator) {
      for (Integer key : decoded.bodyKeys()) {
        if (!PLAIN_BODY_KEYS.contains(key) && !BALANCE_CHANGING_KEYS.contains(key)) {
          return new Phase1Checks.Result(false, CardanoErrors.TRANSACTION_PHASE1_INVALID,
              "transaction body field " + key + " needs a complete phase-1 validator; without one only plain "
                  + "payments are accepted");
        }
      }
    }
    Integer protocolMax = protocolParameters == null ? null : protocolParameters.getMaxTxSize();
    int maxBytes = protocolMax == null ? options.maxTransactionBytes()
        : Math.min(options.maxTransactionBytes(), protocolMax);
    if (decoded.sizeBytes() > maxBytes) {
      return new Phase1Checks.Result(false, CardanoErrors.TRANSACTION_PHASE1_INVALID,
          "transaction is " + decoded.sizeBytes() + " bytes; at most " + maxBytes + " are accepted");
    }
    if (protocolParameters != null) {
      BigInteger coinsPerUtxoByte = CardanoUtils.coinsPerUtxoByte(protocolParameters);
      for (DecodedCardanoTransaction.Output output : decoded.outputs()) {
        BigInteger minUtxo = CardanoUtils.minUtxoLovelace(output.serializedSize(), coinsPerUtxoByte);
        if (output.coin().compareTo(minUtxo) < 0) {
          return new Phase1Checks.Result(false, CardanoErrors.MIN_UTXO_INSUFFICIENT,
              "output to " + output.address() + " carries " + output.coin() + " lovelace, min-UTXO requires "
                  + minUtxo);
        }
      }
    }
    if (!decoded.balanceChangingOperations().isEmpty()) {
      if (!fullValidator) {
        return new Phase1Checks.Result(
            false,
            CardanoErrors.TRANSACTION_PHASE1_INVALID,
            "transaction carries " + String.join(", ", decoded.balanceChangingOperations())
                + "; without a complete phase-1 validator only plain payments are accepted");
      }
    } else {
      Phase1Checks.Result conserved = Phase1Checks.checkValueConservation(decoded, inputs);
      if (!conserved.ok()) {
        return conserved;
      }
    }
    if (protocolParameters != null) {
      Phase1Checks.Result fee = Phase1Checks.checkMinimumFee(decoded, protocolParameters);
      if (!fee.ok()) {
        return fee;
      }
    }
    Phase1Checks.Result witnessed = Phase1Checks.checkWitnessCoverage(decoded, inputs, fullValidator);
    if (!witnessed.ok()) {
      return witnessed;
    }
    if (fullValidator) {
      try {
        backend.validatePhase1Transaction(transaction, network);
      } catch (RuntimeException e) {
        return new Phase1Checks.Result(false, CardanoErrors.TRANSACTION_PHASE1_INVALID, message(e));
      }
    }
    return Phase1Checks.Result.OK;
  }

  // ---------------------------------------------------------------- settle

  /** The decoded payment state settle needs before any chain lookup. */
  private record Resolved(CardanoUtils.ExactCardanoPayload payload, DecodedCardanoTransaction decoded, int required) {}

  private static SettleResponse fail(String reason, String transaction, String message, String network) {
    return SettleResponse.failure(reason, message == null || message.isEmpty() ? null : message, transaction, network);
  }

  /**
   * Settles a payment: claim the canonical transaction id (with the Masumi terms digest), verify,
   * broadcast and wait, bounded, for the policy's evidence. A retry for a transaction already
   * broadcast resumes observing it and never submits again.
   *
   * @param payload the payload
   * @param requirements the requirements
   * @return success, pending or failure
   */
  public final SettleResponse settle(PaymentPayload payload, PaymentRequirements requirements) {
    if (payload == null || requirements == null) {
      return fail(CardanoErrors.INVALID_PAYLOAD, null, "payload and requirements are required",
          requirements == null ? null : requirements.network());
    }
    String network = payload.accepted() == null ? requirements.network() : payload.accepted().network();
    long deadline = deadline();

    Resolved resolved;
    CardanoUtils.ExactCardanoPayload cardanoPayload;
    try {
      cardanoPayload = CardanoUtils.decodePayload(payload.payload());
    } catch (IllegalArgumentException e) {
      return fail(CardanoErrors.INVALID_PAYLOAD, "", message(e), network);
    }
    DecodedCardanoTransaction decoded;
    try {
      decoded = CardanoTransactionDecoder.decode(cardanoPayload.transaction());
    } catch (RuntimeException e) {
      return fail(CardanoErrors.TRANSACTION_DECODE_FAILED, "", message(e), network);
    }
    Integer required = CardanoPolicies.l1Confirmations(requirements.extra());
    if (required == null) {
      return fail(CardanoErrors.POLICY_INVALID, "", null, network);
    }
    resolved = new Resolved(cardanoPayload, decoded, required);
    String txHash = decoded.txHash();

    SettlementClaimStore store = options.settlementStore();
    // A fresh claim must be able to expire. Only a transaction the store already holds (one
    // broadcast before a TTL was required) may proceed without one, and then only to resume.
    Long retainUntil = retainUntilMs(decoded, requirements.network());
    if (retainUntil == null) {
      Optional<SettlementClaimState> known;
      try {
        known = store.claimState(txHash);
      } catch (RuntimeException e) {
        return fail(CardanoErrors.SETTLEMENT_FAILED, txHash, STORE_UNAVAILABLE, network);
      }
      if (known == null || known.isEmpty()) {
        return fail(CardanoErrors.TTL_TOO_FAR, txHash, NO_USABLE_TTL, network);
      }
    }
    String termsDigest;
    try {
      termsDigest = masumiTermsDigest(requirements);
    } catch (RuntimeException e) {
      return fail(CardanoErrors.SETTLEMENT_FAILED, txHash, message(e), network);
    }
    SettlementBinding binding;
    try {
      binding = SettlementBinding.of(requirements, payload.resource());
    } catch (RuntimeException e) {
      return fail(CardanoErrors.SETTLEMENT_FAILED, txHash, "cannot bind the settlement: " + message(e), network);
    }

    // Claim the transaction id and the optional Masumi terms digest atomically, before any
    // chain lookup, so two concurrent calls cannot both reach the node.
    String ownerToken = newOwnerToken();
    SettlementClaimResult claim;
    try {
      claim = store.claimSettlement(new SettlementClaim(txHash, ownerToken, termsDigest, retainUntil, binding));
    } catch (RuntimeException e) {
      claim = null;
    }
    if (claim == null) {
      quietly(() -> store.releaseClaim(txHash, ownerToken));
      return fail(CardanoErrors.SETTLEMENT_FAILED, txHash, STORE_UNAVAILABLE, network);
    }
    // Every result is handled explicitly; only FRESH reaches the broadcast.
    switch (claim) {
      case FRESH:
        if (retainUntil == null) {
          // The record vanished between the check above and the claim.
          quietly(() -> store.releaseClaim(txHash, ownerToken));
          return fail(CardanoErrors.TTL_TOO_FAR, txHash, NO_USABLE_TTL, network);
        }
        return settledOnce(settleFresh(payload, requirements, resolved, ownerToken, network, deadline),
            txHash, ownerToken, network, binding);
      case IN_FLIGHT:
        return pendingResponse(txHash, network, "", new LinkedHashMap<>(),
            "another settlement of this transaction is in progress; retry to resume");
      case SUBMITTING:
      case SUBMITTED:
        return settledOnce(resume(payload, requirements, resolved, network, binding, deadline),
            txHash, ownerToken, network, binding);
      case SETTLED:
        // A same-binding retry of a settled payment answers success again only on freshly read
        // evidence; a store that does not vouch for the binding keeps it a duplicate.
        if (!attested(quietDetails(txHash), binding)) {
          return fail(CardanoErrors.DUPLICATE_SETTLEMENT, txHash, "this transaction was already settled", network);
        }
        return resume(payload, requirements, resolved, network, binding, deadline);
      case REJECTED:
        return fail(
            CardanoErrors.SETTLEMENT_DEFINITIVELY_REJECTED,
            txHash,
            "this transaction was definitively rejected before ledger acceptance",
            network);
      case TERMS_CONFLICT:
        return fail(
            CardanoErrors.DUPLICATE_SETTLEMENT, txHash, "termsDigest is already bound to another transaction", network);
      case BINDING_MISMATCH:
        return fail(CardanoErrors.DUPLICATE_SETTLEMENT, txHash, BOUND_ELSEWHERE, network);
      case CAPACITY_EXCEEDED:
        return fail(CardanoErrors.SETTLEMENT_FAILED, txHash, "the Cardano settlement store is at capacity", network);
      default:
        // An outcome this scheme does not know: never broadcast.
        quietly(() -> store.releaseClaim(txHash, ownerToken));
        return fail(CardanoErrors.SETTLEMENT_FAILED, txHash, "unrecognised settlement claim result", network);
    }
  }

  /** The stored claim, or {@code null} when it is unknown or cannot be read. */
  private SettlementClaimDetails quietDetails(String txHash) {
    try {
      Optional<SettlementClaimDetails> details = options.settlementStore().claimDetails(txHash);
      return details == null ? null : details.orElse(null);
    } catch (RuntimeException e) {
      return null;
    }
  }

  /** Whether the store vouches that a settled claim has this binding. */
  private static boolean attested(SettlementClaimDetails details, SettlementBinding binding) {
    return details != null && details.state() == SettlementClaimState.SETTLED
        && details.bindingDigest() != null && binding.matches(details.bindingDigest());
  }

  /**
   * Records a success in the store before reporting it: if the store cannot record it, the
   * answer is pending and a retry resumes. When another call recorded it first, this request's
   * own evidence still counts if the store vouches for the binding; a store that cannot answers
   * a duplicate.
   */
  private SettleResponse settledOnce(
      SettleResponse response, String txHash, String ownerToken, String network, SettlementBinding binding) {
    if (!response.success()) {
      return response;
    }
    boolean recorded;
    try {
      recorded = options.settlementStore().markSettled(txHash, ownerToken);
    } catch (RuntimeException e) {
      Map<String, Object> extra = response.extra() == null ? new LinkedHashMap<>() : new LinkedHashMap<>(response.extra());
      return pendingResponse(txHash, network, response.payer(), extra,
          "the settlement store could not record the outcome; retry to resume");
    }
    if (recorded) {
      return response;
    }
    SettlementClaimDetails details = quietDetails(txHash);
    if (attested(details, binding)) {
      return response;
    }
    if (details != null && details.state() == SettlementClaimState.SETTLED) {
      return fail(CardanoErrors.DUPLICATE_SETTLEMENT, txHash, "this transaction was already settled", network);
    }
    return pendingResponse(txHash, network, response.payer(), new LinkedHashMap<>(),
        "the settlement could not be recorded yet; retry to resume");
  }

  /** Runs a store write whose failure must not change the answer; reports whether it ran. */
  private static boolean quietly(Runnable storeWrite) {
    try {
      storeWrite.run();
      return true;
    } catch (RuntimeException e) {
      return false;
    }
  }

  /** The TTL's POSIX time plus the validity grace, or {@code null} when unknown. */
  private Long retainUntilMs(DecodedCardanoTransaction decoded, String network) {
    if (decoded.ttlSlot() == null) {
      return null;
    }
    try {
      BigInteger until =
          CardanoNetworks.slotToPosixMs(options.slotConfigFor(network), decoded.ttlSlot())
              .add(BigInteger.valueOf(VALIDITY_CLOSE_GRACE_MS));
      return until.min(BigInteger.valueOf(Long.MAX_VALUE)).longValue();
    } catch (RuntimeException e) {
      return null;
    }
  }

  private static String newOwnerToken() {
    byte[] token = new byte[16];
    RANDOM.nextBytes(token);
    return HexFormat.of().formatHex(token);
  }

  /** The pending-settlement retry: this facilitator already broadcast this exact transaction. */
  private SettleResponse resume(PaymentPayload payload, PaymentRequirements requirements, Resolved resolved,
      String network, SettlementBinding binding, long deadline) {
    String txHash = resolved.decoded().txHash();
    SettlementClaimDetails claim;
    try {
      Optional<SettlementClaimDetails> details = options.settlementStore().claimDetails(txHash);
      claim = details == null ? null : details.orElse(null);
    } catch (RuntimeException e) {
      return pendingResponse(txHash, network, "", new LinkedHashMap<>(),
          "the settlement store is unavailable; retry to resume");
    }
    if (claim != null && claim.bindingDigest() != null && !binding.matches(claim.bindingDigest())) {
      return fail(CardanoErrors.DUPLICATE_SETTLEMENT, txHash, BOUND_ELSEWHERE, network);
    }
    VerifyResponse recheck = verifyBroadcast(payload, requirements, claim == null ? null : claim.payer());
    String payer = resumedPayer(recheck, claim);
    String recheckFailure = null;
    boolean providerFailing = false;
    if (!recheck.isValid()) {
      if (resumeTerminal(recheck)) {
        // The retry is not the request that was broadcast, or the transaction never met it.
        return fail(recheck.invalidReason(), txHash, recheck.invalidMessage(), network);
      }
      // Anything else is no verdict on a payment that may have landed: never a failure.
      recheckFailure = recheckFailure(recheck);
      if (claim == null || claim.bindingDigest() == null || !resumeMomentary(recheck)) {
        // Without a binding the failed re-check is the only content check, and a reason not known
        // to depend on the moment (a custom method check's, an unexpected error) may be about the
        // content: never a success either, so pending, with the reason in the message.
        return pendingResponse(txHash, network, payer, new LinkedHashMap<>(), recheckFailure);
      }
      // Bound to these exact requirements, which the broadcast verification passed: the chain decides.
      providerFailing = chainLookupFailure(recheck);
    }
    // A provider that just failed the re-check gets one evidence read, not a whole wait: the
    // answer is pending unless that read already shows the payment.
    EvidenceRead waited = providerFailing
        ? readEvidenceOnce(txHash, requirements.network(), deadline)
        : awaitEvidence(txHash, requirements.network(), resolved.required(), deadline);
    SettlementEvidence evidence = waited.evidence();
    if (evidence.status() != SettlementEvidence.Status.UNKNOWN) {
      // The ledger shows it now: keep the record like any submitted one.
      quietly(() -> options.settlementStore().markSubmissionObserved(txHash));
    }
    SettleResponse response = evidenceResponse(evidence, network, resolved, payer, true, waited.read(), deadline);
    if (recheckFailure != null && response.isPending()) {
      Map<String, Object> extra = response.extra() == null ? new LinkedHashMap<>() : new LinkedHashMap<>(response.extra());
      return pendingResponse(txHash, network, payer, extra, recheckFailure);
    }
    if (response.success() && payer.isEmpty()) {
      return pendingResponse(txHash, network, payer, new LinkedHashMap<>(),
          "the payer of the broadcast transaction could not be resolved; retry to resume");
    }
    return response;
  }

  /**
   * Re-check verdicts that end a resume: the retry differs from the request that was broadcast
   * (version, scheme, network, nonce, payer), or the transaction bytes never met the requirements.
   * The verdicts that depend on the moment are {@link #RESUME_MOMENTARY}; any other is unknown.
   */
  private static final Set<String> RESUME_TERMINAL = Set.of(
      CardanoErrors.INVALID_PAYLOAD + "_unsupported_version",
      CardanoErrors.UNSUPPORTED_SCHEME,
      CardanoErrors.NETWORK_MISMATCH,
      CardanoErrors.NONCE_INVALID,
      CardanoErrors.NONCE_NOT_IN_INPUTS,
      CardanoErrors.TRANSACTION_PHASE1_INVALID,
      CardanoErrors.REQUIREMENTS_INVALID,
      CardanoErrors.POLICY_INVALID,
      CardanoErrors.INVALID_PAYLOAD,
      CardanoErrors.TRANSACTION_DECODE_FAILED,
      CardanoErrors.NETWORK_ID_MISMATCH,
      CardanoErrors.TRANSACTION_UNSIGNED,
      CardanoErrors.INVALID_SIGNATURE,
      CardanoErrors.TRANSACTION_PHASE2_INVALID,
      CardanoErrors.RECIPIENT_MISMATCH,
      CardanoErrors.ASSET_MISMATCH,
      CardanoErrors.AMOUNT_INSUFFICIENT,
      CardanoErrors.SCRIPT_ADDRESS_MISMATCH,
      CardanoErrors.MASUMI_SCHEMA,
      CardanoErrors.MASUMI_COMMITMENT,
      CardanoErrors.MASUMI_SELLER_SIGNATURE,
      CardanoErrors.MASUMI_IDENTIFIER,
      CardanoErrors.MASUMI_ESCROW_OUTPUT_COUNT,
      CardanoErrors.MASUMI_DATUM_MISSING,
      CardanoErrors.MASUMI_DATUM_MISMATCH,
      CardanoErrors.MASUMI_DATUM_INVALID,
      CardanoErrors.MASUMI_REFERENCE_SCRIPT,
      CardanoErrors.MASUMI_COLLATERAL,
      CardanoErrors.MASUMI_ASSET);

  /**
   * Re-check verdicts known to depend on the moment, not on the transaction: the provider (a
   * failed lookup, an unresolved nonce owner), the clock or slot configuration (TTL window,
   * validity start, Masumi deadline horizon), live protocol parameters (min-UTxO), and
   * facilitator configuration or validators (evidence capability, script datum policy, Masumi
   * deployment approval, registry, allowlist). The transaction bytes and the bound requirements
   * are those the pre-broadcast verification passed, so only these can change its verdict. For a
   * bound claim they let the ledger decide.
   *
   * <p>A reason in neither set (a custom {@link #runMethodSpecificChecks} reason, an unexpected
   * error, a future code) is no verdict either way: a payment that may have landed is never
   * failed on it, and never reported settled, so it answers pending.
   */
  private static final Set<String> RESUME_MOMENTARY = Set.of(
      CardanoErrors.CHAIN_LOOKUP_FAILED,
      CardanoErrors.NONCE_NOT_ON_CHAIN,
      CardanoErrors.TTL_TOO_FAR,
      CardanoErrors.VALIDITY_NOT_YET_VALID,
      CardanoErrors.MIN_UTXO_INSUFFICIENT,
      CardanoErrors.EVIDENCE_UNAVAILABLE,
      CardanoErrors.SCRIPT_DATUM_MISSING,
      CardanoErrors.MASUMI_DEADLINE,
      CardanoErrors.MASUMI_MIN_UTXO,
      CardanoErrors.MASUMI_DEPLOYMENT,
      CardanoErrors.MASUMI_AGENT_IDENTIFIER,
      CardanoErrors.MASUMI_CONTRACT_MISMATCH);

  /** Whether a failed re-check is one {@link #RESUME_MOMENTARY} names. */
  private static boolean resumeMomentary(VerifyResponse recheck) {
    return recheck.invalidReason() != null && RESUME_MOMENTARY.contains(recheck.invalidReason());
  }

  /** A re-check that failed because the provider could not answer a lookup. */
  private static boolean chainLookupFailure(VerifyResponse recheck) {
    return CardanoErrors.CHAIN_LOOKUP_FAILED.equals(recheck.invalidReason())
        || CardanoErrors.NONCE_NOT_ON_CHAIN.equals(recheck.invalidReason());
  }

  private static String recheckFailure(VerifyResponse recheck) {
    String detail = recheck.invalidMessage() == null || recheck.invalidMessage().isEmpty()
        ? "" : ": " + recheck.invalidMessage();
    if (chainLookupFailure(recheck)) {
      return "the chain lookup failed while resuming a broadcast transaction" + detail;
    }
    return "re-verifying the broadcast transaction failed ("
        + (recheck.invalidReason() == null ? "no reason" : recheck.invalidReason()) + detail
        + "); retry to resume";
  }

  private static boolean resumeTerminal(VerifyResponse recheck) {
    return recheck.invalidReason() != null && RESUME_TERMINAL.contains(recheck.invalidReason());
  }

  /** The re-check's payer, else the one recorded at the broadcast fence, else empty. */
  private static String resumedPayer(VerifyResponse recheck, SettlementClaimDetails claim) {
    if (recheck.payer() != null && !recheck.payer().isBlank()) {
      return recheck.payer();
    }
    return claim != null && claim.payer() != null && !claim.payer().isBlank() ? claim.payer() : "";
  }

  /**
   * The last moment this settle may start a chain call (the broadcast, an evidence read): now plus
   * the settle timeout, less the chain-call reserve, so a call still in flight then has the
   * reserve to end before the settle must answer.
   */
  private long deadline() {
    long now = options.clock().millis();
    try {
      return Math.addExact(now, options.settleTimeout().toMillis() - options.chainCallReserve().toMillis());
    } catch (ArithmeticException e) {
      return Long.MAX_VALUE;
    }
  }

  private SettleResponse settleFresh(PaymentPayload payload, PaymentRequirements requirements, Resolved resolved,
      String ownerToken, String network, long deadline) {
    String txHash = resolved.decoded().txHash();
    SettlementClaimStore store = options.settlementStore();
    // Dispatched through `this` so a subclass that tightens verify() also governs settlement.
    VerifyResponse verifyResult;
    try {
      verifyResult = verifyPayment(payload, requirements);
    } catch (RuntimeException e) {
      verifyResult = invalid(CardanoErrors.INVALID_PAYLOAD + "_verification_error", message(e), "");
    }
    if (verifyResult == null) {
      verifyResult = invalid(CardanoErrors.INVALID_PAYLOAD + "_verification_error", "verification returned no result", "");
    }
    if (!verifyResult.isValid()) {
      quietly(() -> store.releaseClaim(txHash, ownerToken));
      return fail(
          verifyResult.invalidReason() == null ? "verification_failed" : verifyResult.invalidReason(),
          txHash,
          verifyResult.invalidMessage(),
          network);
    }
    String payer = verifyResult.payer() == null ? "" : verifyResult.payer();
    if (options.clock().millis() >= deadline) {
      // Too late for a submission to end within the settle timeout: broadcast nothing, so the
      // retry starts afresh.
      quietly(() -> store.releaseClaim(txHash, ownerToken));
      return pendingResponse(txHash, network, payer, new LinkedHashMap<>(),
          "the settlement ran out of time before broadcast; retry to settle");
    }

    // The broadcast fence: from here the transaction may be on the wire, so the claim is never
    // reclaimed. A store write that fails here sent nothing, so the claim is released.
    boolean fenced;
    try {
      fenced = store.beginSubmission(txHash, ownerToken, payer.isBlank() ? null : payer);
    } catch (RuntimeException e) {
      quietly(() -> store.releaseUnsent(txHash, ownerToken));
      return fail(CardanoErrors.SETTLEMENT_FAILED, txHash, STORE_UNAVAILABLE, network);
    }
    if (!fenced) {
      return pendingResponse(txHash, network, payer, new LinkedHashMap<>(),
          "another settlement of this transaction took over before broadcast; retry to resume");
    }

    // Only the network call is guarded: store and consistency errors must never reach the
    // submit-failure classifier, which could turn a broadcast transaction into a rejection.
    SubmissionResult submission = null;
    RuntimeException submitError = null;
    try {
      submission = backend.submitTransaction(resolved.payload().transaction(), requirements.network());
    } catch (RuntimeException e) {
      submitError = e;
    }
    if (submitError == null && (submission == null || submission.txHash() == null
        || !submission.txHash().equalsIgnoreCase(txHash))) {
      String returned = submission == null ? null : submission.txHash();
      return submissionFailed(new IllegalStateException(
          "submitter returned transaction " + returned + ", expected " + txHash),
          false, resolved, payer, ownerToken, requirements, network, deadline);
    }
    if (submitError != null) {
      return submissionFailed(submitError, true, resolved, payer, ownerToken, requirements, network, deadline);
    }

    boolean marked = quietly(() -> store.markSubmitted(txHash, ownerToken));
    SettleResponse response =
        broadcastResponse(submission.status(), resolved, payer, requirements, network, deadline);
    if (!marked && !response.success()) {
      // Try once more so a retry resumes instead of finding the claim still in flight.
      quietly(() -> store.markSubmitted(txHash, ownerToken));
    }
    return response;
  }

  /**
   * A submission that failed, or returned the wrong transaction. A failure does not prove the
   * transaction never reached the network, so the ledger is asked first; the claim is kept so a
   * retry never rebroadcasts, unless the backend proves the transaction never left the process.
   * An unknown outcome is pending: the payment may still land. Store write failures never change
   * the answer.
   */
  private SettleResponse submissionFailed(RuntimeException cause, boolean classify, Resolved resolved, String payer,
      String ownerToken, PaymentRequirements requirements, String network, long deadline) {
    String txHash = resolved.decoded().txHash();
    SettlementClaimStore store = options.settlementStore();
    boolean neverSent = classify && classified(() -> backend.isSubmissionNeverSent(cause));
    boolean definitive = classify && classified(() -> backend.isDefinitiveSubmissionRejection(cause));
    if (neverSent && definitive) {
      // Contradictory: treat the outcome as unknown.
      neverSent = false;
      definitive = false;
    }
    SettlementEvidence.Status seen = SettlementEvidence.Status.UNKNOWN;
    boolean lookupFailed = false;
    boolean readSkipped = false;
    if (canAuthenticateEvidence()) {
      if (options.clock().millis() >= deadline) {
        // No time left for a read. A skipped read is not a failed one: nothing suggests the
        // provider garbled the submission's answer, so its classification stands below.
        readSkipped = true;
      } else {
        try {
          seen = readEvidence(txHash, requirements.network()).status();
        } catch (RuntimeException e) {
          lookupFailed = true;
        }
      }
    }
    if (seen != SettlementEvidence.Status.UNKNOWN) {
      quietly(() -> store.markSubmitted(txHash, ownerToken));
      SettlementEvidence evidence =
          awaitEvidence(txHash, requirements.network(), resolved.required(), deadline).evidence();
      return evidenceResponse(evidence, network, resolved, payer, false, false, deadline);
    }
    String chain = describeErrorChain(cause);
    if (neverSent) {
      // Nothing reached a node: release the claim, so the retry broadcasts the same transaction.
      quietly(() -> store.releaseUnsent(txHash, ownerToken));
      return pendingResponse(txHash, network, payer, new LinkedHashMap<>(),
          "the transaction was not sent; retry to broadcast it: " + chain);
    }
    // A definitive rejection is recorded without the ledger read when the deadline left no time
    // for it, as when the backend cannot read evidence at all: the classification must rest on the
    // transaction's own content (Blockfrost: content-decided ledger rules only, never
    // BadInputsUTxO), which an earlier copy of the same bytes would have failed too. A read that
    // failed is different: the provider is in trouble, so its answer stays pending.
    if (definitive && readSkipped) {
      quietly(() -> store.markRejected(txHash, ownerToken));
      return fail(CardanoErrors.SETTLEMENT_DEFINITIVELY_REJECTED, txHash, chain, network);
    }
    if (readSkipped) {
      quietly(() -> store.markSubmissionUnconfirmed(txHash, ownerToken));
      return pendingResponse(txHash, network, payer, new LinkedHashMap<>(),
          "the submission outcome is unknown and the settlement ran out of time to read the ledger;"
              + " retry to resume: " + chain);
    }
    if (lookupFailed) {
      quietly(() -> store.markSubmissionUnconfirmed(txHash, ownerToken));
      SettlementEvidence evidence =
          awaitEvidence(txHash, requirements.network(), resolved.required(), deadline).evidence();
      if (evidence.status() != SettlementEvidence.Status.UNKNOWN) {
        // The ledger shows it after all: keep the record like any submitted one.
        quietly(() -> store.markSubmissionObserved(txHash));
      }
      return evidenceResponse(evidence, network, resolved, payer, false, false, deadline);
    }
    if (definitive) {
      quietly(() -> store.markRejected(txHash, ownerToken));
      return fail(CardanoErrors.SETTLEMENT_DEFINITIVELY_REJECTED, txHash, chain, network);
    }
    // Unknown does not prove absence: keep the claim, but let the store drop it under pressure,
    // since no success was reported for it.
    quietly(() -> store.markSubmissionUnconfirmed(txHash, ownerToken));
    return pendingResponse(txHash, network, payer, new LinkedHashMap<>(),
        "the submission outcome is unknown; retry to resume: " + chain);
  }

  /** A backend classification; a classifier that throws answers {@code false}. */
  private static boolean classified(java.util.function.BooleanSupplier classifier) {
    try {
      return classifier.getAsBoolean();
    } catch (RuntimeException e) {
      return false;
    }
  }

  /** The outcome of an accepted submission, from the policy's evidence. */
  private SettleResponse broadcastResponse(SettlementEvidence.Status submissionStatus, Resolved resolved,
      String payer, PaymentRequirements requirements, String network, long deadline) {
    String txHash = resolved.decoded().txHash();
    int required = resolved.required();
    SettlementEvidence evidence;
    if (options.acceptMempool() && required == CardanoConstants.MIN_L1_CONFIRMATIONS) {
      // The node's acceptance is exactly the evidence a -1 policy describes.
      evidence = submitterEvidence(submissionStatus);
    } else if (canAuthenticateEvidence()) {
      evidence = awaitEvidence(txHash, requirements.network(), required, deadline).evidence();
      if (evidence.status() == SettlementEvidence.Status.UNKNOWN) {
        evidence = new SettlementEvidence(SettlementEvidence.Status.MEMPOOL, CardanoConstants.MIN_L1_CONFIRMATIONS);
      }
    } else {
      evidence = submitterEvidence(submissionStatus);
    }
    return evidenceResponse(evidence, network, resolved, payer, false, false, deadline);
  }

  private static SettlementEvidence submitterEvidence(SettlementEvidence.Status status) {
    return status == SettlementEvidence.Status.CONFIRMED
        ? new SettlementEvidence(SettlementEvidence.Status.CONFIRMED, 0)
        : new SettlementEvidence(SettlementEvidence.Status.MEMPOOL, CardanoConstants.MIN_L1_CONFIRMATIONS);
  }

  private static String describeErrorChain(Throwable error) {
    List<String> parts = new ArrayList<>();
    Throwable current = error;
    for (int depth = 0; current != null && depth < 5; depth++) {
      parts.add(message(current));
      current = current.getCause();
    }
    return String.join(" | ", parts);
  }

  private SettleResponse evidenceResponse(
      SettlementEvidence evidence, String network, Resolved resolved, String payer, boolean resumed,
      boolean absenceRead, long deadline) {
    String txHash = resolved.decoded().txHash();
    int required = resolved.required();
    if (evidence.status() == SettlementEvidence.Status.UNKNOWN) {
      // Expired only when a successful read shows it absent and the provider has indexed past the
      // window; a failed read or a lagging indexer keeps a payment that may still land pending.
      if (resumed && absenceRead && validityWindowClosed(resolved.decoded(), network, deadline)) {
        Map<String, Object> extra = new LinkedHashMap<>();
        extra.put("status", "expired");
        return new SettleResponse(
            false,
            CardanoErrors.SETTLEMENT_FAILED,
            "the transaction's validity window closed before it was included",
            payer,
            txHash,
            network,
            null,
            null,
            null,
            extra);
      }
      return pendingResponse(txHash, network, payer, new LinkedHashMap<>(), null);
    }
    Map<String, Object> extra = new LinkedHashMap<>();
    extra.put("status", evidence.status().wire());
    extra.put("confirmations", evidence.confirmations());
    if (evidence.status() == SettlementEvidence.Status.MEMPOOL) {
      if (options.acceptMempool() && CardanoPolicies.confirmationsSatisfy(evidence.confirmations(), required)) {
        return new SettleResponse(true, null, null, payer, txHash, network, null, null, null, extra);
      }
      if (canAuthenticateEvidence()) {
        return pendingResponse(txHash, network, payer, extra, null);
      }
      return new SettleResponse(
          false, CardanoErrors.SETTLEMENT_NOT_CONFIRMED, null, payer, txHash, network, null, null, null, extra);
    }
    if (!CardanoPolicies.confirmationsSatisfy(evidence.confirmations(), required)) {
      return pendingResponse(txHash, network, payer, extra, null);
    }
    return new SettleResponse(true, null, null, payer, txHash, network, null, null, null, extra);
  }

  private static SettleResponse pendingResponse(
      String txHash, String network, String payer, Map<String, Object> extra, String errorMessage) {
    Map<String, Object> pendingExtra = new LinkedHashMap<>(extra);
    pendingExtra.put("status", "pending");
    pendingExtra.put("transactionId", txHash);
    return new SettleResponse(
        false,
        CardanoErrors.SETTLEMENT_PENDING,
        errorMessage == null
            ? "the transaction was broadcast and is awaiting the required confirmations"
            : errorMessage,
        payer,
        txHash,
        network,
        null,
        null,
        null,
        pendingExtra);
  }

  /**
   * Whether the provider has indexed past the validity window. Reading its tip is a chain call:
   * none starts past the settle's call deadline, and then the window counts as open (pending).
   */
  private boolean validityWindowClosed(DecodedCardanoTransaction decoded, String network, long deadline) {
    if (decoded.ttlSlot() == null || options.clock().millis() >= deadline) {
      return false;
    }
    try {
      SlotConfig slots = options.slotConfigFor(network);
      BigInteger now = CardanoNetworks.slotToPosixMs(slots, BigInteger.valueOf(backend.getIndexedSlot(network)));
      BigInteger closes =
          CardanoNetworks.slotToPosixMs(slots, decoded.ttlSlot()).add(BigInteger.valueOf(VALIDITY_CLOSE_GRACE_MS));
      return now.compareTo(closes) > 0;
    } catch (RuntimeException e) {
      return false;
    }
  }

  /**
   * The evidence a wait ended with, and whether its last read succeeded: an UNKNOWN from a read
   * that failed proves nothing about absence.
   */
  private record EvidenceRead(SettlementEvidence evidence, boolean read) {}

  /** One evidence read, unless the settle's call deadline has passed; a failed read reads nothing. */
  private EvidenceRead readEvidenceOnce(String txHash, String network, long deadline) {
    SettlementEvidence unknown =
        new SettlementEvidence(SettlementEvidence.Status.UNKNOWN, CardanoConstants.MIN_L1_CONFIRMATIONS - 1);
    if (!canAuthenticateEvidence() || options.clock().millis() >= deadline) {
      return new EvidenceRead(unknown, false);
    }
    try {
      return new EvidenceRead(readEvidence(txHash, network), true);
    } catch (RuntimeException e) {
      return new EvidenceRead(unknown, false);
    }
  }

  /**
   * Polls evidence until the threshold is met, the confirmation timeout elapses or the settle's
   * call deadline (the settle timeout less the chain-call reserve) is reached; no read starts past
   * it. Elapsed time is the larger of the clock's progress and the time slept, so a fixed test
   * clock cannot make the loop spin.
   */
  private EvidenceRead awaitEvidence(String txHash, String network, int required, long deadline) {
    SettlementEvidence latest = new SettlementEvidence(SettlementEvidence.Status.UNKNOWN, CardanoConstants.MIN_L1_CONFIRMATIONS - 1);
    boolean read = false;
    if (!canAuthenticateEvidence()) {
      return new EvidenceRead(latest, false);
    }
    long start = options.clock().millis();
    if (deadline - start <= 0) {
      return new EvidenceRead(latest, false);
    }
    long timeout = Math.min(options.confirmationTimeout().toMillis(), deadline - start);
    long poll = Math.max(1, options.confirmationPoll().toMillis());
    long slept = 0;
    while (true) {
      try {
        latest = readEvidence(txHash, network);
        read = true;
      } catch (RuntimeException e) {
        // Keep the strongest result seen so far and retry until the deadline.
        read = false;
      }
      if (latest.status() != SettlementEvidence.Status.UNKNOWN
          && CardanoPolicies.confirmationsSatisfy(latest.confirmations(), required)) {
        return new EvidenceRead(latest, read);
      }
      long elapsed = Math.max(options.clock().millis() - start, slept);
      if (elapsed + poll >= timeout) {
        return new EvidenceRead(latest, read);
      }
      try {
        Thread.sleep(poll);
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        return new EvidenceRead(latest, read);
      }
      slept += poll;
    }
  }

  /** The Masumi terms digest of the requirements, when it is a schema-valid Masumi payment. */
  private static String masumiTermsDigest(PaymentRequirements requirements) {
    if (!CardanoConstants.METHOD_MASUMI.equals(requirements.extra().get("assetTransferMethod"))) {
      return null;
    }
    MasumiSchema.Result schema = MasumiSchema.validate(requirements.extra(), requirements.network());
    return schema.ok()
        ? MasumiDigests.computeTermsDigest(MasumiDigests.buildSignedTerms(schema.extra(), requirements))
        : null;
  }
}
