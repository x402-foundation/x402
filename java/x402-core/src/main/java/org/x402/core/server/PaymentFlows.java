package org.x402.core.server;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.stream.Collectors;
import org.x402.core.PaymentFlow;
import org.x402.core.SchemeNetworkServer;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;

/** Payment-flow resolution and wire rules. */
public final class PaymentFlows {

  /** SDK-only transfer-method key that never appears on the wire. */
  public static final String SDK_DEFAULT_ASSET_TRANSFER_METHOD = "default";

  /** The {@code extra} key naming the transfer method. */
  public static final String ASSET_TRANSFER_METHOD = "assetTransferMethod";

  /** The {@code extra} key naming the payment flow. */
  public static final String PAYMENT_FLOW = "paymentFlow";

  private PaymentFlows() {}

  /**
   * A requirement's {@code extra} before wire adjustments: the price's {@code extra}, then the
   * option's on top.
   *
   * @param priceExtra the parsed price's extra, or {@code null}
   * @param optionExtra the option's extra, or {@code null}
   * @return the merged map
   */
  public static Map<String, Object> mergeExtra(Map<String, Object> priceExtra,
      Map<String, Object> optionExtra) {
    Map<String, Object> extra = new LinkedHashMap<>();
    if (priceExtra != null) {
      extra.putAll(priceExtra);
    }
    if (optionExtra != null) {
      extra.putAll(optionExtra);
    }
    return extra;
  }

  /**
   * A resolved transfer method and flow.
   *
   * @param assetTransferMethod the transfer method
   * @param flow the payment flow
   */
  public record Resolved(String assetTransferMethod, PaymentFlow flow) {}

  /**
   * Resolves the flow: the method is {@code extra.assetTransferMethod} or the scheme
   * default; the flow is {@code extra.paymentFlow} or that method's default.
   *
   * @param scheme the scheme
   * @param requirements the requirements
   * @return the resolved method and flow
   * @throws IllegalArgumentException when the method or flow is unsupported
   */
  public static Resolved resolve(SchemeNetworkServer scheme, PaymentRequirements requirements) {
    return resolve(scheme, requirements.extra());
  }

  /**
   * {@link #resolve(SchemeNetworkServer, PaymentRequirements)} on a bare {@code extra} map.
   *
   * @param scheme the scheme
   * @param extra the requirements' extra, may be {@code null}
   * @return the resolved method and flow
   */
  public static Resolved resolve(SchemeNetworkServer scheme, Map<String, Object> extra) {
    Map<String, Object> e = extra == null ? Map.of() : extra;
    Object method = e.get(ASSET_TRANSFER_METHOD);
    String atm = method instanceof String s ? s : scheme.defaultAssetTransferMethod();
    PaymentFlow.Config config = scheme.paymentFlows().get(atm);
    if (config == null) {
      throw new IllegalArgumentException(unsupportedMethodMessage(scheme, atm));
    }
    Object requested = e.get(PAYMENT_FLOW);
    PaymentFlow flow = requested == null ? config.defaultFlow()
        : PaymentFlow.fromWire(String.valueOf(requested));
    if (flow == null || !config.supported().contains(flow)) {
      throw new IllegalArgumentException("[x402] Scheme \"" + scheme.scheme()
          + "\" assetTransferMethod \"" + atm + "\" does not support paymentFlow \""
          + requested + "\". Supported: "
          + config.supported().stream().map(PaymentFlow::wire).collect(Collectors.joining(", "))
          + " (default: " + config.defaultFlow().wire() + ").");
    }
    return new Resolved(atm, flow);
  }

  /**
   * The message for an unsupported transfer method.
   *
   * @param scheme the scheme
   * @param atm the method
   * @return the message
   */
  static String unsupportedMethodMessage(SchemeNetworkServer scheme, String atm) {
    return "[x402] Scheme \"" + scheme.scheme() + "\" does not support assetTransferMethod \""
        + atm + "\". Supported: " + String.join(", ", scheme.paymentFlows().keySet()) + ".";
  }

  /**
   * Drops the SDK {@code "default"} method and announces a
   * non-authorization flow in {@code extra.paymentFlow}.
   *
   * @param extra the current extra
   * @param resolved the resolution
   * @return a new extra map
   */
  public static Map<String, Object> applyWireExtra(Map<String, Object> extra, Resolved resolved) {
    Map<String, Object> next = new LinkedHashMap<>(extra == null ? Map.of() : extra);
    if (SDK_DEFAULT_ASSET_TRANSFER_METHOD.equals(resolved.assetTransferMethod())
        || SDK_DEFAULT_ASSET_TRANSFER_METHOD.equals(next.get(ASSET_TRANSFER_METHOD))) {
      next.remove(ASSET_TRANSFER_METHOD);
    }
    if (resolved.flow() != PaymentFlow.AUTHORIZATION) {
      next.put(PAYMENT_FLOW, resolved.flow().wire());
    }
    return next;
  }

  /**
   * The receipt to send when a handler fails after the
   * payment was verified (and possibly settled before the handler).
   *
   * @param cancelSettlement the cancel dispatcher's result, may be {@code null}
   * @param beforeHandlerSettlement the before-handler settle, may be {@code null}
   * @param paymentPayload the client's payload, for escrow recovery fields
   * @return the receipt, or {@code null} for none
   */
  public static SettleResponse resolveFailurePathSettlement(
      SettleResponse cancelSettlement,
      CompletedSettlement beforeHandlerSettlement,
      PaymentPayload paymentPayload) {
    if (cancelSettlement != null) {
      return cancelSettlement.success() ? cancelSettlement
          : failedCancelReceipt(cancelSettlement, beforeHandlerSettlement, paymentPayload);
    }
    return beforeHandlerSettlement == null ? null : beforeHandlerSettlement.result();
  }

  private static SettleResponse failedCancelReceipt(
      SettleResponse cancel, CompletedSettlement before, PaymentPayload payload) {
    Map<String, Object> extra = new LinkedHashMap<>();
    if (cancel.extra() != null) {
      extra.putAll(cancel.extra());
    }
    if (before != null) {
      extra.put("depositTransaction", before.result().transaction());
      if (before.result().amount() != null) {
        extra.put("depositAmount", before.result().amount());
      }
    }
    Object channelId = payload == null ? null : payload.payload().get("channelId");
    if (channelId instanceof String s && !s.isEmpty()) {
      extra.put("channelId", s);
    }
    return new SettleResponse(false, cancel.errorReason(), cancel.errorMessage(), cancel.payer(),
        "", cancel.network(), null, cancel.extensions(), null, extra);
  }
}
