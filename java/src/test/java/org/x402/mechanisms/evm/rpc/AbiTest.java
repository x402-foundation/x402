package org.x402.mechanisms.evm.rpc;

import org.x402.mechanisms.evm.Hex;

import org.junit.jupiter.api.Test;

import java.math.BigInteger;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_ADDRESS_0;
import static org.x402.mechanisms.evm.CastVectors.ANVIL_ADDRESS_1;
import static org.x402.mechanisms.evm.CastVectors.NONCE;
import static org.x402.mechanisms.evm.rpc.RpcCastVectors.AUTHORIZATION_STATE_CALLDATA;
import static org.x402.mechanisms.evm.rpc.RpcCastVectors.BALANCE_OF_CALLDATA;
import static org.x402.mechanisms.evm.rpc.RpcCastVectors.INVALID_SIGNATURE_REVERT;
import static org.x402.mechanisms.evm.rpc.RpcCastVectors.TWA_CALLDATA;
import static org.x402.mechanisms.evm.rpc.RpcCastVectors.TWA_SELECTOR;
import static org.x402.mechanisms.evm.rpc.RpcCastVectors.TWA_SIGNATURE;
import static org.x402.mechanisms.evm.rpc.RpcCastVectors.USDT0_STRING;
import static org.x402.mechanisms.evm.rpc.RpcCastVectors.USD_COIN_STRING;

class AbiTest {

    private static final String R = "0x54b9f3b045b94aec7644428bf6cc9b5fe3217c0182b56eb2a2022563ef950f48";
    private static final String S = "0x648ba7bfc320ad10aa747350221bb9ebb4f6c928eb68e54df2530555794c41a2";

    @Test
    void computesSelectorsLikeCastSig() {
        assertEquals(TWA_SELECTOR, Hex.encode(Abi.selector(TWA_SIGNATURE)));
        // cast sig 'transfer(address,uint256)'
        assertEquals("0xa9059cbb", Hex.encode(Abi.selector("transfer(address,uint256)")));
        // cast calldata 'name()'
        assertEquals("0x06fdde03", Hex.encode(Abi.selector("name()")));
    }

    @Test
    void encodesTransferWithAuthorizationLikeCastCalldata() {
        byte[] calldata = Abi.encodeCall(TWA_SIGNATURE,
                ANVIL_ADDRESS_0, ANVIL_ADDRESS_1, BigInteger.valueOf(1000), BigInteger.ZERO,
                BigInteger.valueOf(1740672154L), Hex.decode(NONCE), 28, Hex.decode(R), Hex.decode(S));

        assertEquals(TWA_CALLDATA, Hex.encode(calldata));
    }

    @Test
    void encodesViewCallsLikeCastCalldata() {
        assertEquals(AUTHORIZATION_STATE_CALLDATA, Hex.encode(
                Abi.encodeCall("authorizationState(address,bytes32)", ANVIL_ADDRESS_0, Hex.decode(NONCE))));
        assertEquals(BALANCE_OF_CALLDATA, Hex.encode(Abi.encodeCall("balanceOf(address)", ANVIL_ADDRESS_0)));
        // cast calldata 'version()'
        assertEquals("0x54fd4d50", Hex.encode(Abi.encodeCall("version()")));
    }

    @Test
    void encodesBoolSmallUintsAndShortFixedBytesLikeCast() {
        // cast calldata 'f(bool,uint8,bytes4,uint64)' true 255 0xdeadbeef 18446744073709551615
        String expected = "0xbbfb7f10"
                + "0000000000000000000000000000000000000000000000000000000000000001"
                + "00000000000000000000000000000000000000000000000000000000000000ff"
                + "deadbeef00000000000000000000000000000000000000000000000000000000"
                + "000000000000000000000000000000000000000000000000ffffffffffffffff";

        byte[] calldata = Abi.encodeCall("f(bool,uint8,bytes4,uint64)",
                true, (short) 255, Hex.decode("0xdeadbeef"), new BigInteger("18446744073709551615"));

        assertEquals(expected, Hex.encode(calldata));
    }

    @Test
    void acceptsEveryIntegerBoxType() {
        String word = "0".repeat(63);
        byte[] fromByte = Abi.encodeCall("f(uint8)", (byte) 7);
        byte[] fromLong = Abi.encodeCall("f(uint8)", 7L);
        byte[] fromInteger = Abi.encodeCall("f(uint8)", 7);

        assertEquals(word + "7", Hex.encodeNoPrefix(fromByte).substring(8));
        assertEquals(Hex.encode(fromByte), Hex.encode(fromLong));
        assertEquals(Hex.encode(fromByte), Hex.encode(fromInteger));
    }

    @Test
    void rejectsMalformedSignatures() {
        assertThrows(IllegalArgumentException.class, () -> Abi.selector("transfer(address, uint256)"));
        assertThrows(IllegalArgumentException.class, () -> Abi.selector("transfer"));
        assertThrows(IllegalArgumentException.class, () -> Abi.encodeCall("f(address,)", ANVIL_ADDRESS_0));
        assertThrows(IllegalArgumentException.class, () -> Abi.encodeCall("1f()"));
    }

