package org.x402.mechanisms.cardano.testing;

import com.bloxbean.cardano.client.api.ProtocolParamsSupplier;
import com.bloxbean.cardano.client.api.UtxoSupplier;
import com.bloxbean.cardano.client.api.common.OrderEnum;
import com.bloxbean.cardano.client.api.model.ProtocolParams;
import com.bloxbean.cardano.client.api.model.Utxo;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;
import org.x402.mechanisms.cardano.utils.CardanoUtils;
import org.x402.mechanisms.cardano.chain.UtxoSnapshot;

/** A wallet provider serving fixed UTxOs and counting every call. */
public final class StubWallet implements UtxoSupplier, ProtocolParamsSupplier {

  /** UTxOs served for any address. */
  public final List<Utxo> utxos = new ArrayList<>();
  /** Calls to {@link #getAll}. */
  public final AtomicInteger utxoCalls = new AtomicInteger();
  /** Calls to {@link #getProtocolParams}. */
  public final AtomicInteger parameterCalls = new AtomicInteger();
  /** Served parameters. */
  public ProtocolParams parameters = Ccl.PARAMS;

  /**
   * Adds a UTxO.
   *
   * @param txHash the producing transaction
   * @param index the index
   * @param address the owner
   * @param coin lovelace
   * @param assets native assets
   * @return this wallet
   */
  public StubWallet utxo(String txHash, long index, String address, long coin, Map<String, BigInteger> assets) {
    utxos.add(Ccl.utxo(txHash, index, address, BigInteger.valueOf(coin), assets, false));
    return this;
  }

  /**
   * Total calls of any kind.
   *
   * @return the count
   */
  public int calls() {
    return utxoCalls.get() + parameterCalls.get();
  }

  /**
   * Copies the UTxOs into a facilitator stub as unspent inputs.
   *
   * @param backend the facilitator stub
   */
  public void publishTo(StubBackend backend) {
    for (Utxo u : utxos) {
      backend.utxos.put(CardanoUtils.ref(u), new UtxoSnapshot(
          true, u.getAddress(), CardanoUtils.lovelace(u), CardanoUtils.assets(u), null));
    }
  }

  @Override
  public List<Utxo> getAll(String address) {
    utxoCalls.incrementAndGet();
    return List.copyOf(utxos);
  }

  @Override
  public List<Utxo> getPage(String address, Integer nrOfItems, Integer page, OrderEnum order) {
    return page == null || page == 0 ? getAll(address) : List.of();
  }

  @Override
  public Optional<Utxo> getTxOutput(String txHash, int outputIndex) {
    return utxos.stream()
        .filter(u -> u.getTxHash().equals(txHash) && u.getOutputIndex() == outputIndex)
        .findFirst();
  }

  @Override
  public ProtocolParams getProtocolParams() {
    parameterCalls.incrementAndGet();
    return parameters;
  }
}
