package org.x402.core.utils;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import java.io.IOException;
import java.io.InputStream;
import java.math.BigDecimal;
import java.util.stream.Stream;
import java.util.stream.StreamSupport;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.x402.core.json.X402Json;

/**
 * Money parsing and token-amount conversion, including the error messages, against vectors
 * exported from the TypeScript SDK.
 */
class MoneyVectorsTest {

  static JsonNode load() throws IOException {
    try (InputStream in = MoneyVectorsTest.class.getResourceAsStream("/vectors/money.json")) {
      return X402Json.mapper().readTree(in).get("cases");
    }
  }

  static Stream<Arguments> parseMoney() throws IOException {
    return StreamSupport.stream(load().get("parseMoney").spliterator(), false)
        .map(c -> Arguments.of(c.get("input").toString(), c));
  }

  static Stream<Arguments> tokenAmounts() throws IOException {
    return StreamSupport.stream(load().get("convertToTokenAmount").spliterator(), false)
        .map(c -> Arguments.of(c.get("amount").asText() + "@" + c.get("decimals").asInt(), c));
  }

  @ParameterizedTest(name = "{0}")
  @MethodSource("parseMoney")
  void parseMoneyMatchesTs(String label, JsonNode c) {
    JsonNode input = c.get("input");
    if (c.has("error")) {
      if (input.isNumber()) {
        assertThatThrownBy(() -> Amounts.parseMoney(input.decimalValue()))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessage(c.get("error").asText());
      } else {
        assertThatThrownBy(() -> Amounts.parseMoney(input.asText()))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessage(c.get("error").asText());
      }
      return;
    }
    Amounts.ParsedMoney parsed =
        input.isNumber()
            ? Amounts.parseMoney(new BigDecimal(input.asText()))
            : Amounts.parseMoney(input.asText());
    assertThat(parsed.amount()).isEqualTo(c.get("amount").asText());
    assertThat(parsed.symbol()).isEqualTo(c.has("symbol") ? c.get("symbol").asText() : null);
  }

  @ParameterizedTest(name = "{0}")
  @MethodSource("tokenAmounts")
  void convertToTokenAmountMatchesTs(String label, JsonNode c) {
    String amount = c.get("amount").asText();
    int decimals = c.get("decimals").asInt();
    if (c.has("error")) {
      assertThatThrownBy(() -> Amounts.convertToTokenAmount(amount, decimals))
          .isInstanceOf(IllegalArgumentException.class)
          .hasMessage(c.get("error").asText());
    } else {
      assertThat(Amounts.convertToTokenAmount(amount, decimals))
          .isEqualTo(c.get("result").asText());
    }
  }
}
