package org.x402.mechanisms.cardano.exact.server;

import org.x402.mechanisms.cardano.exact.masumi.InMemoryMasumiTermsStorage;
import org.x402.mechanisms.cardano.exact.masumi.MasumiTermsStorage;

/**
 * Cardano resource-server configuration.
 *
 * @param masumiStorage issued Masumi quotes keyed by {@code termsDigest} (default: in-memory,
 *     single instance only; production deployments need a shared, atomically updating store)
 * @param masumi lets the scheme issue Masumi quotes itself, or {@code null}
 */
public record ExactCardanoServerConfig(MasumiTermsStorage masumiStorage, MasumiIssuerConfig masumi) {

  /** Fills the default storage. */
  public ExactCardanoServerConfig {
    masumiStorage = masumiStorage == null ? new InMemoryMasumiTermsStorage() : masumiStorage;
  }

  /**
   * A builder.
   *
   * @return the builder
   */
  public static Builder builder() {
    return new Builder();
  }

  /** Builder for {@link ExactCardanoServerConfig}. */
  public static final class Builder {
    private MasumiTermsStorage masumiStorage;
    private MasumiIssuerConfig masumi;

    private Builder() {}

    /**
     * Sets the quote storage.
     *
     * @param v the storage
     * @return this builder
     */
    public Builder masumiStorage(MasumiTermsStorage v) {
      masumiStorage = v;
      return this;
    }

    /**
     * Enables quote issuance.
     *
     * @param v the issuer config
     * @return this builder
     */
    public Builder masumi(MasumiIssuerConfig v) {
      masumi = v;
      return this;
    }

    /**
     * Builds the config.
     *
     * @return the config
     */
    public ExactCardanoServerConfig build() {
      return new ExactCardanoServerConfig(masumiStorage, masumi);
    }
  }
}
