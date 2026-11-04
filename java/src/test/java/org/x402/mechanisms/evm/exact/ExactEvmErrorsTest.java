package org.x402.mechanisms.evm.exact;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

class ExactEvmErrorsTest {

    private static final Path GO_EVM = Path.of("..", "go", "mechanisms", "evm");
    private static final Pattern GO_CONSTANT =
            Pattern.compile("^\\s*Err(\\w+)\\s*=\\s*\"([^\"]*)\"", Pattern.MULTILINE);

    /**
     * Every Go reason code except the Permit2 and ERC-20 approval ones has a Java constant with the same value,
     * named after the Go constant, and Java has nothing else.
     */
    @Test
    void mirrorsGoReasonCodes() throws IOException, IllegalAccessException {
        assumeTrue(Files.isDirectory(GO_EVM), "Go SDK sources not available next to the Java SDK");
        Map<String, String> expected = new TreeMap<>();
        readGo(GO_EVM.resolve("exact/client/errors.go"), "CLIENT_", expected);
        readGo(GO_EVM.resolve("exact/server/errors.go"), "SERVER_", expected);
        readGo(GO_EVM.resolve("exact/facilitator/errors.go"), "", expected);
        readGo(GO_EVM.resolve("errors.go"), "", expected);

        assertEquals(expected, javaConstants());
    }

    @Test
    void keepsWireValuesSharedWithOtherSdks() {
        assertEquals("invalid_exact_evm_non_canonical_signature", ExactEvmErrors.INVALID_SIGNATURE_S);
        assertEquals("invalid_exact_evm_payload_authorization_valid_before", ExactEvmErrors.VALID_BEFORE_EXPIRED);
        assertEquals("settlement_pending", ExactEvmErrors.SETTLEMENT_PENDING);
    }

    private static void readGo(Path file, String prefix, Map<String, String> into) throws IOException {
        Matcher matcher = GO_CONSTANT.matcher(Files.readString(file, StandardCharsets.UTF_8));
        while (matcher.find()) {
            String goName = matcher.group(1);
            if (goName.contains("Permit2") || goName.startsWith("Erc20")) {
                continue;
            }
            into.put(prefix + goName.replaceAll("(?<=[a-z0-9])(?=[A-Z])", "_").toUpperCase(Locale.ROOT),
                    matcher.group(2));
        }
    }

    private static Map<String, String> javaConstants() throws IllegalAccessException {
        Map<String, String> constants = new TreeMap<>();
        for (Field field : ExactEvmErrors.class.getDeclaredFields()) {
            if (Modifier.isPublic(field.getModifiers()) && Modifier.isStatic(field.getModifiers())) {
                constants.put(field.getName(), (String) field.get(null));
            }
        }
        return constants;
    }
}
