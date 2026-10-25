package org.x402.core.server;

import java.util.List;

/**
 * A facilitator cannot serve a registered scheme's configuration. Fatal at startup: it cannot heal
 * by retrying.
 */
public class FacilitatorCapabilityError extends IllegalStateException {

  private static final long serialVersionUID = 1L;

  private final transient List<String> problems;

  /**
   * Creates the error.
   *
   * @param problems one line per problem
   */
  public FacilitatorCapabilityError(List<String> problems) {
    super(message(problems));
    this.problems = List.copyOf(problems);
  }

  private static String message(List<String> problems) {
    StringBuilder sb = new StringBuilder("x402 facilitator capability errors:");
    problems.forEach(p -> sb.append("\n  - ").append(p));
    return sb.toString();
  }

  /**
   * The problems.
   *
   * @return one line per problem
   */
  public List<String> problems() {
    return problems;
  }
}
