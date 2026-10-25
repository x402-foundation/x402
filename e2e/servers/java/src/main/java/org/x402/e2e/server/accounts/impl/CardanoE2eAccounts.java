package org.x402.e2e.server.accounts.impl;

import java.util.Map;
import java.util.function.Function;
import org.x402.e2e.server.E2eCatalog;
import org.x402.e2e.server.E2eEnv;
import org.x402.e2e.server.accounts.E2eNetworkAccounts;

/**
 * Cardano accounts: {@code cardano} pays to SERVER_CARDANO_ADDRESS, {@code cardano-masumi} has no
 * pay-to (the starter derives the escrow address from the seller mnemonic), {@code cardano-script}
 * pays to SERVER_CARDANO_SCRIPT_ADDRESS, else the always-succeeds fixture.
 * CARDANO_L1_CONFIRMATIONS becomes each account's {@code cardano.l1-confirmations}.
 */
public final class CardanoE2eAccounts implements E2eNetworkAccounts {

  /** always-succeeds Plutus V3 fixture. */
  static final String ALWAYS_SUCCEEDS_SCRIPT = "4d01000033222220051200120011";

  static final String ALWAYS_SUCCEEDS_DATUM = "d8799f182aff";

  static final String ALWAYS_SUCCEEDS_ADDRESS =
      "addr_test1wp8l7eylksmjas7ypzm0q35dwnjdxxvsfn0z0lflqzgs55stpd682";

  private final Function<String, String> env;
  private final Integer l1Confirmations;

  /**
   * Reads the Cardano env. Validates CARDANO_L1_CONFIRMATIONS even when no Cardano route is
   * mounted.
   *
   * @param env environment lookup
   */
  public CardanoE2eAccounts(Function<String, String> env) {
    this.env = env;
    this.l1Confirmations = l1Confirmations(env.apply("CARDANO_L1_CONFIRMATIONS"));
  }

  @Override
  public String skipReason(E2eCatalog.Route route) {
    if ("masumi".equals(route.assetTransferMethod())
        && E2eEnv.isBlank(env.apply("SERVER_CARDANO_SELLER_MNEMONIC"))) {
      return "no SERVER_CARDANO_SELLER_MNEMONIC";
    }
    return null;
  }

  @Override
  public void putAccount(Map<String, Object> p, String account, String method,
      String serverPayTo) {
    if ("masumi".equals(method)) {
      // No pay-to: the starter derives the canonical escrow address of the network.
      p.put(account + "cardano.masumi.seller-mnemonic",
          env.apply("SERVER_CARDANO_SELLER_MNEMONIC").trim());
    } else if ("script".equals(method)) {
      p.put(account + "pay-to",
          E2eEnv.envOr(env, "SERVER_CARDANO_SCRIPT_ADDRESS", ALWAYS_SUCCEEDS_ADDRESS));
    } else {
      p.put(account + "pay-to", serverPayTo);
    }
    if (l1Confirmations != null) {
      p.put(account + "cardano.l1-confirmations", l1Confirmations);
    }
  }

  @Override
  public void putAcceptExtra(Map<String, Object> p, String accept, String method) {
    if ("script".equals(method)) {
      p.put(accept + "extra.script.type", "plutusV3");
      p.put(accept + "extra.script.code",
          E2eEnv.envOr(env, "SERVER_CARDANO_SCRIPT_CODE", ALWAYS_SUCCEEDS_SCRIPT));
      p.put(accept + "extra.datum",
          E2eEnv.envOr(env, "SERVER_CARDANO_SCRIPT_DATUM", ALWAYS_SUCCEEDS_DATUM));
    }
  }

  static Integer l1Confirmations(String raw) {
    if (E2eEnv.isBlank(raw)) {
      return null;
    }
    String v = raw.trim();
    if (!v.matches("^-?(0|[1-9]\\d?)$")) {
      throw new IllegalStateException(
          "CARDANO_L1_CONFIRMATIONS must be a plain integer from -1 to 20, got \"" + v + "\"");
    }
    int n = Integer.parseInt(v);
    if (n < -1 || n > 20) {
      throw new IllegalStateException(
          "CARDANO_L1_CONFIRMATIONS must be an integer from -1 to 20, got \"" + v + "\"");
    }
    return n;
  }
}
