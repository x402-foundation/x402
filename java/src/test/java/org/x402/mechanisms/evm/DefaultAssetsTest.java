package org.x402.mechanisms.evm;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

class DefaultAssetsTest {

    private static final Path GO_TABLE = Path.of("..", "go", "mechanisms", "evm", "default_assets.go");

    @Test
    void everyEntryMatchesTheGoTableInGoOrder() throws IOException {
        assumeTrue(Files.isReadable(GO_TABLE), "Go SDK sources not available next to the Java SDK");

        List<String> goRows = goTableRows(Files.readString(GO_TABLE, StandardCharsets.UTF_8));
        assertFalse(goRows.isEmpty(), "Go table parse");
        Map<String, Integer> goIndexByKey = new HashMap<>();
        for (int i = 0; i < goRows.size(); i++) {
            goIndexByKey.putIfAbsent(key(goRows.get(i)), i);
        }

        // Go may list assets the Java table does not carry yet, but every Java entry must be Go's, in Go's order
        int previous = -1;
        for (Map.Entry<String, List<DefaultAsset>> entry : DefaultAssets.all().entrySet()) {
            for (DefaultAsset asset : entry.getValue()) {
                String row = row(entry.getKey(), asset);
                int index = goIndexByKey.getOrDefault(key(row), -1);
                assertTrue(index >= 0, "Java entry " + row + " has no Go entry for the same network and address");
                assertEquals(goRows.get(index), row);
                assertTrue(index > previous, "Java entry " + row + " is out of Go's order");
                previous = index;
            }
        }
    }

    @Test
    void returnsBaseSepoliaUsdcAsDefault() {
        DefaultAsset usdc = DefaultAssets.defaultAsset("eip155:84532").orElseThrow();

        assertEquals(new DefaultAsset("0x036CbD53842c5426634e7929541eC2318f3dCF7e", "USDC", "2", 6, "USDC", "", false),
                usdc);
        assertTrue(usdc.isEip3009());
    }

    @Test
    void returnsBaseUsdcWithItsEip712Name() {
        DefaultAsset usdc = DefaultAssets.defaultAsset("eip155:8453").orElseThrow();

        assertEquals("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", usdc.address());
        assertEquals("USD Coin", usdc.name());
    }

    @Test
    void selectsAssetsBySymbolCaseInsensitively() {
        assertEquals("Tether USD", DefaultAssets.defaultAsset("eip155:42220", "usdt").orElseThrow().name());
        assertEquals("USAT", DefaultAssets.defaultAsset("eip155:42220", "USAT").orElseThrow().symbol());
        assertEquals("USDC", DefaultAssets.defaultAsset("eip155:42220", "").orElseThrow().symbol());
        assertEquals("USDC.e", DefaultAssets.defaultAsset("eip155:36900", "USDC.E").orElseThrow().symbol());
        assertTrue(DefaultAssets.defaultAsset("eip155:42220", "DAI").isEmpty());
    }

    @Test
    void returnsEmptyForUnknownNetworks() {
        assertTrue(DefaultAssets.defaultAsset("eip155:999999").isEmpty());
        assertTrue(DefaultAssets.defaultAsset("eip155:999999", "USDC").isEmpty());
        assertTrue(DefaultAssets.find("0x036CbD53842c5426634e7929541eC2318f3dCF7e", "eip155:999999").isEmpty());
        // v1 network names are not resolved: this SDK speaks CAIP-2 only
        assertTrue(DefaultAssets.defaultAsset("base-sepolia").isEmpty());
    }

    @Test
    void findsAssetsByAddressCaseInsensitively() {
        String lower = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";

        assertEquals("USDC", DefaultAssets.find(lower, "eip155:84532").orElseThrow().name());
        assertEquals("Tether USD",
                DefaultAssets.find("0x48065FBBE25F71C9282DDF5E1CD6D6A887483D5E", "eip155:42220").orElseThrow().name());
        assertTrue(DefaultAssets.find(lower, "eip155:8453").isEmpty());
    }

