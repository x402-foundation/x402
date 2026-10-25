package org.x402.spring.web.reactive;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Supplier;
import org.reactivestreams.Publisher;
import org.springframework.core.io.buffer.DataBuffer;
import org.springframework.core.io.buffer.DataBufferUtils;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ResponseCookie;
import org.springframework.http.server.reactive.ServerHttpResponse;
import org.springframework.http.server.reactive.ServerHttpResponseDecorator;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * Buffers a paid handler's whole response. {@code
 * writeWith}, {@code writeAndFlushWith} and {@code setComplete} all end here, so no-body responses
 * (204, {@code Mono<Void>}) are settled too. Status, headers, cookies and before-commit actions
 * are held locally as well; the real response only carries what outer filters set, until the
 * filter releases the handler's response. Every buffer is copied and released at once.
 */
final class BufferingResponse extends ServerHttpResponseDecorator {

  private final ByteArrayOutputStream body = new ByteArrayOutputStream(1024);
  private final HttpHeaders headers = new HttpHeaders();
  private final MultiValueMap<String, ResponseCookie> cookies = new LinkedMultiValueMap<>();
  private final List<Supplier<? extends Mono<Void>>> beforeCommit = new ArrayList<>();
  private HttpStatusCode status;
  private boolean wroteBody;

  BufferingResponse(ServerHttpResponse delegate) {
    super(delegate);
    headers.putAll(delegate.getHeaders());
  }

  @Override
  public HttpHeaders getHeaders() {
    return headers;
  }

  @Override
  public boolean setStatusCode(HttpStatusCode statusCode) {
    status = statusCode;
    return true;
  }

  @Override
  public HttpStatusCode getStatusCode() {
    return status != null ? status : getDelegate().getStatusCode();
  }

  @Override
  public MultiValueMap<String, ResponseCookie> getCookies() {
    return cookies;
  }

  @Override
  public void addCookie(ResponseCookie cookie) {
    cookies.add(cookie.getName(), cookie);
  }

  @Override
  public void beforeCommit(Supplier<? extends Mono<Void>> action) {
    beforeCommit.add(action);
  }

  @Override
  public boolean isCommitted() {
    return false;
  }

  @Override
  public Mono<Void> writeWith(Publisher<? extends DataBuffer> publisher) {
    return Flux.from(publisher).doOnNext(this::copyAndRelease)
        .doOnDiscard(DataBuffer.class, DataBufferUtils::release).then();
  }

  @Override
  public Mono<Void> writeAndFlushWith(Publisher<? extends Publisher<? extends DataBuffer>> body) {
    return writeWith(Flux.from(body).concatMap(Flux::from));
  }

  @Override
  public Mono<Void> setComplete() {
    return Mono.empty();
  }

  private void copyAndRelease(DataBuffer buffer) {
    try {
      byte[] bytes = new byte[buffer.readableByteCount()];
      buffer.read(bytes);
      synchronized (body) {
        body.write(bytes, 0, bytes.length);
        wroteBody = true;
      }
    } finally {
      DataBufferUtils.release(buffer);
    }
  }

  byte[] bytes() {
    synchronized (body) {
      return body.toByteArray();
    }
  }

  boolean wroteBody() {
    synchronized (body) {
      return wroteBody;
    }
  }

  /** Copies the held-back status, headers, cookies and before-commit actions to the real response. */
  void applyToDelegate() {
    ServerHttpResponse real = getDelegate();
    if (status != null) {
      real.setStatusCode(status);
    }
    real.getHeaders().putAll(headers);
    cookies.values().forEach(list -> list.forEach(real::addCookie));
    beforeCommit.forEach(real::beforeCommit);
  }
}
