package org.x402.spring.web.reactive;

import java.nio.ByteBuffer;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.springframework.core.Ordered;
import org.springframework.core.io.buffer.DataBuffer;
import org.springframework.core.io.buffer.DataBufferFactory;
import org.springframework.core.io.buffer.PooledDataBuffer;
import org.springframework.http.server.reactive.ServerHttpResponseDecorator;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;
import reactor.core.publisher.Mono;

/**
 * A leak-detecting {@link DataBufferFactory}: an outermost web filter hands every response a
 * factory that records each buffer it creates; a test then checks that all of them were released.
 */
public final class LeakTrackingBuffers implements WebFilter, Ordered {

  private final List<PooledDataBuffer> created = new CopyOnWriteArrayList<>();

  /**
   * Buffers still allocated (leaked once the response is complete).
   *
   * @return the count
   */
  public long unreleased() {
    return created.stream().filter(PooledDataBuffer::isAllocated).count();
  }

  /**
   * Buffers created so far.
   *
   * @return the count
   */
  public int created() {
    return created.size();
  }

  /** Forgets the recorded buffers. */
  public void reset() {
    created.clear();
  }

  @Override
  public int getOrder() {
    return Ordered.HIGHEST_PRECEDENCE;
  }

  @Override
  public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
    DataBufferFactory real = exchange.getResponse().bufferFactory();
    DataBufferFactory tracking = new DataBufferFactory() {
      @Override
      @Deprecated
      public DataBuffer allocateBuffer() {
        return track(real.allocateBuffer(256));
      }

      @Override
      public DataBuffer allocateBuffer(int initialCapacity) {
        return track(real.allocateBuffer(initialCapacity));
      }

      @Override
      public DataBuffer wrap(ByteBuffer byteBuffer) {
        return track(real.wrap(byteBuffer));
      }

      @Override
      public DataBuffer wrap(byte[] bytes) {
        return track(real.wrap(bytes));
      }

      @Override
      public DataBuffer join(List<? extends DataBuffer> dataBuffers) {
        return track(real.join(dataBuffers));
      }

      @Override
      public boolean isDirect() {
        return real.isDirect();
      }
    };
    return chain.filter(exchange.mutate().response(
        new ServerHttpResponseDecorator(exchange.getResponse()) {
          @Override
          public DataBufferFactory bufferFactory() {
            return tracking;
          }
        }).build());
  }

  private DataBuffer track(DataBuffer buffer) {
    if (buffer instanceof PooledDataBuffer pooled) {
      created.add(pooled);
    }
    return buffer;
  }
}
