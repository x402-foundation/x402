package org.x402.mechanisms.cardano.exact.server;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import java.util.function.UnaryOperator;
import org.junit.jupiter.api.Test;
import org.x402.core.SchemeNetworkServer.PaymentRequiredContext;
import org.x402.core.hooks.HookResults.Abort;
import org.x402.core.hooks.HookResults.AfterVerifyResult;
import org.x402.core.server.ServerHooks.VerifyResultContext;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;
import org.x402.core.types.VerifyResponse;
import org.x402.mechanisms.cardano.exact.masumi.InMemoryMasumiTermsStorage;
import org.x402.mechanisms.cardano.exact.masumi.MasumiTermsRecord;
import org.x402.mechanisms.cardano.exact.masumi.MasumiTermsStorage;
import org.x402.mechanisms.cardano.exact.masumi.MasumiTermsUpdateResult;
import org.x402.mechanisms.cardano.testing.Vectors;

/**
 * Fail-closed binding: when the terms storage fails
 * while binding a verified Masumi payment, the binding fails closed with an abort, so the
 * protected handler never runs on unbound terms. Core swallows after-verify hook exceptions, so
 * a thrown error would otherwise let the request proceed.
 */
class MasumiTermsStorageFailureTest {

  /** Delegates to the in-memory store until told to fail. */
  private static final class FlakyStorage implements MasumiTermsStorage {
    final InMemoryMasumiTermsStorage delegate = new InMemoryMasumiTermsStorage();
    boolean failing;

    @Override
    public MasumiTermsRecord get(String termsDigest) {
      return delegate.get(termsDigest);
    }

    @Override
    public MasumiTermsUpdateResult updateTerms(String termsDigest, UnaryOperator<MasumiTermsRecord> update) {
      if (failing) {
        throw new IllegalStateException("terms database unreachable");
      }
      return delegate.updateTerms(termsDigest, update);
    }
  }

  @Test
  void aStorageFailureWhileBindingAbortsTheRequest() {
    PaymentPayload payload = Vectors.payload(Vectors.fixture("12-masumi-happy").get("payload"));
    PaymentRequirements quote = Vectors.requirements(Vectors.fixture("12-masumi-happy").get("requirements"));
    FlakyStorage storage = new FlakyStorage();
    var server = new ExactCardanoServerScheme(ExactCardanoServerConfig.builder().masumiStorage(storage).build());
    server.enrichPaymentRequiredResponse(
        new PaymentRequiredContext(
            List.of(quote), null, ResourceInfo.of("https://api.example.com/weather"), null, null, null));
    storage.failing = true;

    AfterVerifyResult result =
        server
            .schemeHooks()
            .onAfterVerify()
            .apply(new VerifyResultContext(payload, payload.accepted(), Map.of(), null, VerifyResponse.valid("addr_test1payer")));

    assertThat(result).isInstanceOf(Abort.class);
    assertThat(((Abort) result).reason()).isEqualTo("masumi_terms_storage_unavailable");
    assertThat(((Abort) result).message()).contains("terms database unreachable");
  }
}
