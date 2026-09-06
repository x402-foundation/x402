// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {x402BatchSettlement} from "../src/x402BatchSettlement.sol";
import {MockDepositCollector, MockShortCollector} from "./mocks/MockBatchDepositCollectors.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract X402BatchSettlementTest is Test {
    x402BatchSettlement public settlement;
    MockDepositCollector public mockCollector;
    MockShortCollector public shortCollector;
    MockERC20 public token;

    VmSafe.Wallet public payerWallet;
    VmSafe.Wallet public payerAuthWallet;
    VmSafe.Wallet public receiverWallet;
    VmSafe.Wallet public receiverAuthWallet;
    VmSafe.Wallet public otherWallet;

    uint40 constant WITHDRAW_DELAY = 3600; // 1 hour
    uint128 constant DEPOSIT_AMOUNT = 1000e6;
    uint128 constant CLAIM_AMOUNT = 100e6;

    event ChannelCreated(bytes32 indexed channelId, x402BatchSettlement.ChannelConfig config);
    event ChannelClosed(bytes32 indexed channelId, x402BatchSettlement.ChannelConfig config);
    event Deposited(bytes32 indexed channelId, address indexed sender, uint128 amount, uint128 newBalance);
    event Claimed(bytes32 indexed channelId, address indexed sender, uint128 claimAmount, uint128 newTotalClaimed);
    event Settled(address indexed receiver, address indexed token, address indexed sender, uint128 amount);
    event Refunded(bytes32 indexed channelId, address indexed sender, uint128 amount);
    event WithdrawInitiated(bytes32 indexed channelId, uint128 amount, uint40 finalizeAfter);
    event WithdrawFinalized(bytes32 indexed channelId, address indexed sender, uint128 amount);

    function setUp() public {
        vm.warp(1_000_000);

        payerWallet = vm.createWallet("payer");
        payerAuthWallet = vm.createWallet("payerAuth");
        receiverWallet = vm.createWallet("receiver");
        receiverAuthWallet = vm.createWallet("receiverAuth");
        otherWallet = vm.createWallet("other");

        settlement = new x402BatchSettlement();

        mockCollector = new MockDepositCollector();
        shortCollector = new MockShortCollector();

        token = new MockERC20("USDC", "USDC", 6);
        token.mint(payerWallet.addr, 100_000e6);

        vm.prank(payerWallet.addr);
        token.approve(address(mockCollector), type(uint256).max);
        vm.prank(payerWallet.addr);
        token.approve(address(shortCollector), type(uint256).max);
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    function _makeConfig() internal view returns (x402BatchSettlement.ChannelConfig memory) {
        return x402BatchSettlement.ChannelConfig({
            payer: payerWallet.addr,
            payerAuthorizer: payerAuthWallet.addr,
            receiver: receiverWallet.addr,
            receiverAuthorizer: receiverAuthWallet.addr,
            token: address(token),
            withdrawDelay: WITHDRAW_DELAY,
            salt: bytes32(0)
        });
    }

    function _makeStatefulConfig() internal view returns (x402BatchSettlement.ChannelConfig memory) {
        return x402BatchSettlement.ChannelConfig({
            payer: payerWallet.addr,
            payerAuthorizer: address(0),
            receiver: receiverWallet.addr,
            receiverAuthorizer: receiverAuthWallet.addr,
            token: address(token),
            withdrawDelay: WITHDRAW_DELAY,
            salt: bytes32(uint256(42))
        });
    }

    function _channelId(
        x402BatchSettlement.ChannelConfig memory config
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(settlement.CHANNEL_CONFIG_TYPEHASH(), config));
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
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

    function _signTypedData(VmSafe.Wallet memory wallet, bytes32 structHash) internal returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wallet, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signVoucher(
        VmSafe.Wallet memory wallet,
        bytes32 channelId,
        uint128 maxClaimableAmount
    ) internal returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(settlement.VOUCHER_TYPEHASH(), channelId, maxClaimableAmount));
        return _signTypedData(wallet, structHash);
    }

    function _signRefund(
        VmSafe.Wallet memory wallet,
        bytes32 channelId,
        uint256 nonce,
        uint128 amount
    ) internal returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(settlement.REFUND_TYPEHASH(), channelId, nonce, amount));
        return _signTypedData(wallet, structHash);
    }

    function _claimEntriesRootHashMemory(
        x402BatchSettlement.VoucherClaim[] memory claims
    ) internal view returns (bytes32) {
        uint256 n = claims.length;
        if (n == 0) {
            return keccak256("");
        }
        bytes32[] memory entryHashes = new bytes32[](n);
        for (uint256 i = 0; i < n; ++i) {
            bytes32 cid = settlement.getChannelId(claims[i].voucher.channel);
            entryHashes[i] = keccak256(
                abi.encode(
                    settlement.CLAIM_ENTRY_TYPEHASH(), cid, claims[i].voucher.maxClaimableAmount, claims[i].totalClaimed
                )
            );
        }
        return keccak256(abi.encodePacked(entryHashes));
    }

    function _claimBatchStructHashMemory(
        x402BatchSettlement.VoucherClaim[] memory claims
    ) internal view returns (bytes32) {
        return keccak256(abi.encode(settlement.CLAIM_BATCH_TYPEHASH(), _claimEntriesRootHashMemory(claims)));
    }

    function _signClaimBatch(
        VmSafe.Wallet memory wallet,
        x402BatchSettlement.VoucherClaim[] memory claims
    ) internal returns (bytes memory) {
        bytes32 structHash = _claimBatchStructHashMemory(claims);
        return _signTypedData(wallet, structHash);
    }

    function _deposit(x402BatchSettlement.ChannelConfig memory config, uint128 amount) internal {
        settlement.deposit(config, amount, address(mockCollector), "");
    }

    function _getChannel(
        bytes32 id
    ) internal view returns (x402BatchSettlement.ChannelState memory ch) {
        (ch.balance, ch.totalClaimed) = settlement.channels(id);
    }

    function _getPendingWithdrawal(
        bytes32 id
    ) internal view returns (x402BatchSettlement.WithdrawalState memory ws) {
        (ws.amount, ws.initiatedAt) = settlement.pendingWithdrawals(id);
    }

    function _getReceiver(
        address receiver,
        address tkn
    ) internal view returns (x402BatchSettlement.ReceiverState memory rs) {
        (rs.totalClaimed, rs.totalSettled) = settlement.receivers(receiver, tkn);
    }

    function _makeVoucherClaim(
        x402BatchSettlement.ChannelConfig memory config,
        uint128 maxClaimableAmount,
        uint128 claimAmount
    ) internal returns (x402BatchSettlement.VoucherClaim memory) {
        bytes32 channelId = _channelId(config);
        bytes memory sig = _signVoucher(payerAuthWallet, channelId, maxClaimableAmount);
        return x402BatchSettlement.VoucherClaim({
            voucher: x402BatchSettlement.Voucher({channel: config, maxClaimableAmount: maxClaimableAmount}),
            signature: sig,
            totalClaimed: claimAmount
        });
    }

    function _makeVoucherClaimWithSigner(
        x402BatchSettlement.ChannelConfig memory config,
        uint128 maxClaimableAmount,
        uint128 claimAmount,
        VmSafe.Wallet memory signer
    ) internal returns (x402BatchSettlement.VoucherClaim memory) {
        bytes32 channelId = _channelId(config);
        bytes memory sig = _signVoucher(signer, channelId, maxClaimableAmount);
        return x402BatchSettlement.VoucherClaim({
            voucher: x402BatchSettlement.Voucher({channel: config, maxClaimableAmount: maxClaimableAmount}),
            signature: sig,
            totalClaimed: claimAmount
        });
    }

    // =========================================================================
    // Constructor Tests
    // =========================================================================

    function test_constructor_deploysSuccessfully() public view {
        assertTrue(address(settlement) != address(0));
    }

    // =========================================================================
    // Deposit Tests
    // =========================================================================

    function test_deposit_success() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        bytes32 channelId = _channelId(config);

        vm.expectEmit(true, false, false, true);
        emit ChannelCreated(channelId, config);
        vm.expectEmit(true, true, false, true);
        emit Deposited(channelId, address(this), DEPOSIT_AMOUNT, DEPOSIT_AMOUNT);

        _deposit(config, DEPOSIT_AMOUNT);

        x402BatchSettlement.ChannelState memory ch = _getChannel(channelId);
        assertEq(ch.balance, DEPOSIT_AMOUNT);
        assertEq(ch.totalClaimed, 0);
    }

    function test_deposit_topUp() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        bytes32 channelId = _channelId(config);

        _deposit(config, DEPOSIT_AMOUNT);
        _deposit(config, DEPOSIT_AMOUNT);

        x402BatchSettlement.ChannelState memory ch = _getChannel(channelId);
        assertEq(ch.balance, DEPOSIT_AMOUNT * 2);
    }

    function test_deposit_revert_zeroAmount() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        vm.expectRevert(x402BatchSettlement.ZeroDeposit.selector);
        settlement.deposit(config, 0, address(mockCollector), "");
    }

    function test_deposit_revert_zeroCollector() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        vm.expectRevert(x402BatchSettlement.InvalidCollector.selector);
        settlement.deposit(config, DEPOSIT_AMOUNT, address(0), "");
    }

    function test_deposit_revert_collectionFailed() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        vm.expectRevert(x402BatchSettlement.DepositCollectionFailed.selector);
        settlement.deposit(config, DEPOSIT_AMOUNT, address(shortCollector), "");
    }

    function test_deposit_revert_withdrawDelayTooLow() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        config.withdrawDelay = 1;
        vm.expectRevert(x402BatchSettlement.WithdrawDelayOutOfRange.selector);
        settlement.deposit(config, DEPOSIT_AMOUNT, address(mockCollector), "");
    }

    function test_deposit_revert_withdrawDelayTooHigh() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        config.withdrawDelay = uint40(31 days);
        vm.expectRevert(x402BatchSettlement.WithdrawDelayOutOfRange.selector);
        settlement.deposit(config, DEPOSIT_AMOUNT, address(mockCollector), "");
    }

    function test_deposit_revert_zeroReceiver() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        config.receiver = address(0);
        vm.expectRevert(x402BatchSettlement.InvalidChannel.selector);
        settlement.deposit(config, DEPOSIT_AMOUNT, address(mockCollector), "");
    }

    function test_deposit_revert_zeroReceiverAuthorizer() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        config.receiverAuthorizer = address(0);
        vm.expectRevert(x402BatchSettlement.InvalidChannel.selector);
        settlement.deposit(config, DEPOSIT_AMOUNT, address(mockCollector), "");
    }

    function test_deposit_revert_zeroToken() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        config.token = address(0);
        vm.expectRevert(x402BatchSettlement.InvalidChannel.selector);
        settlement.deposit(config, DEPOSIT_AMOUNT, address(mockCollector), "");
    }

    function test_deposit_revert_zeroPayer() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        config.payer = address(0);
        vm.expectRevert(x402BatchSettlement.InvalidChannel.selector);
        settlement.deposit(config, DEPOSIT_AMOUNT, address(mockCollector), "");
    }

    function test_deposit_revert_overflow() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        token.mint(payerWallet.addr, type(uint128).max);
        _deposit(config, type(uint128).max);

        vm.expectRevert(x402BatchSettlement.DepositOverflow.selector);
        settlement.deposit(config, 1, address(mockCollector), "");
    }

    /// @dev Deposits increase `balance` only; cooperative refund (not deposit) clears a pending withdrawal.
    function test_deposit_doesNotCancelPendingWithdrawal() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        bytes32 channelId = _channelId(config);

        _deposit(config, DEPOSIT_AMOUNT);

        vm.prank(payerWallet.addr);
        settlement.initiateWithdraw(config, DEPOSIT_AMOUNT);

        x402BatchSettlement.WithdrawalState memory ws = _getPendingWithdrawal(channelId);
        uint40 initiatedBefore = ws.initiatedAt;
        assertGt(initiatedBefore, 0);

        _deposit(config, DEPOSIT_AMOUNT);

        ws = _getPendingWithdrawal(channelId);
        assertEq(ws.initiatedAt, initiatedBefore);
        assertEq(ws.amount, DEPOSIT_AMOUNT);

        x402BatchSettlement.ChannelState memory ch = _getChannel(channelId);
        assertEq(ch.balance, DEPOSIT_AMOUNT * 2);
    }

    // =========================================================================
    // Claim Tests (direct call)
    // =========================================================================

    function test_claim_single() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        bytes32 channelId = _channelId(config);

        _deposit(config, DEPOSIT_AMOUNT);

        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](1);
        claims[0] = _makeVoucherClaim(config, CLAIM_AMOUNT, CLAIM_AMOUNT);

        vm.expectEmit(true, true, false, true);
        emit Claimed(channelId, receiverAuthWallet.addr, CLAIM_AMOUNT, CLAIM_AMOUNT);

        vm.prank(receiverAuthWallet.addr);
        settlement.claim(claims);

        x402BatchSettlement.ChannelState memory ch = _getChannel(channelId);
        assertEq(ch.totalClaimed, CLAIM_AMOUNT);

        x402BatchSettlement.ReceiverState memory rs = _getReceiver(receiverWallet.addr, address(token));
        assertEq(rs.totalClaimed, CLAIM_AMOUNT);
    }

    function test_claim_batch() public {
        x402BatchSettlement.ChannelConfig memory config1 = _makeConfig();
        x402BatchSettlement.ChannelConfig memory config2 = _makeConfig();
        config2.salt = bytes32(uint256(1));

        _deposit(config1, DEPOSIT_AMOUNT);
        _deposit(config2, DEPOSIT_AMOUNT);

        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](2);
        claims[0] = _makeVoucherClaim(config1, CLAIM_AMOUNT, CLAIM_AMOUNT);
        claims[1] = _makeVoucherClaim(config2, CLAIM_AMOUNT * 2, CLAIM_AMOUNT * 2);

        vm.prank(receiverAuthWallet.addr);
        settlement.claim(claims);

        x402BatchSettlement.ReceiverState memory rs = _getReceiver(receiverWallet.addr, address(token));
        assertEq(rs.totalClaimed, CLAIM_AMOUNT * 3);
    }

    function test_claim_cumulative() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();

        _deposit(config, DEPOSIT_AMOUNT);

        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](1);
        claims[0] = _makeVoucherClaim(config, 200e6, 100e6);

        vm.prank(receiverAuthWallet.addr);
        settlement.claim(claims);

        claims[0] = _makeVoucherClaim(config, 200e6, 200e6);

        vm.prank(receiverAuthWallet.addr);
        settlement.claim(claims);

        bytes32 channelId = _channelId(config);
        x402BatchSettlement.ChannelState memory ch = _getChannel(channelId);
        assertEq(ch.totalClaimed, 200e6);
    }

    function test_claim_revert_notAuthorized() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        _deposit(config, DEPOSIT_AMOUNT);

        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](1);
        claims[0] = _makeVoucherClaim(config, CLAIM_AMOUNT, CLAIM_AMOUNT);

        vm.prank(otherWallet.addr);
        vm.expectRevert(x402BatchSettlement.NotAuthorizedToClaim.selector);
        settlement.claim(claims);
    }

    function test_claim_success_asReceiver() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        bytes32 channelId = _channelId(config);
        _deposit(config, DEPOSIT_AMOUNT);

        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](1);
        claims[0] = _makeVoucherClaim(config, CLAIM_AMOUNT, CLAIM_AMOUNT);

        vm.expectEmit(true, true, false, true);
        emit Claimed(channelId, receiverWallet.addr, CLAIM_AMOUNT, CLAIM_AMOUNT);

        vm.prank(receiverWallet.addr);
        settlement.claim(claims);

        x402BatchSettlement.ChannelState memory ch = _getChannel(channelId);
        assertEq(ch.totalClaimed, CLAIM_AMOUNT);
    }

    function test_claim_revert_exceedsCeiling() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        _deposit(config, DEPOSIT_AMOUNT);

        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](1);
        claims[0] = _makeVoucherClaim(config, CLAIM_AMOUNT, CLAIM_AMOUNT + 1);

        vm.prank(receiverAuthWallet.addr);
        vm.expectRevert(x402BatchSettlement.ClaimExceedsCeiling.selector);
        settlement.claim(claims);
    }

    function test_claim_revert_exceedsBalance() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        _deposit(config, CLAIM_AMOUNT / 2);

        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](1);
        claims[0] = _makeVoucherClaim(config, CLAIM_AMOUNT, CLAIM_AMOUNT);

        vm.prank(receiverAuthWallet.addr);
        vm.expectRevert(x402BatchSettlement.ClaimExceedsBalance.selector);
        settlement.claim(claims);
    }

    function test_claim_revert_wrongSigner() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        _deposit(config, DEPOSIT_AMOUNT);

        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](1);
        claims[0] = _makeVoucherClaimWithSigner(config, CLAIM_AMOUNT, CLAIM_AMOUNT, otherWallet);

        vm.prank(receiverAuthWallet.addr);
        vm.expectRevert(x402BatchSettlement.InvalidSignature.selector);
        settlement.claim(claims);
    }

    function test_claim_revert_malformedSignature() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        _deposit(config, DEPOSIT_AMOUNT);

        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](1);
        claims[0] = x402BatchSettlement.VoucherClaim({
            voucher: x402BatchSettlement.Voucher({channel: config, maxClaimableAmount: CLAIM_AMOUNT}),
            signature: hex"0000",
            totalClaimed: CLAIM_AMOUNT
        });

        vm.prank(receiverAuthWallet.addr);
        vm.expectRevert();
        settlement.claim(claims);
    }

    // =========================================================================
    // Claim Tests — Stateful (payerAuthorizer == address(0), EIP-1271 path)
    // =========================================================================

    function test_claim_statefulMode_payerSigns() public {
        x402BatchSettlement.ChannelConfig memory config = _makeStatefulConfig();
        _deposit(config, DEPOSIT_AMOUNT);

        bytes32 channelId = _channelId(config);
        bytes memory sig = _signVoucher(payerWallet, channelId, CLAIM_AMOUNT);

        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](1);
        claims[0] = x402BatchSettlement.VoucherClaim({
            voucher: x402BatchSettlement.Voucher({channel: config, maxClaimableAmount: CLAIM_AMOUNT}),
            signature: sig,
            totalClaimed: CLAIM_AMOUNT
        });

        vm.prank(receiverAuthWallet.addr);
        settlement.claim(claims);

        x402BatchSettlement.ChannelState memory ch = _getChannel(channelId);
        assertEq(ch.totalClaimed, CLAIM_AMOUNT);
    }

    function test_claim_statefulMode_revert_wrongSigner() public {
        x402BatchSettlement.ChannelConfig memory config = _makeStatefulConfig();
        _deposit(config, DEPOSIT_AMOUNT);

        bytes32 channelId = _channelId(config);
        bytes memory sig = _signVoucher(otherWallet, channelId, CLAIM_AMOUNT);

        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](1);
        claims[0] = x402BatchSettlement.VoucherClaim({
            voucher: x402BatchSettlement.Voucher({channel: config, maxClaimableAmount: CLAIM_AMOUNT}),
            signature: sig,
            totalClaimed: CLAIM_AMOUNT
        });

        vm.prank(receiverAuthWallet.addr);
        vm.expectRevert(x402BatchSettlement.InvalidSignature.selector);
        settlement.claim(claims);
    }

    // =========================================================================
    // claimWithSignature Tests
    // =========================================================================

    function test_claimWithSignature_success() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        bytes32 channelId = _channelId(config);
        _deposit(config, DEPOSIT_AMOUNT);

        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](1);
        claims[0] = _makeVoucherClaim(config, CLAIM_AMOUNT, CLAIM_AMOUNT);

        bytes memory authSig = _signClaimBatch(receiverAuthWallet, claims);

        vm.prank(otherWallet.addr);
        settlement.claimWithSignature(claims, authSig);

        x402BatchSettlement.ChannelState memory ch = _getChannel(channelId);
        assertEq(ch.totalClaimed, CLAIM_AMOUNT);
    }

    function test_claimWithSignature_revert_emptyClaims() public {
        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](0);
        bytes memory sig = hex"dead";

        vm.expectRevert(x402BatchSettlement.EmptyBatch.selector);
        settlement.claimWithSignature(claims, sig);
    }

    function test_claim_revert_emptyBatch() public {
        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](0);

        vm.prank(receiverAuthWallet.addr);
        vm.expectRevert(x402BatchSettlement.EmptyBatch.selector);
        settlement.claim(claims);
    }

    function test_claimWithSignature_revert_wrongAuthorizerSignature() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        _deposit(config, DEPOSIT_AMOUNT);

        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](1);
        claims[0] = _makeVoucherClaim(config, CLAIM_AMOUNT, CLAIM_AMOUNT);

        bytes memory badSig = _signClaimBatch(otherWallet, claims);

        vm.expectRevert(x402BatchSettlement.InvalidSignature.selector);
        settlement.claimWithSignature(claims, badSig);
    }

    function test_claimWithSignature_revert_mixedReceiverAuthorizers() public {
        x402BatchSettlement.ChannelConfig memory config1 = _makeConfig();
        x402BatchSettlement.ChannelConfig memory config2 = _makeConfig();
        config2.receiverAuthorizer = otherWallet.addr;
        config2.salt = bytes32(uint256(2));

        _deposit(config1, DEPOSIT_AMOUNT);
        _deposit(config2, DEPOSIT_AMOUNT);

        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](2);
        claims[0] = _makeVoucherClaim(config1, CLAIM_AMOUNT, CLAIM_AMOUNT);
        claims[1] = _makeVoucherClaim(config2, CLAIM_AMOUNT, CLAIM_AMOUNT);

        bytes memory authSig = _signClaimBatch(receiverAuthWallet, claims);

        vm.expectRevert(x402BatchSettlement.NotReceiverAuthorizer.selector);
        settlement.claimWithSignature(claims, authSig);
    }

    // =========================================================================
    // Settle Tests
    // =========================================================================

    function test_settle_success() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();

        _deposit(config, DEPOSIT_AMOUNT);

        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](1);
        claims[0] = _makeVoucherClaim(config, CLAIM_AMOUNT, CLAIM_AMOUNT);
        vm.prank(receiverAuthWallet.addr);
        settlement.claim(claims);

        uint256 balBefore = token.balanceOf(receiverWallet.addr);

        vm.expectEmit(true, true, true, true);
        emit Settled(receiverWallet.addr, address(token), address(this), CLAIM_AMOUNT);
        settlement.settle(receiverWallet.addr, address(token));

        assertEq(token.balanceOf(receiverWallet.addr), balBefore + CLAIM_AMOUNT);

        x402BatchSettlement.ReceiverState memory rs = _getReceiver(receiverWallet.addr, address(token));
        assertEq(rs.totalSettled, CLAIM_AMOUNT);
    }

    function test_settle_sweepsAcrossChannels() public {
        x402BatchSettlement.ChannelConfig memory config1 = _makeConfig();
        x402BatchSettlement.ChannelConfig memory config2 = _makeConfig();
        config2.salt = bytes32(uint256(1));

        _deposit(config1, DEPOSIT_AMOUNT);
        _deposit(config2, DEPOSIT_AMOUNT);

        x402BatchSettlement.VoucherClaim[] memory v1 = new x402BatchSettlement.VoucherClaim[](1);
        v1[0] = _makeVoucherClaim(config1, CLAIM_AMOUNT, CLAIM_AMOUNT);
        vm.prank(receiverAuthWallet.addr);
        settlement.claim(v1);

        x402BatchSettlement.VoucherClaim[] memory v2 = new x402BatchSettlement.VoucherClaim[](1);
        v2[0] = _makeVoucherClaim(config2, CLAIM_AMOUNT * 2, CLAIM_AMOUNT * 2);
        vm.prank(receiverAuthWallet.addr);
        settlement.claim(v2);

        uint256 balBefore = token.balanceOf(receiverWallet.addr);
        settlement.settle(receiverWallet.addr, address(token));
        assertEq(token.balanceOf(receiverWallet.addr), balBefore + CLAIM_AMOUNT * 3);
    }

    function test_settle_idempotent_nothingToSettle() public {
        uint256 balBefore = token.balanceOf(receiverWallet.addr);
        settlement.settle(receiverWallet.addr, address(token));
        assertEq(token.balanceOf(receiverWallet.addr), balBefore);
    }

    // =========================================================================
    // Timed Withdrawal Tests
    // =========================================================================

    function test_initiateWithdraw_success() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        bytes32 channelId = _channelId(config);
        _deposit(config, DEPOSIT_AMOUNT);

        vm.prank(payerWallet.addr);
        vm.expectEmit(true, false, false, true);
        emit WithdrawInitiated(channelId, DEPOSIT_AMOUNT, uint40(block.timestamp) + WITHDRAW_DELAY);
        settlement.initiateWithdraw(config, DEPOSIT_AMOUNT);

        x402BatchSettlement.WithdrawalState memory ws = _getPendingWithdrawal(channelId);
        assertEq(ws.amount, DEPOSIT_AMOUNT);
        assertEq(ws.initiatedAt, uint40(block.timestamp));
    }

    function test_initiateWithdraw_success_asPayerAuthorizer() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        bytes32 channelId = _channelId(config);
        _deposit(config, DEPOSIT_AMOUNT);

        vm.prank(payerAuthWallet.addr);
        vm.expectEmit(true, false, false, true);
        emit WithdrawInitiated(channelId, DEPOSIT_AMOUNT, uint40(block.timestamp) + WITHDRAW_DELAY);
        settlement.initiateWithdraw(config, DEPOSIT_AMOUNT);

        x402BatchSettlement.WithdrawalState memory ws = _getPendingWithdrawal(channelId);
        assertEq(ws.amount, DEPOSIT_AMOUNT);
    }

    function test_initiateWithdraw_revert_notPayerOrPayerAuthorizer() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        _deposit(config, DEPOSIT_AMOUNT);

        vm.prank(otherWallet.addr);
        vm.expectRevert(x402BatchSettlement.InvalidChannel.selector);
        settlement.initiateWithdraw(config, DEPOSIT_AMOUNT);
    }

    function test_initiateWithdraw_revert_zeroAmount() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        _deposit(config, DEPOSIT_AMOUNT);
        vm.prank(payerWallet.addr);
        vm.expectRevert(x402BatchSettlement.NothingToWithdraw.selector);
        settlement.initiateWithdraw(config, 0);
    }

    function test_initiateWithdraw_revert_alreadyPending() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        _deposit(config, DEPOSIT_AMOUNT);

        vm.prank(payerWallet.addr);
        settlement.initiateWithdraw(config, DEPOSIT_AMOUNT);

        vm.prank(payerWallet.addr);
        vm.expectRevert(x402BatchSettlement.WithdrawalAlreadyPending.selector);
        settlement.initiateWithdraw(config, DEPOSIT_AMOUNT);
    }

    function test_initiateWithdraw_revert_amountExceedsAvailable_noChannel() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();

        vm.prank(payerWallet.addr);
        vm.expectRevert(x402BatchSettlement.WithdrawAmountExceedsAvailable.selector);
        settlement.initiateWithdraw(config, 1);
    }

    function test_initiateWithdraw_revert_amountExceedsAvailable_afterClaim() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        bytes32 channelId = _channelId(config);
        _deposit(config, DEPOSIT_AMOUNT);

        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](1);
        claims[0] = _makeVoucherClaim(config, CLAIM_AMOUNT, CLAIM_AMOUNT);
        vm.prank(receiverAuthWallet.addr);
        settlement.claim(claims);

        uint128 available = DEPOSIT_AMOUNT - CLAIM_AMOUNT;

        vm.prank(payerWallet.addr);
        vm.expectRevert(x402BatchSettlement.WithdrawAmountExceedsAvailable.selector);
        settlement.initiateWithdraw(config, available + 1);

        vm.prank(payerWallet.addr);
        settlement.initiateWithdraw(config, available);

        x402BatchSettlement.WithdrawalState memory ws = _getPendingWithdrawal(channelId);
        assertEq(ws.amount, available);
    }

    function test_initiateWithdraw_attackBypass_blocked() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();

        vm.prank(payerWallet.addr);
        vm.expectRevert(x402BatchSettlement.WithdrawAmountExceedsAvailable.selector);
        settlement.initiateWithdraw(config, type(uint128).max);

        vm.warp(block.timestamp + WITHDRAW_DELAY + 1);

        _deposit(config, DEPOSIT_AMOUNT);

        vm.prank(payerWallet.addr);
        vm.expectRevert(x402BatchSettlement.WithdrawalNotPending.selector);
        settlement.finalizeWithdraw(config);
    }

    function test_finalizeWithdraw_success() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        bytes32 channelId = _channelId(config);
        _deposit(config, DEPOSIT_AMOUNT);

        vm.prank(payerWallet.addr);
        settlement.initiateWithdraw(config, DEPOSIT_AMOUNT);

        vm.warp(block.timestamp + WITHDRAW_DELAY + 1);

        uint256 balBefore = token.balanceOf(payerWallet.addr);

        vm.expectEmit(true, true, false, true);
        emit WithdrawFinalized(channelId, payerWallet.addr, DEPOSIT_AMOUNT);
        vm.expectEmit(true, false, false, true);
        emit ChannelClosed(channelId, config);

        vm.prank(payerWallet.addr);
        settlement.finalizeWithdraw(config);

        assertEq(token.balanceOf(payerWallet.addr), balBefore + DEPOSIT_AMOUNT);
    }

    function test_finalizeWithdraw_revert_notPayerOrPayerAuthorizer() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        _deposit(config, DEPOSIT_AMOUNT);

        vm.prank(payerWallet.addr);
        settlement.initiateWithdraw(config, DEPOSIT_AMOUNT);

        vm.warp(block.timestamp + WITHDRAW_DELAY + 1);

        vm.prank(otherWallet.addr);
        vm.expectRevert(x402BatchSettlement.NotAuthorizedToFinalizeWithdraw.selector);
        settlement.finalizeWithdraw(config);
    }

    function test_finalizeWithdraw_revert_notPending() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        vm.prank(payerWallet.addr);
        vm.expectRevert(x402BatchSettlement.WithdrawalNotPending.selector);
        settlement.finalizeWithdraw(config);
    }

    function test_finalizeWithdraw_revert_delayNotElapsed() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        _deposit(config, DEPOSIT_AMOUNT);

        vm.prank(payerWallet.addr);
        settlement.initiateWithdraw(config, DEPOSIT_AMOUNT);

        vm.prank(payerWallet.addr);
        vm.expectRevert(x402BatchSettlement.WithdrawDelayNotElapsed.selector);
        settlement.finalizeWithdraw(config);
    }

    function test_finalizeWithdraw_zeroAmount_afterFullClaim() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        _deposit(config, DEPOSIT_AMOUNT);

        vm.prank(payerWallet.addr);
        settlement.initiateWithdraw(config, DEPOSIT_AMOUNT);

        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](1);
        claims[0] = _makeVoucherClaim(config, DEPOSIT_AMOUNT, DEPOSIT_AMOUNT);
        vm.prank(receiverAuthWallet.addr);
        settlement.claim(claims);

        vm.warp(block.timestamp + WITHDRAW_DELAY + 1);
        uint256 balBefore = token.balanceOf(payerWallet.addr);
        vm.prank(payerWallet.addr);
        settlement.finalizeWithdraw(config);

        assertEq(token.balanceOf(payerWallet.addr), balBefore);
    }

    function test_finalizeWithdraw_capsIfClaimedDuringDelay() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        bytes32 channelId = _channelId(config);
        _deposit(config, DEPOSIT_AMOUNT);

        vm.prank(payerWallet.addr);
        settlement.initiateWithdraw(config, DEPOSIT_AMOUNT);

        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](1);
        claims[0] = _makeVoucherClaim(config, 500e6, 500e6);
        vm.prank(receiverAuthWallet.addr);
        settlement.claim(claims);

        vm.warp(block.timestamp + WITHDRAW_DELAY + 1);
        vm.prank(payerWallet.addr);
        settlement.finalizeWithdraw(config);

        x402BatchSettlement.ChannelState memory ch = _getChannel(channelId);
        assertEq(ch.balance, 500e6);
    }

    // =========================================================================
    // Cooperative Withdrawal Tests
    // =========================================================================

    function test_refund_directCall() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        bytes32 channelId = _channelId(config);
        _deposit(config, DEPOSIT_AMOUNT);

        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](1);
        claims[0] = _makeVoucherClaim(config, CLAIM_AMOUNT, CLAIM_AMOUNT);
        vm.prank(receiverAuthWallet.addr);
        settlement.claim(claims);

        uint256 balBefore = token.balanceOf(payerWallet.addr);

        vm.expectEmit(true, true, false, true);
        emit Refunded(channelId, receiverAuthWallet.addr, DEPOSIT_AMOUNT - CLAIM_AMOUNT);

        vm.prank(receiverAuthWallet.addr);
        settlement.refund(config, DEPOSIT_AMOUNT - CLAIM_AMOUNT);

        assertEq(token.balanceOf(payerWallet.addr), balBefore + DEPOSIT_AMOUNT - CLAIM_AMOUNT);

        x402BatchSettlement.ChannelState memory ch = _getChannel(channelId);
        assertEq(ch.balance, ch.totalClaimed);
    }

    function test_refund_revert_notAuthorized() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        _deposit(config, DEPOSIT_AMOUNT);

        vm.prank(otherWallet.addr);
        vm.expectRevert(x402BatchSettlement.NotAuthorizedToRefund.selector);
        settlement.refund(config, 1);
    }

    function test_refund_directCall_asReceiver() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        bytes32 channelId = _channelId(config);
        _deposit(config, DEPOSIT_AMOUNT);

        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](1);
        claims[0] = _makeVoucherClaim(config, CLAIM_AMOUNT, CLAIM_AMOUNT);
        vm.prank(receiverAuthWallet.addr);
        settlement.claim(claims);

        uint256 balBefore = token.balanceOf(payerWallet.addr);
        uint128 refundAmt = DEPOSIT_AMOUNT - CLAIM_AMOUNT;

        vm.expectEmit(true, true, false, true);
        emit Refunded(channelId, receiverWallet.addr, refundAmt);

        vm.prank(receiverWallet.addr);
        settlement.refund(config, refundAmt);

        assertEq(token.balanceOf(payerWallet.addr), balBefore + refundAmt);
    }

    function test_refundWithSignature_success() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        bytes32 channelId = _channelId(config);
        _deposit(config, DEPOSIT_AMOUNT);

        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](1);
        claims[0] = _makeVoucherClaim(config, CLAIM_AMOUNT, CLAIM_AMOUNT);
        vm.prank(receiverAuthWallet.addr);
        settlement.claim(claims);

        uint128 refundAmt = DEPOSIT_AMOUNT - CLAIM_AMOUNT;
        bytes memory sig = _signRefund(receiverAuthWallet, channelId, 0, refundAmt);
        uint256 balBefore = token.balanceOf(payerWallet.addr);

        vm.prank(otherWallet.addr);
        settlement.refundWithSignature(config, refundAmt, 0, sig);

        assertEq(token.balanceOf(payerWallet.addr), balBefore + refundAmt);
    }

    function test_refundWithSignature_clearsPendingWithdrawal_whenRefundCoversIt() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        bytes32 channelId = _channelId(config);
        _deposit(config, DEPOSIT_AMOUNT);

        vm.prank(payerWallet.addr);
        settlement.initiateWithdraw(config, DEPOSIT_AMOUNT);

        bytes memory sig = _signRefund(receiverAuthWallet, channelId, 0, DEPOSIT_AMOUNT);
        settlement.refundWithSignature(config, DEPOSIT_AMOUNT, 0, sig);

        x402BatchSettlement.WithdrawalState memory ws = _getPendingWithdrawal(channelId);
        assertEq(ws.initiatedAt, 0);
        assertEq(ws.amount, 0);
    }

    function test_refund_partialDoesNotClearPendingWithdrawal() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        bytes32 channelId = _channelId(config);
        _deposit(config, DEPOSIT_AMOUNT);

        vm.prank(payerWallet.addr);
        settlement.initiateWithdraw(config, DEPOSIT_AMOUNT);

        uint40 initiatedBefore = _getPendingWithdrawal(channelId).initiatedAt;
        assertGt(initiatedBefore, 0);

        vm.prank(receiverAuthWallet.addr);
        settlement.refund(config, 1);

        x402BatchSettlement.WithdrawalState memory ws = _getPendingWithdrawal(channelId);
        assertEq(ws.initiatedAt, initiatedBefore);
        assertEq(ws.amount, DEPOSIT_AMOUNT - 1);
    }

    function test_refund_griefAttempt_finalizeStillSucceedsAfterDelay() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        bytes32 channelId = _channelId(config);
        _deposit(config, DEPOSIT_AMOUNT);

        vm.prank(payerWallet.addr);
        settlement.initiateWithdraw(config, DEPOSIT_AMOUNT);

        uint256 payerBalBefore = token.balanceOf(payerWallet.addr);

        vm.prank(receiverAuthWallet.addr);
        settlement.refund(config, 1);

        vm.warp(block.timestamp + WITHDRAW_DELAY);

        vm.prank(payerWallet.addr);
        settlement.finalizeWithdraw(config);

        assertEq(token.balanceOf(payerWallet.addr), payerBalBefore + DEPOSIT_AMOUNT);

        x402BatchSettlement.WithdrawalState memory ws = _getPendingWithdrawal(channelId);
        assertEq(ws.initiatedAt, 0);
        assertEq(ws.amount, 0);
    }

    function test_refund_largerThanPending_clearsWithdrawal() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        bytes32 channelId = _channelId(config);
        _deposit(config, DEPOSIT_AMOUNT);

        uint128 partialWithdraw = DEPOSIT_AMOUNT / 4;
        vm.prank(payerWallet.addr);
        settlement.initiateWithdraw(config, partialWithdraw);

        vm.prank(receiverAuthWallet.addr);
        settlement.refund(config, DEPOSIT_AMOUNT);

        x402BatchSettlement.WithdrawalState memory ws = _getPendingWithdrawal(channelId);
        assertEq(ws.initiatedAt, 0);
        assertEq(ws.amount, 0);
    }

    function test_refundWithSignature_noop_whenNothingAvailable_afterFullClaim() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        bytes32 channelId = _channelId(config);
        _deposit(config, DEPOSIT_AMOUNT);

        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](1);
        claims[0] = _makeVoucherClaim(config, DEPOSIT_AMOUNT, DEPOSIT_AMOUNT);
        vm.prank(receiverAuthWallet.addr);
        settlement.claim(claims);

        bytes memory sig = _signRefund(receiverAuthWallet, channelId, 0, 1);
        uint256 nonceBefore = settlement.refundNonce(channelId);
        uint256 payerBal = token.balanceOf(payerWallet.addr);

        settlement.refundWithSignature(config, 1, 0, sig);

        assertEq(settlement.refundNonce(channelId), nonceBefore + 1);
        assertEq(token.balanceOf(payerWallet.addr), payerBal);
    }

    function test_refundWithSignature_replay_blockedAfterNoopThenDeposit() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        bytes32 channelId = _channelId(config);
        _deposit(config, DEPOSIT_AMOUNT);

        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](1);
        claims[0] = _makeVoucherClaim(config, DEPOSIT_AMOUNT, DEPOSIT_AMOUNT);
        vm.prank(receiverAuthWallet.addr);
        settlement.claim(claims);

        bytes memory sig = _signRefund(receiverAuthWallet, channelId, 0, DEPOSIT_AMOUNT);
        settlement.refundWithSignature(config, DEPOSIT_AMOUNT, 0, sig);

        _deposit(config, DEPOSIT_AMOUNT);

        vm.expectRevert(x402BatchSettlement.InvalidRefundNonce.selector);
        settlement.refundWithSignature(config, DEPOSIT_AMOUNT, 0, sig);
    }

    function test_refund_directCall_bumpsNonce_evenOnNoop() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        bytes32 channelId = _channelId(config);
        _deposit(config, DEPOSIT_AMOUNT);

        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](1);
        claims[0] = _makeVoucherClaim(config, DEPOSIT_AMOUNT, DEPOSIT_AMOUNT);
        vm.prank(receiverAuthWallet.addr);
        settlement.claim(claims);

        uint256 nonceBefore = settlement.refundNonce(channelId);

        vm.prank(receiverAuthWallet.addr);
        settlement.refund(config, 1);

        assertEq(settlement.refundNonce(channelId), nonceBefore + 1);
    }

    function test_refund_capsToAvailable() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        bytes32 channelId = _channelId(config);
        _deposit(config, DEPOSIT_AMOUNT);

        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](1);
        claims[0] = _makeVoucherClaim(config, CLAIM_AMOUNT, CLAIM_AMOUNT);
        vm.prank(receiverAuthWallet.addr);
        settlement.claim(claims);

        uint128 available = DEPOSIT_AMOUNT - CLAIM_AMOUNT;
        uint256 balBefore = token.balanceOf(payerWallet.addr);

        vm.expectEmit(true, true, false, true);
        emit Refunded(channelId, receiverAuthWallet.addr, available);

        vm.prank(receiverAuthWallet.addr);
        settlement.refund(config, type(uint128).max);

        assertEq(token.balanceOf(payerWallet.addr), balBefore + available);
        x402BatchSettlement.ChannelState memory ch = _getChannel(channelId);
        assertEq(ch.balance, ch.totalClaimed);
    }

    function test_refundWithSignature_revert_wrongSignature() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        bytes32 channelId = _channelId(config);
        _deposit(config, DEPOSIT_AMOUNT);

        bytes memory badSig = _signRefund(otherWallet, channelId, 0, DEPOSIT_AMOUNT);
        vm.expectRevert(x402BatchSettlement.InvalidSignature.selector);
        settlement.refundWithSignature(config, DEPOSIT_AMOUNT, 0, badSig);
    }

    // =========================================================================
    // View Function Tests
    // =========================================================================

    function test_getChannelId_deterministic() public view {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        bytes32 id1 = settlement.getChannelId(config);
        bytes32 id2 = settlement.getChannelId(config);
        assertEq(id1, id2);
        assertEq(id1, _channelId(config));
    }

    function test_differentSalt_differentChannelId() public view {
        x402BatchSettlement.ChannelConfig memory config1 = _makeConfig();
        x402BatchSettlement.ChannelConfig memory config2 = _makeConfig();
        config2.salt = bytes32(uint256(1));

        assertNotEq(settlement.getChannelId(config1), settlement.getChannelId(config2));
    }

    function test_getVoucherDigest_matches() public view {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        bytes32 channelId = _channelId(config);

        bytes32 expected = keccak256(
            abi.encodePacked(
                "\x19\x01",
                _domainSeparator(),
                keccak256(abi.encode(settlement.VOUCHER_TYPEHASH(), channelId, uint128(100)))
            )
        );
        assertEq(settlement.getVoucherDigest(channelId, 100), expected);
    }

    function test_getRefundDigest_matches() public view {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        bytes32 channelId = _channelId(config);

        uint256 nonce = 7;
        uint128 amount = 999e6;
        bytes32 expected = keccak256(
            abi.encodePacked(
                "\x19\x01",
                _domainSeparator(),
                keccak256(abi.encode(settlement.REFUND_TYPEHASH(), channelId, nonce, amount))
            )
        );
        assertEq(settlement.getRefundDigest(channelId, nonce, amount), expected);
    }

    function test_getClaimBatchDigest_matches() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        _deposit(config, DEPOSIT_AMOUNT);

        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](1);
        claims[0] = _makeVoucherClaim(config, CLAIM_AMOUNT, CLAIM_AMOUNT);

        bytes32 digest = settlement.getClaimBatchDigest(claims);
        assertTrue(digest != bytes32(0));
    }

    function test_getClaimBatchDigest_emptyClaims_matches() public view {
        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](0);
        bytes32 expected = keccak256(
            abi.encodePacked(
                "\x19\x01", _domainSeparator(), keccak256(abi.encode(settlement.CLAIM_BATCH_TYPEHASH(), keccak256("")))
            )
        );
        assertEq(settlement.getClaimBatchDigest(claims), expected);
    }

    function test_refundWithSignature_revert_invalidNonce() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        bytes32 channelId = _channelId(config);
        _deposit(config, DEPOSIT_AMOUNT);

        uint128 refundAmt = 50e6;
        bytes memory sig = _signRefund(receiverAuthWallet, channelId, 1, refundAmt);

        vm.expectRevert(x402BatchSettlement.InvalidRefundNonce.selector);
        settlement.refundWithSignature(config, refundAmt, 1, sig);
    }

    function test_refundWithSignature_revert_zeroRefund() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        bytes32 channelId = _channelId(config);
        _deposit(config, DEPOSIT_AMOUNT);

        bytes memory sig = _signRefund(receiverAuthWallet, channelId, 0, 0);

        vm.expectRevert(x402BatchSettlement.ZeroRefund.selector);
        settlement.refundWithSignature(config, 0, 0, sig);
    }

    // =========================================================================
    // Edge Case Tests
    // =========================================================================

    function test_redeposit_afterFullWithdraw() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        bytes32 channelId = _channelId(config);

        _deposit(config, DEPOSIT_AMOUNT);

        vm.expectEmit(true, true, false, true);
        emit Refunded(channelId, receiverAuthWallet.addr, DEPOSIT_AMOUNT);
        vm.expectEmit(true, false, false, true);
        emit ChannelClosed(channelId, config);
        vm.prank(receiverAuthWallet.addr);
        settlement.refund(config, DEPOSIT_AMOUNT);

        vm.expectEmit(true, false, false, true);
        emit ChannelCreated(channelId, config);
        vm.expectEmit(true, true, false, true);
        emit Deposited(channelId, address(this), DEPOSIT_AMOUNT, DEPOSIT_AMOUNT);
        _deposit(config, DEPOSIT_AMOUNT);

        x402BatchSettlement.ChannelState memory ch = _getChannel(channelId);
        assertEq(ch.balance, DEPOSIT_AMOUNT);
    }

    function test_channelClosed_onFullRefund_noClaims() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();
        bytes32 channelId = _channelId(config);
        _deposit(config, DEPOSIT_AMOUNT);

        vm.expectEmit(true, true, false, true);
        emit Refunded(channelId, receiverAuthWallet.addr, DEPOSIT_AMOUNT);
        vm.expectEmit(true, false, false, true);
        emit ChannelClosed(channelId, config);
        vm.prank(receiverAuthWallet.addr);
        settlement.refund(config, DEPOSIT_AMOUNT);
    }

    function test_crossChannel_isolation() public {
        x402BatchSettlement.ChannelConfig memory config1 = _makeConfig();
        x402BatchSettlement.ChannelConfig memory config2 = _makeConfig();
        config2.salt = bytes32(uint256(99));

        _deposit(config1, DEPOSIT_AMOUNT);
        _deposit(config2, DEPOSIT_AMOUNT / 2);

        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](1);
        claims[0] = _makeVoucherClaim(config1, CLAIM_AMOUNT, CLAIM_AMOUNT);
        vm.prank(receiverAuthWallet.addr);
        settlement.claim(claims);

        bytes32 channelId2 = _channelId(config2);
        x402BatchSettlement.ChannelState memory ch2 = _getChannel(channelId2);
        assertEq(ch2.totalClaimed, 0);
    }

    function test_payerAuthorizer_zeroAllowed_inConfig() public view {
        x402BatchSettlement.ChannelConfig memory config = _makeStatefulConfig();
        assertEq(config.payerAuthorizer, address(0));
        bytes32 id = settlement.getChannelId(config);
        assertTrue(id != bytes32(0));
    }

    // =========================================================================
    // Multicall Tests
    // =========================================================================

    function test_multicall_migration_refundAndDeposit() public {
        x402BatchSettlement.ChannelConfig memory oldConfig = _makeConfig();
        bytes32 oldChannelId = _channelId(oldConfig);
        _deposit(oldConfig, DEPOSIT_AMOUNT);

        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](1);
        claims[0] = _makeVoucherClaim(oldConfig, CLAIM_AMOUNT, CLAIM_AMOUNT);
        vm.prank(receiverAuthWallet.addr);
        settlement.claim(claims);

        x402BatchSettlement.ChannelConfig memory newConfig = _makeConfig();
        newConfig.salt = bytes32(uint256(77));
        bytes32 newChannelId = _channelId(newConfig);

        uint128 refundAmt = DEPOSIT_AMOUNT - CLAIM_AMOUNT;
        bytes memory refundSig = _signRefund(receiverAuthWallet, oldChannelId, 0, refundAmt);

        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(settlement.refundWithSignature, (oldConfig, refundAmt, uint256(0), refundSig));
        calls[1] =
            abi.encodeCall(settlement.deposit, (newConfig, DEPOSIT_AMOUNT - CLAIM_AMOUNT, address(mockCollector), ""));

        uint256 payerBalBefore = token.balanceOf(payerWallet.addr);

        settlement.multicall(calls);

        x402BatchSettlement.ChannelState memory oldCh = _getChannel(oldChannelId);
        assertEq(oldCh.balance, oldCh.totalClaimed);

        x402BatchSettlement.ChannelState memory newCh = _getChannel(newChannelId);
        assertEq(newCh.balance, DEPOSIT_AMOUNT - CLAIM_AMOUNT);

        assertEq(token.balanceOf(payerWallet.addr), payerBalBefore);
    }

    function test_multicall_batchDeposits() public {
        x402BatchSettlement.ChannelConfig memory config1 = _makeConfig();
        x402BatchSettlement.ChannelConfig memory config2 = _makeConfig();
        config2.salt = bytes32(uint256(1));

        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(settlement.deposit, (config1, DEPOSIT_AMOUNT, address(mockCollector), ""));
        calls[1] = abi.encodeCall(settlement.deposit, (config2, DEPOSIT_AMOUNT / 2, address(mockCollector), ""));

        settlement.multicall(calls);

        assertEq(_getChannel(_channelId(config1)).balance, DEPOSIT_AMOUNT);
        assertEq(_getChannel(_channelId(config2)).balance, DEPOSIT_AMOUNT / 2);
    }

    function test_multicall_singleCall() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();

        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(settlement.deposit, (config, DEPOSIT_AMOUNT, address(mockCollector), ""));

        settlement.multicall(calls);

        assertEq(_getChannel(_channelId(config)).balance, DEPOSIT_AMOUNT);
    }

    function test_multicall_revert_propagates() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig();

        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(settlement.deposit, (config, DEPOSIT_AMOUNT, address(mockCollector), ""));
        calls[1] = abi.encodeCall(settlement.deposit, (config, 0, address(mockCollector), ""));

        vm.expectRevert();
        settlement.multicall(calls);

        assertEq(_getChannel(_channelId(config)).balance, 0);
    }

    // =========================================================================
    // Complex Scenario Tests
    // =========================================================================

    /// @dev Full double-migration lifecycle:
    ///   Round 1: deposit A → claim A → migrate(refund A + deposit B) → settle
    ///   Round 2: deposit A → claim A → migrate(refund A + deposit B) → settle
    ///   Asserts channel A is fully drained after each round, channel B accumulates
    ///   both migrations, and the receiver settles both claims.
    function test_scenario_doubleMigrationLifecycle() public {
        x402BatchSettlement.ChannelConfig memory configA = _makeConfig();
        configA.salt = bytes32(uint256(0xA));

        x402BatchSettlement.ChannelConfig memory configB = _makeConfig();
        configB.salt = bytes32(uint256(0xB));

        uint256 payerStart = token.balanceOf(payerWallet.addr);

        // ── Round 1: deposit A, claim A, migrate A→B, settle ─────────────────
        _roundDepositClaimMigrate(configA, configB, 1000e6, 100e6, 100e6);
        settlement.settle(receiverWallet.addr, address(token));

        _assertRound1(configA, configB, payerStart);

        // ── Round 2: deposit A again, claim A, migrate A→B, settle ───────────
        _roundDepositClaimMigrate(configA, configB, 1000e6, 200e6, 200e6);
        settlement.settle(receiverWallet.addr, address(token));

        _assertRound2(configA, configB, payerStart);
    }

    function _roundDepositClaimMigrate(
        x402BatchSettlement.ChannelConfig memory configA,
        x402BatchSettlement.ChannelConfig memory configB,
        uint128 depositAmt,
        uint128 maxClaimable,
        uint128 claimAmt
    ) internal {
        bytes32 channelA = _channelId(configA);

        _deposit(configA, depositAmt);

        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](1);
        claims[0] = _makeVoucherClaim(configA, maxClaimable, claimAmt);
        vm.prank(receiverAuthWallet.addr);
        settlement.claim(claims);

        x402BatchSettlement.ChannelState memory chA = _getChannel(channelA);
        uint128 migrateAmt = chA.balance - chA.totalClaimed;

        uint256 refundNonce = settlement.refundNonce(channelA);
        bytes memory refundSig = _signRefund(receiverAuthWallet, channelA, refundNonce, migrateAmt);
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(settlement.refundWithSignature, (configA, migrateAmt, refundNonce, refundSig));
        calls[1] = abi.encodeCall(settlement.deposit, (configB, migrateAmt, address(mockCollector), ""));
        settlement.multicall(calls);
    }

    function _assertRound1(
        x402BatchSettlement.ChannelConfig memory configA,
        x402BatchSettlement.ChannelConfig memory configB,
        uint256 payerStart
    ) internal view {
        x402BatchSettlement.ChannelState memory chA = _getChannel(_channelId(configA));
        assertEq(chA.balance, chA.totalClaimed, "R1: A fully drained");
        assertEq(chA.totalClaimed, 100e6);

        x402BatchSettlement.ChannelState memory chB = _getChannel(_channelId(configB));
        assertEq(chB.balance, 900e6, "R1: B holds migrated funds");

        assertEq(token.balanceOf(receiverWallet.addr), 100e6, "R1: receiver settled");
        assertEq(token.balanceOf(payerWallet.addr), payerStart - 1000e6, "R1: payer spent one deposit");
    }

    function _assertRound2(
        x402BatchSettlement.ChannelConfig memory configA,
        x402BatchSettlement.ChannelConfig memory configB,
        uint256 payerStart
    ) internal view {
        x402BatchSettlement.ChannelState memory chA = _getChannel(_channelId(configA));
        assertEq(chA.balance, chA.totalClaimed, "R2: A fully drained again");
        assertEq(chA.totalClaimed, 200e6, "R2: A accumulated two claims");

        x402BatchSettlement.ChannelState memory chB = _getChannel(_channelId(configB));
        assertEq(chB.balance, 1800e6, "R2: B holds both migrations");

        assertEq(token.balanceOf(receiverWallet.addr), 200e6, "R2: receiver settled both claims");

        x402BatchSettlement.ReceiverState memory rs = _getReceiver(receiverWallet.addr, address(token));
        assertEq(rs.totalSettled, 200e6, "R2: totalSettled matches");
        assertEq(rs.totalClaimed, rs.totalSettled, "R2: nothing unsettled");

        assertEq(token.balanceOf(payerWallet.addr), payerStart - 2000e6, "R2: payer funded both deposit rounds");
    }

    /// @dev Multiple individual claims across 3 channels, then a batched
    ///      claimWithSignature across all 3, followed by a single settle.
    function test_scenario_multiChannelClaimsThenBatchedClaimAndSettle() public {
        x402BatchSettlement.ChannelConfig memory c1 = _makeConfig();
        c1.salt = bytes32(uint256(1));
        x402BatchSettlement.ChannelConfig memory c2 = _makeConfig();
        c2.salt = bytes32(uint256(2));
        x402BatchSettlement.ChannelConfig memory c3 = _makeConfig();
        c3.salt = bytes32(uint256(3));

        _deposit(c1, 1000e6);
        _deposit(c2, 2000e6);
        _deposit(c3, 500e6);

        // ── Individual claims ────────────────────────────────────────────────

        // C1: claim 50, then claim to total 150
        x402BatchSettlement.VoucherClaim[] memory v = new x402BatchSettlement.VoucherClaim[](1);
        v[0] = _makeVoucherClaim(c1, 50e6, 50e6);
        vm.prank(receiverAuthWallet.addr);
        settlement.claim(v);

        v[0] = _makeVoucherClaim(c1, 150e6, 150e6);
        vm.prank(receiverAuthWallet.addr);
        settlement.claim(v);

        // C2: claim 200
        v[0] = _makeVoucherClaim(c2, 200e6, 200e6);
        vm.prank(receiverAuthWallet.addr);
        settlement.claim(v);

        // C3: claim 50
        v[0] = _makeVoucherClaim(c3, 50e6, 50e6);
        vm.prank(receiverAuthWallet.addr);
        settlement.claim(v);

        // Verify intermediate state
        assertEq(_getChannel(_channelId(c1)).totalClaimed, 150e6);
        assertEq(_getChannel(_channelId(c2)).totalClaimed, 200e6);
        assertEq(_getChannel(_channelId(c3)).totalClaimed, 50e6);

        x402BatchSettlement.ReceiverState memory rsMid = _getReceiver(receiverWallet.addr, address(token));
        assertEq(rsMid.totalClaimed, 400e6, "Mid: total claimed across all channels");
        assertEq(rsMid.totalSettled, 0, "Mid: nothing settled yet");

        // ── Batched claimWithSignature across all 3 channels ─────────────────

        x402BatchSettlement.VoucherClaim[] memory batchClaims = new x402BatchSettlement.VoucherClaim[](3);
        batchClaims[0] = _makeVoucherClaim(c1, 250e6, 250e6); // C1: total 250 (+100 delta)
        batchClaims[1] = _makeVoucherClaim(c2, 500e6, 500e6); // C2: total 500 (+300 delta)
        batchClaims[2] = _makeVoucherClaim(c3, 200e6, 200e6); // C3: total 200 (+150 delta)

        bytes memory authSig = _signClaimBatch(receiverAuthWallet, batchClaims);
        vm.prank(otherWallet.addr);
        settlement.claimWithSignature(batchClaims, authSig);

        // Verify post-batch state
        assertEq(_getChannel(_channelId(c1)).totalClaimed, 250e6);
        assertEq(_getChannel(_channelId(c2)).totalClaimed, 500e6);
        assertEq(_getChannel(_channelId(c3)).totalClaimed, 200e6);

        x402BatchSettlement.ReceiverState memory rsPost = _getReceiver(receiverWallet.addr, address(token));
        uint128 expectedTotal = 250e6 + 500e6 + 200e6;
        assertEq(rsPost.totalClaimed, expectedTotal, "Post: accumulated across individual + batch");
        assertEq(rsPost.totalSettled, 0, "Post: still nothing settled");

        // ── Single settle sweeps everything ──────────────────────────────────

        uint256 receiverBefore = token.balanceOf(receiverWallet.addr);
        settlement.settle(receiverWallet.addr, address(token));
        assertEq(
            token.balanceOf(receiverWallet.addr),
            receiverBefore + expectedTotal,
            "Settle: receiver received all claimed funds"
        );

        x402BatchSettlement.ReceiverState memory rsFinal = _getReceiver(receiverWallet.addr, address(token));
        assertEq(rsFinal.totalSettled, expectedTotal);
        assertEq(rsFinal.totalClaimed, rsFinal.totalSettled, "Final: fully settled");

        // Channel balances unchanged (claims don't reduce balance)
        assertEq(_getChannel(_channelId(c1)).balance, 1000e6);
        assertEq(_getChannel(_channelId(c2)).balance, 2000e6);
        assertEq(_getChannel(_channelId(c3)).balance, 500e6);
    }
}
