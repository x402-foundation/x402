package org.x402.mechanisms.cardano.exact.client;

import com.bloxbean.cardano.client.api.UtxoSupplier;
import com.bloxbean.cardano.client.api.common.OrderEnum;
import com.bloxbean.cardano.client.api.exception.InsufficientBalanceException;
import com.bloxbean.cardano.client.api.model.Amount;
import com.bloxbean.cardano.client.api.model.Utxo;
import com.bloxbean.cardano.client.coinselection.impl.LargestFirstUtxoSelectionStrategy;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Picks the inputs that join the nonce, with cardano-client-lib's largest-first strategy over a
 * fixed, already fetched list of UTxOs. The nonce itself is never offered: the caller always
 * spends it. Nothing is fetched again, so the selection can only contain UTxOs the caller knows.
 */
final class InputSelection {

  private final String address;
  private final LargestFirstUtxoSelectionStrategy strategy;
  private final Map<String, Utxo> originals = new LinkedHashMap<>();

  /**
   * Prepares the selection.
   *
   * @param address the wallet address (the strategy's sender; not queried)
   * @param candidates the UTxOs that may join the nonce, reference-script UTxOs already removed
   */
  InputSelection(String address, List<Utxo> candidates) {
    this.address = address;
    List<Utxo> offered = new ArrayList<>();
    for (Utxo u : candidates) {
      originals.put(key(u), u);
      offered.add(lowercased(u));
    }
    UtxoSupplier supplier = new UtxoSupplier() {
      @Override
      public List<Utxo> getPage(String a, Integer count, Integer page, OrderEnum order) {
        return page == null || page == 0 ? offered : List.of();
      }

      @Override
      public Optional<Utxo> getTxOutput(String txHash, int outputIndex) {
        return Optional.empty();
      }

      @Override
      public List<Utxo> getAll(String a) {
        return offered;
      }
    };
    // false: datum-hash UTxOs are spendable wallet funds, as they always were here.
    this.strategy = new LargestFirstUtxoSelectionStrategy(supplier, false);
  }

  /**
   * Selects candidates covering {@code target}.
   *
   * @param target lovelace under {@code "lovelace"}, tokens under {@code policy.name}
   * @return the original UTxOs chosen (empty when nothing is needed), or empty when the
   *     candidates cannot cover the target
   */
  Optional<List<Utxo>> select(Map<String, BigInteger> target) {
    List<Amount> amounts = new ArrayList<>();
    target.forEach((unit, qty) -> {
      if (qty.signum() > 0) {
        amounts.add(new Amount(unit.replace(".", "").toLowerCase(Locale.ROOT), qty));
      }
    });
    if (amounts.isEmpty()) {
      return Optional.of(List.of());
    }
    Set<Utxo> chosen;
    try {
      // No datum filter, no input limit: only the amounts decide.
      chosen = strategy.select(address, amounts, null, null, Set.of(), Integer.MAX_VALUE);
    } catch (InsufficientBalanceException e) {
      return Optional.empty();
    }
    List<Utxo> result = new ArrayList<>();
    for (Utxo u : chosen) {
      result.add(originals.get(key(u)));
    }
    return Optional.of(result);
  }

  private static String key(Utxo u) {
    return u.getTxHash() + "#" + u.getOutputIndex();
  }

  /** A copy whose asset units are lowercase, as the targets are. */
  private static Utxo lowercased(Utxo u) {
    List<Amount> amounts = new ArrayList<>();
    // A missing amount list counts as empty, as CardanoUtils.lovelace/assets treat it.
    for (Amount a : u.getAmount() == null ? List.<Amount>of() : u.getAmount()) {
      if (a != null && a.getUnit() != null && a.getQuantity() != null) {
        amounts.add(new Amount(a.getUnit().toLowerCase(Locale.ROOT), a.getQuantity()));
      }
    }
    return new Utxo(u.getTxHash(), u.getOutputIndex(), u.getAddress(), amounts, u.getDataHash(),
        u.getInlineDatum(), u.getReferenceScriptHash());
  }
}