    @Test
    void rejectsUnsupportedTypes() {
        assertThrows(IllegalArgumentException.class, () -> Abi.encodeCall("f(string)", "text"));
        assertThrows(IllegalArgumentException.class, () -> Abi.encodeCall("f(bytes)", new byte[1]));
        assertThrows(IllegalArgumentException.class, () -> Abi.encodeCall("f(uint)", 1));
        assertThrows(IllegalArgumentException.class, () -> Abi.encodeCall("f(uint7)", 1));
        assertThrows(IllegalArgumentException.class, () -> Abi.encodeCall("f(uint264)", 1));
        assertThrows(IllegalArgumentException.class, () -> Abi.encodeCall("f(bytes33)", new byte[33]));
        assertThrows(IllegalArgumentException.class, () -> Abi.encodeCall("f(int256)", 1));
    }

    @Test
    void rejectsArgumentsThatDoNotMatchTheSignature() {
        assertThrows(IllegalArgumentException.class, () -> Abi.encodeCall("balanceOf(address)"));
        assertThrows(IllegalArgumentException.class, () -> Abi.encodeCall("balanceOf(address)", "0x1234"));
        assertThrows(IllegalArgumentException.class, () -> Abi.encodeCall("balanceOf(address)", 5));
        assertThrows(IllegalArgumentException.class, () -> Abi.encodeCall("balanceOf(address)", (Object) null));
        assertThrows(IllegalArgumentException.class, () -> Abi.encodeCall("f(bool)", 1));
        assertThrows(IllegalArgumentException.class, () -> Abi.encodeCall("f(uint256)", "1"));
        assertThrows(IllegalArgumentException.class, () -> Abi.encodeCall("f(uint256)", 1.0));
        assertThrows(IllegalArgumentException.class, () -> Abi.encodeCall("f(bytes32)", new byte[31]));
        assertThrows(IllegalArgumentException.class, () -> Abi.encodeCall("f(bytes32)", "0x00"));
    }

    @Test
    void rejectsIntegersOutsideTheDeclaredWidth() {
        assertThrows(IllegalArgumentException.class, () -> Abi.encodeCall("f(uint8)", 256));
        assertThrows(IllegalArgumentException.class, () -> Abi.encodeCall("f(uint256)", -1));
        assertThrows(IllegalArgumentException.class,
                () -> Abi.encodeCall("f(uint256)", BigInteger.ONE.shiftLeft(256)));
    }

    @Test
    void decodesStringsLikeCastAbiEncode() {
        assertEquals("USD Coin", Abi.decodeString(Hex.decode(USD_COIN_STRING)));
        assertEquals("USD₮0", Abi.decodeString(Hex.decode(USDT0_STRING)));
        // cast abi-encode 'f(string)' ''
        assertEquals("", Abi.decodeString(Hex.decode("0x"
                + "0000000000000000000000000000000000000000000000000000000000000020"
                + "0000000000000000000000000000000000000000000000000000000000000000")));
    }

    @Test
    void rejectsStringsWhoseOffsetOrLengthPointsOutsideTheData() {
        String offsetOnly = "0000000000000000000000000000000000000000000000000000000000000020";
        String hugeOffset = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
        String longLength = "0000000000000000000000000000000000000000000000000000000000000040";

        assertThrows(IllegalArgumentException.class, () -> Abi.decodeString(new byte[0]));
        assertThrows(IllegalArgumentException.class, () -> Abi.decodeString(Hex.decode(offsetOnly)));
        assertThrows(IllegalArgumentException.class, () -> Abi.decodeString(Hex.decode(hugeOffset + offsetOnly)));
        assertThrows(IllegalArgumentException.class,
                () -> Abi.decodeString(Hex.decode(offsetOnly + longLength + "00".repeat(32))));
    }

    @Test
    void decodesBoolsAndRejectsOtherWords() {
        // cast abi-encode 'f(bool)' true
        assertTrue(Abi.decodeBool(Hex.decode("0x" + "00".repeat(31) + "01")));
        assertFalse(Abi.decodeBool(new byte[32]));
        assertThrows(IllegalArgumentException.class, () -> Abi.decodeBool(Hex.decode("0x" + "00".repeat(31) + "02")));
        assertThrows(IllegalArgumentException.class, () -> Abi.decodeBool(new byte[0]));
    }

    @Test
    void decodesUint256FromTheFirstWord() {
        // cast abi-encode 'f(uint256)' $(cast max-uint)
        assertEquals(BigInteger.ONE.shiftLeft(256).subtract(BigInteger.ONE),
                Abi.decodeUint256(Hex.decode("0x" + "ff".repeat(32))));
        assertEquals(BigInteger.valueOf(1000), Abi.decodeUint256(Hex.decode("0x" + "00".repeat(30) + "03e8"
                + "ff".repeat(32))));
        assertThrows(IllegalArgumentException.class, () -> Abi.decodeUint256(new byte[31]));
    }

    @Test
    void decodesErrorStringReverts() {
        assertEquals(Optional.of("FiatTokenV2: invalid signature"),
                Abi.decodeRevertReason(Hex.decode(INVALID_SIGNATURE_REVERT)));
    }

    @Test
    void ignoresRevertDataThatIsNotAnErrorString() {
        // cast sig 'Panic(uint256)' followed by code 0x11
        assertEquals(Optional.empty(), Abi.decodeRevertReason(Hex.decode("0x4e487b71" + "00".repeat(31) + "11")));
        assertEquals(Optional.empty(), Abi.decodeRevertReason(new byte[0]));
        assertEquals(Optional.empty(), Abi.decodeRevertReason(Hex.decode("0x08c379a0")));
        assertEquals(Optional.empty(), Abi.decodeRevertReason(Hex.decode("0x08c379")));
    }
}
