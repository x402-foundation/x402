package org.x402.core.types;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonPropertyOrder;
import java.util.Map;

/**
 * A facilitator's settle answer, also the body of {@code PAYMENT-RESPONSE}.
 *
 * @param success whether settlement succeeded
 * @param errorReason machine-readable reason on failure
 * @param errorMessage human-readable detail on failure
 * @param payer the payer address, when known
 * @param transaction the transaction id; empty when nothing was broadcast
 * @param network the CAIP-2 network
 * @param amount the settled amount, when it differs from the requirements
 * @param extensions optional extension data
 * @param extensionResponses server-internal side channel; never sent to buyers
 * @param extra scheme-specific data, e.g. {@code transactionId} when pending
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonPropertyOrder({
  "success", "errorReason", "errorMessage", "payer", "transaction", "network", "amount",
  "extensions", "extensionResponses", "extra"
})
public record SettleResponse(
    boolean success,
    String errorReason,
    String errorMessage,
    String payer,
    String transaction,
    String network,
    String amount,
    Map<String, Object> extensions,
    Map<String, Object> extensionResponses,
    Map<String, Object> extra) {

  /** The reason a facilitator reports while a broadcast transaction awaits confirmation. */
  public static final String SETTLEMENT_PENDING = "settlement_pending";

  /** Copies the maps. */
  public SettleResponse {
    extensions = Collections2.copyMap(extensions);
    extensionResponses = Collections2.copyMap(extensionResponses);
    extra = Collections2.copyMap(extra);
  }

  /**
   * A successful settlement.
   *
   * @param transaction the transaction id
   * @param network the network
   * @param payer the payer, may be {@code null}
   * @return the response
   */
  public static SettleResponse success(String transaction, String network, String payer) {
    return new SettleResponse(true, null, null, payer, transaction, network, null, null, null, null);
  }

  /**
   * A failed settlement.
   *
   * @param reason the machine-readable reason
   * @param message optional detail
   * @param transaction the transaction id, empty when nothing was broadcast
   * @param network the network
   * @return the response
   */
  public static SettleResponse failure(
      String reason, String message, String transaction, String network) {
    return new SettleResponse(
        false, reason, message, null, transaction == null ? "" : transaction, network, null, null,
        null, null);
  }

  /**
   * Returns this response without the server-internal side channel.
   *
   * @return the buyer-facing copy
   */
  public SettleResponse withoutExtensionResponses() {
    return new SettleResponse(
        success, errorReason, errorMessage, payer, transaction, network, amount, extensions, null,
        extra);
  }

  /**
   * Whether the facilitator reported a broadcast-but-unconfirmed transaction.
   *
   * @return {@code true} for {@code settlement_pending}
   */
  @JsonIgnore
  public boolean isPending() {
    return !success && SETTLEMENT_PENDING.equals(errorReason);
  }
}
