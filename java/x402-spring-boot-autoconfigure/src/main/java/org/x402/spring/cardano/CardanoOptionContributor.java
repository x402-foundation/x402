package org.x402.spring.cardano;

import java.util.Map;
import org.x402.mechanisms.cardano.utils.CardanoConstants;
import org.x402.mechanisms.cardano.utils.CardanoNetworks;
import org.x402.mechanisms.cardano.exact.masumi.MasumiBlueprint;
import org.x402.mechanisms.cardano.exact.masumi.MasumiDeployment;
import org.x402.core.server.ResourceConfig;
import org.x402.core.types.PaymentRequirements;
import org.x402.mechanisms.cardano.exact.server.MasumiIssuerConfig;
import org.x402.mechanisms.cardano.exact.server.MasumiQuoteIssuer;
import org.x402.spring.offer.OptionDraft;
import org.x402.spring.offer.X402OptionContributor;

/**
 * The Cardano option contributor. Every decision keys on the option's merged {@code
 * extra}: the confirmation policy from {@code cardano.l1-confirmations}, the Masumi deployment and
 * the derived escrow {@code pay-to}, the escrow and network-tag checks of plain receivers.
 */
public final class CardanoOptionContributor implements X402OptionContributor {

  private static final String POLICY = "confirmationPolicy";
  private final CardanoServerPlan plan;

  /**
   * Creates the contributor.
   *
   * @param plan the Cardano plan
   */
  public CardanoOptionContributor(CardanoServerPlan plan) {
    this.plan = plan;
  }

  @Override
  public void contribute(OptionDraft option) {
    String network = option.network();
    if (!CardanoNetworks.isCardanoNetwork(network)
        || !CardanoConstants.SCHEME_EXACT.equals(option.scheme())) {
      return;
    }
    Map<String, Object> extra = option.extra();
    confirmationPolicy(option, extra, option.declaredExtra());
    MasumiDeployment declared = null;
    if (extra.containsKey("deployment")) {
      declared = JsonShapes.deployment(extra.get("deployment"));
      option.putExtra("deployment", declared.toJson());
      plan.addDeployment(network, declared);
    }
    Object method = extra.getOrDefault("assetTransferMethod", CardanoConstants.METHOD_DEFAULT);
    if (CardanoConstants.METHOD_MASUMI.equals(method)) {
      masumi(option, network, declared);
    } else if (option.payTo() != null) {
      CardanoAddressRules.checkPlainPayTo(network, option.payTo(), plan.escrows(network),
          plan.escrowScripts(network));
    }
  }

  private void confirmationPolicy(OptionDraft option, Map<String, Object> extra,
      Map<String, Object> declared) {
    X402CardanoProperties.Cardano block = plan.block(option.accountName());
    boolean accountDepth = block != null && block.l1Confirmations() != null;
    // option/account extra > account cardano.l1-confirmations > price.extra
    if (declared.containsKey(POLICY) || (extra.containsKey(POLICY) && !accountDepth)) {
      Integer l1 = JsonShapes.l1Confirmations(extra.get(POLICY));
      if (l1 == null || l1 < CardanoConstants.MIN_L1_CONFIRMATIONS
          || l1 > CardanoConstants.MAX_L1_CONFIRMATIONS) {
        throw new IllegalArgumentException("extra.confirmationPolicy must be "
            + "{l1Confirmations: -1..20}; got " + extra.get(POLICY));
      }
      option.putExtra(POLICY, Map.of("l1Confirmations", l1));
      return;
    }
    if (accountDepth) {
      int l1 = block.l1Confirmations();
      if (l1 < CardanoConstants.MIN_L1_CONFIRMATIONS
          || l1 > CardanoConstants.MAX_L1_CONFIRMATIONS) {
        throw new IllegalArgumentException("x402.accounts." + option.accountName()
            + ".cardano.l1-confirmations must be -1..20; got " + l1);
      }
      option.putExtra(POLICY, Map.of("l1Confirmations", l1));
    }
  }

  private void masumi(OptionDraft option, String network, MasumiDeployment declared) {
    if (option.payToRef() != null) {
      throw new IllegalArgumentException("a Masumi option cannot use pay-to-ref: its receiver is "
          + "the escrow address fixed by the deployment");
    }
    MasumiDeployment deployment = MasumiBlueprint.resolveDeployment(network,
        declared != null ? declared : plan.settings(network).deployment());
    if (deployment == null) {
      throw new IllegalArgumentException(network + " has no canonical Masumi deployment; set "
          + "extra.deployment or x402.accounts.NAME.cardano.masumi.deployment");
    }
    String escrow = MasumiBlueprint.escrowAddress(network, deployment);
    if (option.payTo() == null) {
      option.setPayTo(escrow);
    } else if (!escrow.equals(option.payTo())) {
      throw new IllegalArgumentException("a Masumi option's pay-to must be the escrow address "
          + escrow + " of its deployment on " + network + "; got " + option.payTo()
          + " (omit pay-to to derive it)");
    }
    if (plan.seller(network) == null) {
      throw new IllegalArgumentException("a Masumi option needs a seller on " + network + ": set "
          + "x402.accounts.NAME.cardano.masumi.seller-mnemonic or define a CardanoSellerSigner "
          + "bean (X402CardanoNetworkBeans with several networks)");
    }
    // the issuer's template rules (keys, deadline horizon), at startup instead of per request
    int timeout = option.maxTimeoutSeconds() == null
        ? ResourceConfig.DEFAULT_MAX_TIMEOUT_SECONDS : option.maxTimeoutSeconds();
    PaymentRequirements template = new PaymentRequirements(option.scheme(), network,
        "template", "1", escrow, timeout, option.extra());
    MasumiQuoteIssuer.assertMasumiTemplate(template, MasumiIssuerConfig.builder()
        .seller(plan.seller(network)).deployment(deployment).build());
  }
}
