package org.x402.core;

/** Gives a facilitator scheme access to registered extensions. */
@FunctionalInterface
public interface FacilitatorContext {

  /** A context with no extensions. */
  FacilitatorContext EMPTY = key -> null;

  /**
   * Looks up a registered extension.
   *
   * @param key the extension key
   * @return the extension, or {@code null}
   */
  FacilitatorExtension getExtension(String key);

  /**
   * Looks up a registered extension of a given type.
   *
   * @param key the extension key
   * @param type the expected type
   * @param <T> the type
   * @return the extension, or {@code null} when absent or of another type
   */
  default <T extends FacilitatorExtension> T getExtension(String key, Class<T> type) {
    FacilitatorExtension ext = getExtension(key);
    return type.isInstance(ext) ? type.cast(ext) : null;
  }
}
