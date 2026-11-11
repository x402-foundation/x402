package org.x402.e2e.server.accounts;

import java.util.Map;
import org.x402.e2e.server.E2eCatalog;

/**
 * The network-specific part of the e2e server configuration: one implementation (in {@code
 * accounts.impl}) per catalog network that needs more than a pay-to address, like the per-network
 * blocks of the Go, Python and TypeScript e2e servers. Networks without one use {@link #DEFAULT}.
 */
public interface E2eNetworkAccounts {

  /** Pay-to {@code SERVER_<ID>_ADDRESS}, nothing else. */
  E2eNetworkAccounts DEFAULT = new E2eNetworkAccounts() {};

  /**
   * Why a route of this network cannot be mounted, checked after its pay-to address is known.
   *
   * @param route the catalog route
   * @return the reason, or {@code null} to mount it
   */
  default String skipReason(E2eCatalog.Route route) {
    return null;
  }

  /**
   * Adds an account's properties other than {@code network} and {@code extra.assetTransferMethod}.
   *
   * @param p the properties
   * @param account the account property prefix, ending in {@code .}
   * @param method the route's asset transfer method, or {@code null}
   * @param serverPayTo the trimmed {@code SERVER_<ID>_ADDRESS}
   */
  default void putAccount(Map<String, Object> p, String account, String method,
      String serverPayTo) {
    p.put(account + "pay-to", serverPayTo);
  }

  /**
   * Adds accept {@code extra} entries. Runs after the catalog {@code requirementsExtra} and before
   * {@code paymentFlow} and {@code schemeExtra}, which override it.
   *
   * @param p the properties
   * @param accept the accepts entry property prefix, ending in {@code .}
   * @param method the route's asset transfer method, or {@code null}
   */
  default void putAcceptExtra(Map<String, Object> p, String accept, String method) {}
}