    @Test
    void flagsPermit2Assets() {
        DefaultAsset megaUsd = DefaultAssets.defaultAsset("eip155:4326").orElseThrow();
        DefaultAsset igra = DefaultAssets.defaultAsset("eip155:38833").orElseThrow();

        assertFalse(megaUsd.isEip3009());
        assertEquals(EvmConstants.ASSET_TRANSFER_METHOD_PERMIT2, megaUsd.assetTransferMethod());
        assertEquals(18, megaUsd.decimals());
        assertTrue(megaUsd.supportsEip2612());
        assertFalse(igra.isEip3009());
        assertFalse(igra.supportsEip2612());
    }

    @Test
    void storesEveryAddressInChecksumForm() {
        DefaultAssets.all().values().stream().flatMap(List::stream).forEach(
                asset -> assertEquals(EvmAddress.toChecksum(asset.address()), asset.address(), asset.symbol()));
    }

    @Test
    void tableIsImmutable() {
        Map<String, List<DefaultAsset>> all = DefaultAssets.all();

        assertThrows(UnsupportedOperationException.class, () -> all.remove("eip155:8453"));
        assertThrows(UnsupportedOperationException.class, () -> all.get("eip155:42220").clear());
    }

    @Test
    void validatesAssetsOnConstruction() {
        assertThrows(IllegalArgumentException.class, () -> new DefaultAsset("USDC", "USDC", "2", 6, "USDC", "", false));
        assertThrows(IllegalArgumentException.class,
                () -> new DefaultAsset(
                        "0x036CbD53842c5426634e7929541eC2318f3dCF7e", "USDC", "2", 256, "USDC", "", false));
        assertThrows(IllegalArgumentException.class, () -> new DefaultAsset(
                "0x036CbD53842c5426634e7929541eC2318f3dCF7e", "USDC", "2", -1, "USDC", "", false));
        assertTrue(new DefaultAsset("0x036CbD53842c5426634e7929541eC2318f3dCF7e", "USDC", "2", 6, "USDC",
                EvmConstants.ASSET_TRANSFER_METHOD_EIP3009, false).isEip3009());
    }

    /** Extracts {@code network|address|name|version|decimals|symbol|method|eip2612} rows from the Go source. */
    private static List<String> goTableRows(String source) {
        String table = source.substring(
                source.indexOf("var DefaultAssets"), source.indexOf("var legacyNetworkChainIDs"));
        Pattern networkLine = Pattern.compile("^\\s*\"(eip155:\\d+)\": \\{\\s*$");
        Pattern assetLine = Pattern.compile("^\\s*\\{(Asset:.*)},\\s*$");
        Pattern field = Pattern.compile("(\\w+): (\"[^\"]*\"|\\w+)");
        List<String> rows = new ArrayList<>();
        String network = null;
        for (String line : table.split("\n")) {
            Matcher networkMatch = networkLine.matcher(line);
            if (networkMatch.matches()) {
                network = networkMatch.group(1);
                continue;
            }
            Matcher assetMatch = assetLine.matcher(line);
            if (!assetMatch.matches()) {
                continue;
            }
            Map<String, String> fields = new HashMap<>();
            Matcher fieldMatch = field.matcher(assetMatch.group(1));
            while (fieldMatch.find()) {
                fields.put(fieldMatch.group(1), fieldMatch.group(2).replace("\"", ""));
            }
            String raw = fields.getOrDefault("AssetTransferMethod", "");
            String method = switch (raw) {
                case "", "AssetTransferMethodEIP3009", "eip3009" -> "";
                case "AssetTransferMethodPermit2", "permit2" -> EvmConstants.ASSET_TRANSFER_METHOD_PERMIT2;
                default -> fail("Go row " + fields.get("Asset") + " on " + network
                        + " uses unknown AssetTransferMethod " + raw);
            };
            rows.add(String.join("|", network, fields.get("Asset"), fields.get("Name"), fields.get("Version"),
                    fields.get("Decimals"), fields.get("Symbol"), method,
                    fields.getOrDefault("SupportsEip2612", "false")));
        }
        return rows;
    }

    /** The {@code network|address} prefix of a row, with the address lower-cased. */
    private static String key(String row) {
        String[] parts = row.split("\\|", 3);
        return parts[0] + "|" + parts[1].toLowerCase(Locale.ROOT);
    }

    private static String row(String network, DefaultAsset asset) {
        return String.join("|", network, asset.address(), asset.name(), asset.version(),
                Integer.toString(asset.decimals()), asset.symbol(), asset.assetTransferMethod(),
                Boolean.toString(asset.supportsEip2612()));
    }
}
