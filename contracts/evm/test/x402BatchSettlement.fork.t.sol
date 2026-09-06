// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {x402BatchSettlement} from "../src/x402BatchSettlement.sol";
import {Permit2DepositCollector} from "../src/periphery/Permit2DepositCollector.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @title X402BatchSettlementForkTest
/// @notice Fork tests against real Permit2 deployment for the dual-authorizer channel model
/// @dev Run with: `forge test --match-contract X402BatchSettlementForkTest --fork-url $BASE_RPC_URL`
/// @dev Gas benchmarks (canonical Permit2): `forge test --match-test test_gas_fork --fork-url $BASE_RPC_URL -vv`
contract X402BatchSettlementForkTest is Test {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    bytes32 constant PERMIT2_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)");
    bytes32 constant PERMIT_WITNESS_TYPEHASH = keccak256(
        "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,DepositWitness witness)DepositWitness(bytes32 channelId)TokenPermissions(address token,uint256 amount)"
    );
    bytes32 constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 constant DEPOSIT_WITNESS_TYPEHASH = keccak256("DepositWitness(bytes32 channelId)");

    x402BatchSettlement public settlement;
    Permit2DepositCollector public permit2Collector;
    MockERC20 public token;

    uint256 public payerKey;
    address public payer;
    uint256 public payerAuthKey;
    address public payerAuthAddr;
    uint256 public receiverKey;
    address public receiverAddr;
    uint256 public receiverAuthKey;
    address public receiverAuthAddr;

    uint40 constant WITHDRAW_DELAY = 3600;
    uint128 constant DEPOSIT_AMOUNT = 1000e6;
    uint128 constant CLAIM_AMOUNT = 100e6;

    function setUp() public {
        if (block.chainid == 31_337) return;
        require(PERMIT2.code.length > 0, "Permit2 not deployed");

        payerKey = uint256(keccak256("x402-batch-test-payer"));
        payer = vm.addr(payerKey);
        payerAuthKey = uint256(keccak256("x402-batch-test-payerAuth"));
        payerAuthAddr = vm.addr(payerAuthKey);
        receiverKey = uint256(keccak256("x402-batch-test-receiver"));
        receiverAddr = vm.addr(receiverKey);
        receiverAuthKey = uint256(keccak256("x402-batch-test-receiverAuth"));
        receiverAuthAddr = vm.addr(receiverAuthKey);

        settlement = new x402BatchSettlement();
        permit2Collector = new Permit2DepositCollector(address(settlement), PERMIT2);
        token = new MockERC20("USDC", "USDC", 6);
        token.mint(payer, 100_000e6);

        vm.prank(payer);
        token.approve(PERMIT2, type(uint256).max);
    }

    modifier onlyFork() {
        if (block.chainid == 31_337) return;
        _;
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    function _makeConfig() internal view returns (x402BatchSettlement.ChannelConfig memory) {
        return x402BatchSettlement.ChannelConfig({
            payer: payer,
            payerAuthorizer: payerAuthAddr,
            receiver: receiverAddr,
            receiverAuthorizer: receiverAuthAddr,
            token: address(token),
            withdrawDelay: WITHDRAW_DELAY,
            salt: bytes32(0)
        });
    }

    function _channelId(
        x402BatchSettlement.ChannelConfig memory config
    ) internal view returns (bytes32) {
        return settlement.getChannelId(config);
    }

    function _getChannel(
        bytes32 id
    ) internal view returns (x402BatchSettlement.ChannelState memory ch) {
        (ch.balance, ch.totalClaimed) = settlement.channels(id);
    }

    function _permit2DomainSeparator() internal view returns (bytes32) {
        return keccak256(abi.encode(PERMIT2_DOMAIN_TYPEHASH, keccak256("Permit2"), block.chainid, PERMIT2));
    }

    function _nonce(
        uint256 salt
    ) internal view returns (uint256) {
        return uint256(keccak256(abi.encodePacked(block.timestamp, block.number, salt)));
    }

    function _signPermit2Deposit(
        x402BatchSettlement.ChannelConfig memory config,
        uint256 amount,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes memory) {
        bytes32 channelId = _channelId(config);
        bytes32 witnessHash = keccak256(abi.encode(DEPOSIT_WITNESS_TYPEHASH, channelId));
        bytes32 tokenHash = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, address(token), amount));
        bytes32 structHash = keccak256(
            abi.encode(PERMIT_WITNESS_TYPEHASH, tokenHash, address(permit2Collector), nonce, deadline, witnessHash)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _permit2DomainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _domainSeparator() internal view returns (bytes32) {
        (, string memory name, string memory version, uint256 chainId, address verifyingContract,,) =
            settlement.eip712Domain();
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifyingContract
            )
        );
    }

    function _signVoucher(bytes32 channelId, uint128 maxClaimableAmount) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(settlement.VOUCHER_TYPEHASH(), channelId, maxClaimableAmount));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerAuthKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signRefund(bytes32 channelId, uint256 refundNonce, uint128 amount) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(settlement.REFUND_TYPEHASH(), channelId, refundNonce, amount));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(receiverAuthKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _depositViaPermit2(
        x402BatchSettlement.ChannelConfig memory config,
        uint128 amount,
        uint256 permitNonce,
        uint256 deadline
    ) internal {
        bytes memory depositSig = _signPermit2Deposit(config, amount, permitNonce, deadline);
        bytes memory collectorData = abi.encode(permitNonce, deadline, depositSig, bytes(""));
        settlement.deposit(config, amount, address(permit2Collector), collectorData);
    }

    // =========================================================================
    // Fork Tests
    // =========================================================================

    function test_fork_fullLifecycle_permit2() public onlyFork {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        bytes32 channelId = _channelId(config);

        uint256 nonce = _nonce(0);
        uint256 deadline = block.timestamp + 3600;
        _depositViaPermit2(config, DEPOSIT_AMOUNT, nonce, deadline);

        x402BatchSettlement.ChannelState memory ch = _getChannel(channelId);
        assertEq(ch.balance, DEPOSIT_AMOUNT);

        bytes memory voucherSig = _signVoucher(channelId, CLAIM_AMOUNT);
        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](1);
        claims[0] = x402BatchSettlement.VoucherClaim({
            voucher: x402BatchSettlement.Voucher({channel: config, maxClaimableAmount: CLAIM_AMOUNT}),
            signature: voucherSig,
            totalClaimed: CLAIM_AMOUNT
        });
        vm.prank(receiverAuthAddr);
        settlement.claim(claims);

        uint256 balBefore = token.balanceOf(receiverAddr);
        settlement.settle(receiverAddr, address(token));
        assertEq(token.balanceOf(receiverAddr), balBefore + CLAIM_AMOUNT);
    }

    function test_fork_refund_afterPartialClaim() public onlyFork {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        bytes32 channelId = _channelId(config);

        uint256 nonce = _nonce(0);
        uint256 deadline = block.timestamp + 3600;
        _depositViaPermit2(config, DEPOSIT_AMOUNT, nonce, deadline);

        bytes memory voucherSig = _signVoucher(channelId, CLAIM_AMOUNT);
        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](1);
        claims[0] = x402BatchSettlement.VoucherClaim({
            voucher: x402BatchSettlement.Voucher({channel: config, maxClaimableAmount: CLAIM_AMOUNT}),
            signature: voucherSig,
            totalClaimed: CLAIM_AMOUNT
        });
        vm.prank(receiverAuthAddr);
        settlement.claim(claims);

        uint128 refundAmt = DEPOSIT_AMOUNT - CLAIM_AMOUNT;
        bytes memory refundSig = _signRefund(channelId, 0, refundAmt);
        uint256 payerBalBefore = token.balanceOf(payer);
        settlement.refundWithSignature(config, refundAmt, 0, refundSig);

        assertEq(token.balanceOf(payer), payerBalBefore + refundAmt);
    }

    function test_fork_tamperedWitness_reverts() public onlyFork {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();

        x402BatchSettlement.ChannelConfig memory tamperedConfig = _makeConfig();
        tamperedConfig.salt = bytes32(uint256(999));

        uint256 nonce = _nonce(0);
        uint256 deadline = block.timestamp + 3600;
        bytes memory depositSig = _signPermit2Deposit(config, DEPOSIT_AMOUNT, nonce, deadline);

        bytes memory collectorData = abi.encode(nonce, deadline, depositSig, bytes(""));

        vm.expectRevert();
        settlement.deposit(tamperedConfig, DEPOSIT_AMOUNT, address(permit2Collector), collectorData);
    }

    // =========================================================================
    // Gas benchmarks (canonical Permit2; requires `--fork-url`, e.g. Base or Ethereum mainnet)
    // =========================================================================

    function test_gas_fork_permit2_deposit_first() public onlyFork {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        uint256 nonce = _nonce(10);
        uint256 deadline = block.timestamp + 3600;
        bytes memory depositSig = _signPermit2Deposit(config, DEPOSIT_AMOUNT, nonce, deadline);
        bytes memory collectorData = abi.encode(nonce, deadline, depositSig, bytes(""));

        vm.prank(payer);
        settlement.deposit(config, DEPOSIT_AMOUNT, address(permit2Collector), collectorData);
        uint256 g = vm.snapshotGasLastCall("fork_deposit_permit2_first");
        console2.log("fork_deposit_permit2_first", g);
    }

    function test_gas_fork_claim_one_voucher() public onlyFork {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        bytes32 channelId = _channelId(config);
        uint256 nonce = _nonce(11);
        uint256 deadline = block.timestamp + 3600;
        _depositViaPermit2(config, DEPOSIT_AMOUNT, nonce, deadline);

        bytes memory voucherSig = _signVoucher(channelId, CLAIM_AMOUNT);
        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](1);
        claims[0] = x402BatchSettlement.VoucherClaim({
            voucher: x402BatchSettlement.Voucher({channel: config, maxClaimableAmount: CLAIM_AMOUNT}),
            signature: voucherSig,
            totalClaimed: CLAIM_AMOUNT
        });

        vm.prank(receiverAuthAddr);
        settlement.claim(claims);
        uint256 g = vm.snapshotGasLastCall("fork_claim_1_voucher");
        console2.log("fork_claim_1_voucher", g);
    }

    function test_gas_fork_settle() public onlyFork {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        bytes32 channelId = _channelId(config);
        uint256 nonce = _nonce(12);
        uint256 deadline = block.timestamp + 3600;
        _depositViaPermit2(config, DEPOSIT_AMOUNT, nonce, deadline);

        bytes memory voucherSig = _signVoucher(channelId, CLAIM_AMOUNT);
        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](1);
        claims[0] = x402BatchSettlement.VoucherClaim({
            voucher: x402BatchSettlement.Voucher({channel: config, maxClaimableAmount: CLAIM_AMOUNT}),
            signature: voucherSig,
            totalClaimed: CLAIM_AMOUNT
        });

        vm.prank(receiverAuthAddr);
        settlement.claim(claims);

        settlement.settle(receiverAddr, address(token));
        uint256 g = vm.snapshotGasLastCall("fork_settle");
        console2.log("fork_settle", g);
    }

    function test_gas_fork_refund_with_signature() public onlyFork {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        bytes32 channelId = _channelId(config);
        uint256 nonce = _nonce(13);
        uint256 deadline = block.timestamp + 3600;
        _depositViaPermit2(config, DEPOSIT_AMOUNT, nonce, deadline);

        bytes memory voucherSig = _signVoucher(channelId, CLAIM_AMOUNT);
        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](1);
        claims[0] = x402BatchSettlement.VoucherClaim({
            voucher: x402BatchSettlement.Voucher({channel: config, maxClaimableAmount: CLAIM_AMOUNT}),
            signature: voucherSig,
            totalClaimed: CLAIM_AMOUNT
        });

        vm.prank(receiverAuthAddr);
        settlement.claim(claims);

        uint128 refundAmt = DEPOSIT_AMOUNT - CLAIM_AMOUNT;
        bytes memory refundSig = _signRefund(channelId, 0, refundAmt);
        settlement.refundWithSignature(config, refundAmt, 0, refundSig);
        uint256 g = vm.snapshotGasLastCall("fork_refund_with_signature");
        console2.log("fork_refund_with_signature", g);
    }
}
