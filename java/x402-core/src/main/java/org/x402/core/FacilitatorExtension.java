package org.x402.core;

/**
 * A facilitator extension: a key advertised in {@code
 * /supported}, plus whatever capability methods the implementation defines for schemes to use via
 * {@link FacilitatorContext}.
 */
public interface FacilitatorExtension {

  /**
   * The extension key.
   *
   * @return the key
   */
  String key();
}
