// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {HederaAllowanceDepositCollector} from "../../src/hedera/HederaAllowanceDepositCollector.sol";
import {DepositCollector} from "../../src/periphery/DepositCollector.sol";
import {MockHederaAccountService} from "./mocks/MockHederaAccountService.sol";
import {MockHederaTokenService, MockHtsToken} from "./mocks/MockHederaTokenService.sol";

/// @dev The test contract itself plays the role of `x402BatchSettlement` (it is the collector's owner).
contract HederaAllowanceDepositCollectorTest is Test {
    HederaAllowanceDepositCollector collector;
    MockHederaAccountService has;
    MockHederaTokenService hts;
    MockHtsToken token;
    VmSafe.Wallet payer;

    bytes32 constant CHANNEL_ID = bytes32(uint256(0xabc));
    uint256 constant AMOUNT = 1000e6;

    function setUp() public {
        vm.chainId(296);
        vm.warp(1_000_000);
        vm.etch(address(0x16a), address(new MockHederaAccountService()).code);
        vm.etch(address(0x167), address(new MockHederaTokenService()).code);
        has = MockHederaAccountService(address(0x16a));
        hts = MockHederaTokenService(address(0x167));

        payer = vm.createWallet("payer");
        collector = new HederaAllowanceDepositCollector(address(this));
        token = new MockHtsToken();
        token.mint(payer.addr, 10_000e6);
        hts.setAllowance(address(token), payer.addr, address(collector), 5_000e6);
        hts.setAssociated(address(this), address(token), true);
    }

    function _data(uint256 amount, uint256 nonce, uint256 deadline, VmSafe.Wallet memory w, bytes32 channelId)
        internal
        returns (bytes memory)
    {
        bytes32 digest = collector.getDepositDigest(channelId, address(token), amount, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(w, digest);
        return abi.encode(nonce, deadline, abi.encodePacked(r, s, v));
    }

    function test_collect_success() public {
        collector.collect(payer.addr, address(token), AMOUNT, CHANNEL_ID, _data(AMOUNT, 1, block.timestamp + 60, payer, CHANNEL_ID));
        assertEq(token.balanceOf(address(this)), AMOUNT);
        assertEq(token.balanceOf(payer.addr), 10_000e6 - AMOUNT);
        assertTrue(collector.usedNonces(payer.addr, 1));
        (, uint256 remaining) = hts.allowance(address(token), payer.addr, address(collector));
        assertEq(remaining, 5_000e6 - AMOUNT);
    }

    function test_collect_revert_expired() public {
        bytes memory data = _data(AMOUNT, 1, block.timestamp - 1, payer, CHANNEL_ID);
        vm.expectRevert(HederaAllowanceDepositCollector.DepositAuthorizationExpired.selector);
        collector.collect(payer.addr, address(token), AMOUNT, CHANNEL_ID, data);
    }

    function test_collect_revert_nonceReplay() public {
        bytes memory data = _data(AMOUNT, 1, block.timestamp + 60, payer, CHANNEL_ID);
        collector.collect(payer.addr, address(token), AMOUNT, CHANNEL_ID, data);
        vm.expectRevert(HederaAllowanceDepositCollector.NonceAlreadyUsed.selector);
        collector.collect(payer.addr, address(token), AMOUNT, CHANNEL_ID, data);
    }

    function test_collect_revert_wrongSigner() public {
        VmSafe.Wallet memory other = vm.createWallet("other");
        bytes memory data = _data(AMOUNT, 1, block.timestamp + 60, other, CHANNEL_ID);
        vm.expectRevert(HederaAllowanceDepositCollector.InvalidDepositSignature.selector);
        collector.collect(payer.addr, address(token), AMOUNT, CHANNEL_ID, data);
    }

    function test_collect_revert_amountMismatch() public {
        bytes memory data = _data(AMOUNT, 1, block.timestamp + 60, payer, CHANNEL_ID);
        vm.expectRevert(HederaAllowanceDepositCollector.InvalidDepositSignature.selector);
        collector.collect(payer.addr, address(token), AMOUNT + 1, CHANNEL_ID, data);
    }

    function test_collect_revert_channelMismatch() public {
        bytes memory data = _data(AMOUNT, 1, block.timestamp + 60, payer, bytes32(uint256(1)));
        vm.expectRevert(HederaAllowanceDepositCollector.InvalidDepositSignature.selector);
        collector.collect(payer.addr, address(token), AMOUNT, CHANNEL_ID, data);
    }

    function test_collect_revert_htsFailure() public {
        hts.forceTransferResponse(184);
        bytes memory data = _data(AMOUNT, 1, block.timestamp + 60, payer, CHANNEL_ID);
        vm.expectRevert(abi.encodeWithSelector(HederaAllowanceDepositCollector.HtsTransferFailed.selector, int64(184)));
        collector.collect(payer.addr, address(token), AMOUNT, CHANNEL_ID, data);
    }

    function test_collect_revert_amountExceedsInt64() public {
        uint256 huge = uint256(uint64(type(int64).max)) + 1;
        bytes memory data = _data(huge, 1, block.timestamp + 60, payer, CHANNEL_ID);
        vm.expectRevert(HederaAllowanceDepositCollector.AmountExceedsInt64.selector);
        collector.collect(payer.addr, address(token), huge, CHANNEL_ID, data);
    }

    function test_collect_revert_onlyX402BatchSettlement() public {
        bytes memory data = _data(AMOUNT, 1, block.timestamp + 60, payer, CHANNEL_ID);
        vm.prank(makeAddr("attacker"));
        vm.expectRevert(DepositCollector.OnlyX402BatchSettlement.selector);
        collector.collect(payer.addr, address(token), AMOUNT, CHANNEL_ID, data);
    }

    function test_collect_nonceNotConsumedWhenSignatureInvalid() public {
        // The nonce is marked used before HAS validation; a rejected authorization burns it (documented, replay-safe).
        VmSafe.Wallet memory other = vm.createWallet("other");
        bytes memory data = _data(AMOUNT, 9, block.timestamp + 60, other, CHANNEL_ID);
        vm.expectRevert(HederaAllowanceDepositCollector.InvalidDepositSignature.selector);
        collector.collect(payer.addr, address(token), AMOUNT, CHANNEL_ID, data);
        // revert rolled back the nonce write
        assertFalse(collector.usedNonces(payer.addr, 9));
    }

    /// @dev Fixed vector consumed by the TypeScript unit tests (`hederaAllowance.test.ts`).
    function test_depositDigest_vector() public {
        HederaAllowanceDepositCollector fixedCollector = HederaAllowanceDepositCollector(
            address(0x00000000000000000000000000000000000aBCdE)
        );
        vm.etch(address(fixedCollector), address(collector).code);
        // immutables live in code, so re-deploy a copy bound to a known settlement address at a known address
        bytes32 digest = fixedCollector.getDepositDigest(
            bytes32(uint256(0x1111)),
            address(0x0000000000000000000000000000000000068cDa),
            5_000_000,
            42,
            1_800_000_000
        );
        bytes32 expected = keccak256(
            abi.encode(
                fixedCollector.DEPOSIT_TYPEHASH(),
                bytes32(uint256(0x1111)),
                address(0x0000000000000000000000000000000000068cDa),
                uint256(5_000_000),
                uint256(42),
                uint256(1_800_000_000),
                address(fixedCollector),
                uint256(296)
            )
        );
        assertEq(digest, expected);
        emit log_named_bytes32("DEPOSIT_TYPEHASH", fixedCollector.DEPOSIT_TYPEHASH());
        emit log_named_bytes32("vector digest", digest);
    }
}
