package org.x402.spring.web;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.util.HtmlUtils;

/**
 * Unannotated handlers protected by YAML {@code path:} offers in the path-hardening tests: a paid
 * {@code /vault}, a cheap {@code /cheap/*} and a free {@code /public/*}. Works on WebMvc and
 * WebFlux.
 */
@RestController
public class PathHardeningControllers {

  /** The paid offer's price (the cheap one costs $0.01). */
  public static final String VAULT_PRICE = "$0.90";

  @GetMapping("/vault")
  String vault() {
    return "vault";
  }

  @GetMapping("/cheap/{name}")
  String cheap(@PathVariable("name") String name) {
    return "cheap " + HtmlUtils.htmlEscape(name);
  }

  @GetMapping("/public/{name}")
  String open(@PathVariable("name") String name) {
    return "public " + HtmlUtils.htmlEscape(name);
  }

  /**
   * Offers {@code p-vault} (paid, at {@code vaultPath}) and, when {@code cheapPath} is set,
   * {@code p-cheap}, both on the contract's {@code net} account.
   *
   * @param vaultPath the paid offer's path, e.g. {@code GET /vault}
   * @param cheapPath the cheap offer's path, or {@code null}
   * @return the properties
   */
  public static Map<String, Object> offers(String vaultPath, String cheapPath) {
    Map<String, Object> p = new LinkedHashMap<>();
    p.put("x402.routes.p-vault.path", vaultPath);
    p.put("x402.routes.p-vault.accepts[0].account", "net");
    p.put("x402.routes.p-vault.accepts[0].price", VAULT_PRICE);
    if (cheapPath != null) {
      p.put("x402.routes.p-cheap.path", cheapPath);
      p.put("x402.routes.p-cheap.accepts[0].account", "net");
      p.put("x402.routes.p-cheap.accepts[0].price", "$0.01");
    }
    return p;
  }
}
