// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {x402BatchSettlementHedera} from "../../src/hedera/x402BatchSettlementHedera.sol";
import {HederaAllowanceDepositCollector} from "../../src/hedera/HederaAllowanceDepositCollector.sol";
import {MockHederaAccountService} from "./mocks/MockHederaAccountService.sol";
import {MockHederaTokenService, MockHtsToken} from "./mocks/MockHederaTokenService.sol";

/// @dev Shared fixture: mocked HAS (0x16a) / HTS (0x167) system contracts, escrow, collector, HTS-style token.
abstract contract HederaBatchFixture is Test {
    x402BatchSettlementHedera internal settlement;
    HederaAllowanceDepositCollector internal collector;
    MockHederaAccountService internal has;
    MockHederaTokenService internal hts;
    MockHtsToken internal token;

    VmSafe.Wallet internal payerWallet; // ECDSA payer (EVM-alias style account)
    VmSafe.Wallet internal payerAuthWallet; // ECDSA payer authorizer
    VmSafe.Wallet internal receiverAuthWallet; // ECDSA receiver authorizer
    address internal receiver;
    address internal ed25519Payer; // long-zero style account with an ED25519 key
    address internal ed25519Auth; // long-zero style receiver authorizer with an ED25519 key

    uint40 constant WITHDRAW_DELAY = 3600;
    uint128 constant DEPOSIT_AMOUNT = 1000e6;
    uint128 constant CLAIM_AMOUNT = 100e6;
    uint256 constant CHAIN_ID = 296;

    function setUp() public virtual {
        vm.chainId(CHAIN_ID);
        vm.warp(1_000_000);

        vm.etch(address(0x16a), address(new MockHederaAccountService()).code);
        vm.etch(address(0x167), address(new MockHederaTokenService()).code);
        has = MockHederaAccountService(address(0x16a));
        hts = MockHederaTokenService(address(0x167));

        payerWallet = vm.createWallet("payer");
        payerAuthWallet = vm.createWallet("payerAuth");
        receiverAuthWallet = vm.createWallet("receiverAuth");
        receiver = address(uint160(0x1234)); // long-zero address 0.0.4660
        ed25519Payer = address(uint160(0x5678));
        ed25519Auth = address(uint160(0x9abc));

        has.setEcdsaAccount(payerAuthWallet.addr, payerAuthWallet.addr);
        has.setEcdsaAccount(receiverAuthWallet.addr, receiverAuthWallet.addr);
        has.setEd25519Account(ed25519Payer);
        has.setEd25519Account(ed25519Auth);

        settlement = new x402BatchSettlementHedera();
        collector = new HederaAllowanceDepositCollector(address(settlement));
        token = new MockHtsToken();

        token.mint(payerWallet.addr, 100_000e6);
        token.mint(ed25519Payer, 100_000e6);
        hts.setAllowance(address(token), payerWallet.addr, address(collector), type(uint64).max);
        hts.setAllowance(address(token), ed25519Payer, address(collector), type(uint64).max);
        settlement.associateToken(address(token));
    }

    // ---- helpers ------------------------------------------------------------

    function _config(address payer, address payerAuthorizer, address receiverAuthorizer)
        internal
        view
        returns (x402BatchSettlementHedera.ChannelConfig memory)
    {
        return x402BatchSettlementHedera.ChannelConfig({
            payer: payer,
            payerAuthorizer: payerAuthorizer,
            receiver: receiver,
            receiverAuthorizer: receiverAuthorizer,
            token: address(token),
            withdrawDelay: WITHDRAW_DELAY,
            salt: bytes32(0)
        });
    }

    function _ecdsaConfig() internal view returns (x402BatchSettlementHedera.ChannelConfig memory) {
        return _config(payerWallet.addr, payerAuthWallet.addr, receiverAuthWallet.addr);
    }

    function _ed25519Config() internal view returns (x402BatchSettlementHedera.ChannelConfig memory) {
        return _config(ed25519Payer, address(0), ed25519Auth);
    }

    function _sign(VmSafe.Wallet memory wallet, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wallet, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev ED25519 signatures cannot be produced in the EVM; register an opaque 64-byte blob as valid.
    function _ed25519Sign(address account, bytes32 digest) internal returns (bytes memory sig) {
        sig = abi.encodePacked(keccak256(abi.encode("ed25519", account, digest)), digest);
        has.setEd25519Signature(account, digest, sig, true);
    }

    function _depositData(VmSafe.Wallet memory wallet, bytes32 channelId, uint256 amount, uint256 nonce)
        internal
        returns (bytes memory)
    {
        uint256 deadline = block.timestamp + 600;
        bytes32 digest = collector.getDepositDigest(channelId, address(token), amount, nonce, deadline);
        return abi.encode(nonce, deadline, _sign(wallet, digest));
    }

    function _depositDataEd25519(address account, bytes32 channelId, uint256 amount, uint256 nonce)
        internal
        returns (bytes memory)
    {
        uint256 deadline = block.timestamp + 600;
        bytes32 digest = collector.getDepositDigest(channelId, address(token), amount, nonce, deadline);
        return abi.encode(nonce, deadline, _ed25519Sign(account, digest));
    }

    function _depositEcdsa(uint128 amount, uint256 nonce) internal returns (bytes32 channelId) {
        x402BatchSettlementHedera.ChannelConfig memory cfg = _ecdsaConfig();
        channelId = settlement.getChannelId(cfg);
        settlement.deposit(cfg, amount, address(collector), _depositData(payerWallet, channelId, amount, nonce));
    }

    function _depositEd25519(uint128 amount, uint256 nonce) internal returns (bytes32 channelId) {
        x402BatchSettlementHedera.ChannelConfig memory cfg = _ed25519Config();
        channelId = settlement.getChannelId(cfg);
        settlement.deposit(
            cfg, amount, address(collector), _depositDataEd25519(ed25519Payer, channelId, amount, nonce)
        );
    }

    function _claim(
        x402BatchSettlementHedera.ChannelConfig memory cfg,
        uint128 maxClaimable,
        uint128 totalClaimed,
        bytes memory sig
    ) internal pure returns (x402BatchSettlementHedera.VoucherClaim memory) {
        return x402BatchSettlementHedera.VoucherClaim({
            voucher: x402BatchSettlementHedera.Voucher({channel: cfg, maxClaimableAmount: maxClaimable}),
            signature: sig,
            totalClaimed: totalClaimed
        });
    }
}

contract X402BatchSettlementHederaTest is HederaBatchFixture {
    event TokenAssociated(address indexed token, int64 responseCode);

    // ---- association --------------------------------------------------------

    function test_associateToken_alreadyAssociatedIsIdempotent() public {
        vm.expectEmit(true, false, false, true);
        emit TokenAssociated(address(token), 194);
        settlement.associateToken(address(token));
    }

    function test_associateToken_revertsOnFailureCode() public {
        hts.forceAssociateResponse(184);
        vm.expectRevert(abi.encodeWithSelector(x402BatchSettlementHedera.TokenAssociationFailed.selector, int64(184)));
        settlement.associateToken(address(token));
    }

    function test_associateToken_zeroReverts() public {
        vm.expectRevert(x402BatchSettlementHedera.InvalidChannel.selector);
        settlement.associateToken(address(0));
    }

    // ---- deposits -----------------------------------------------------------

    function test_deposit_ecdsaPayer() public {
        bytes32 channelId = _depositEcdsa(DEPOSIT_AMOUNT, 1);
        (uint128 balance, uint128 totalClaimed) = settlement.channels(channelId);
        assertEq(balance, DEPOSIT_AMOUNT);
        assertEq(totalClaimed, 0);
        assertEq(token.balanceOf(address(settlement)), DEPOSIT_AMOUNT);
        assertTrue(collector.usedNonces(payerWallet.addr, 1));
    }

    function test_deposit_ed25519Payer() public {
        bytes32 channelId = _depositEd25519(DEPOSIT_AMOUNT, 7);
        (uint128 balance,) = settlement.channels(channelId);
        assertEq(balance, DEPOSIT_AMOUNT);
        assertEq(token.balanceOf(ed25519Payer), 100_000e6 - DEPOSIT_AMOUNT);
    }

    function test_deposit_topUpAccumulates() public {
        _depositEcdsa(DEPOSIT_AMOUNT, 1);
        bytes32 channelId = _depositEcdsa(DEPOSIT_AMOUNT, 2);
        (uint128 balance,) = settlement.channels(channelId);
        assertEq(balance, 2 * DEPOSIT_AMOUNT);
    }

    function test_deposit_wrongChannelInDigestReverts() public {
        x402BatchSettlementHedera.ChannelConfig memory cfg = _ecdsaConfig();
        bytes memory data = _depositData(payerWallet, bytes32(uint256(999)), DEPOSIT_AMOUNT, 1);
        vm.expectRevert(HederaAllowanceDepositCollector.InvalidDepositSignature.selector);
        settlement.deposit(cfg, DEPOSIT_AMOUNT, address(collector), data);
    }

    function test_deposit_insufficientAllowanceReverts() public {
        hts.setAllowance(address(token), payerWallet.addr, address(collector), DEPOSIT_AMOUNT - 1);
        x402BatchSettlementHedera.ChannelConfig memory cfg = _ecdsaConfig();
        bytes32 channelId = settlement.getChannelId(cfg);
        bytes memory data = _depositData(payerWallet, channelId, DEPOSIT_AMOUNT, 1);
        vm.expectRevert(abi.encodeWithSelector(HederaAllowanceDepositCollector.HtsTransferFailed.selector, int64(292)));
        settlement.deposit(cfg, DEPOSIT_AMOUNT, address(collector), data);
    }

    // ---- claims -------------------------------------------------------------

    function test_claimWithSignature_ecdsaVoucherAndAuthorizer() public {
        bytes32 channelId = _depositEcdsa(DEPOSIT_AMOUNT, 1);
        x402BatchSettlementHedera.ChannelConfig memory cfg = _ecdsaConfig();

        bytes memory voucherSig = _sign(payerAuthWallet, settlement.getVoucherDigest(channelId, CLAIM_AMOUNT));
        x402BatchSettlementHedera.VoucherClaim[] memory claims = new x402BatchSettlementHedera.VoucherClaim[](1);
        claims[0] = _claim(cfg, CLAIM_AMOUNT, CLAIM_AMOUNT, voucherSig);
        bytes memory batchSig = _sign(receiverAuthWallet, settlement.getClaimBatchDigest(claims));

        vm.prank(makeAddr("relayer"));
        settlement.claimWithSignature(claims, batchSig);

        (, uint128 totalClaimed) = settlement.channels(channelId);
        assertEq(totalClaimed, CLAIM_AMOUNT);
        (uint128 rcvClaimed, uint128 rcvSettled) = settlement.receivers(receiver, address(token));
        assertEq(rcvClaimed, CLAIM_AMOUNT);
        assertEq(rcvSettled, 0);
    }

    function test_claimWithSignature_ed25519VoucherAndAuthorizer() public {
        bytes32 channelId = _depositEd25519(DEPOSIT_AMOUNT, 1);
        x402BatchSettlementHedera.ChannelConfig memory cfg = _ed25519Config();

        bytes memory voucherSig = _ed25519Sign(ed25519Payer, settlement.getVoucherDigest(channelId, CLAIM_AMOUNT));
        x402BatchSettlementHedera.VoucherClaim[] memory claims = new x402BatchSettlementHedera.VoucherClaim[](1);
        claims[0] = _claim(cfg, CLAIM_AMOUNT, CLAIM_AMOUNT, voucherSig);
        bytes memory batchSig = _ed25519Sign(ed25519Auth, settlement.getClaimBatchDigest(claims));

        settlement.claimWithSignature(claims, batchSig);
        (, uint128 totalClaimed) = settlement.channels(channelId);
        assertEq(totalClaimed, CLAIM_AMOUNT);
    }

    function test_claimWithSignature_batchAcrossKeyTypesSharingAuthorizer() public {
        // Two channels (ECDSA payer + ED25519 payer) sharing one ECDSA receiverAuthorizer in a single batch.
        x402BatchSettlementHedera.ChannelConfig memory cfgA = _ecdsaConfig();
        x402BatchSettlementHedera.ChannelConfig memory cfgB = _config(ed25519Payer, address(0), receiverAuthWallet.addr);
        bytes32 idA = settlement.getChannelId(cfgA);
        bytes32 idB = settlement.getChannelId(cfgB);
        settlement.deposit(cfgA, DEPOSIT_AMOUNT, address(collector), _depositData(payerWallet, idA, DEPOSIT_AMOUNT, 1));
        settlement.deposit(
            cfgB, DEPOSIT_AMOUNT, address(collector), _depositDataEd25519(ed25519Payer, idB, DEPOSIT_AMOUNT, 1)
        );

        x402BatchSettlementHedera.VoucherClaim[] memory claims = new x402BatchSettlementHedera.VoucherClaim[](2);
        claims[0] = _claim(cfgA, CLAIM_AMOUNT, CLAIM_AMOUNT, _sign(payerAuthWallet, settlement.getVoucherDigest(idA, CLAIM_AMOUNT)));
        claims[1] = _claim(cfgB, 2 * CLAIM_AMOUNT, 2 * CLAIM_AMOUNT, _ed25519Sign(ed25519Payer, settlement.getVoucherDigest(idB, 2 * CLAIM_AMOUNT)));
        settlement.claimWithSignature(claims, _sign(receiverAuthWallet, settlement.getClaimBatchDigest(claims)));

        (, uint128 claimedA) = settlement.channels(idA);
        (, uint128 claimedB) = settlement.channels(idB);
        assertEq(claimedA, CLAIM_AMOUNT);
        assertEq(claimedB, 2 * CLAIM_AMOUNT);
    }

    function test_claimWithSignature_wrongVoucherSignerReverts() public {
        bytes32 channelId = _depositEcdsa(DEPOSIT_AMOUNT, 1);
        x402BatchSettlementHedera.ChannelConfig memory cfg = _ecdsaConfig();
        // signed by the payer instead of the committed payerAuthorizer
        bytes memory badSig = _sign(payerWallet, settlement.getVoucherDigest(channelId, CLAIM_AMOUNT));
        x402BatchSettlementHedera.VoucherClaim[] memory claims = new x402BatchSettlementHedera.VoucherClaim[](1);
        claims[0] = _claim(cfg, CLAIM_AMOUNT, CLAIM_AMOUNT, badSig);
        bytes memory batchSig = _sign(receiverAuthWallet, settlement.getClaimBatchDigest(claims));
        vm.expectRevert(x402BatchSettlementHedera.InvalidSignature.selector);
        settlement.claimWithSignature(claims, batchSig);
    }

    function test_claimWithSignature_keyTypeMismatchRevertIsTreatedAsInvalid() public {
        // ECDSA-style 65-byte signature presented for an ED25519 account: HAS reverts, contract must not accept.
        bytes32 channelId = _depositEd25519(DEPOSIT_AMOUNT, 1);
        x402BatchSettlementHedera.ChannelConfig memory cfg = _ed25519Config();
        bytes memory sig65 = _sign(payerWallet, settlement.getVoucherDigest(channelId, CLAIM_AMOUNT));
        x402BatchSettlementHedera.VoucherClaim[] memory claims = new x402BatchSettlementHedera.VoucherClaim[](1);
        claims[0] = _claim(cfg, CLAIM_AMOUNT, CLAIM_AMOUNT, sig65);
        bytes memory batchSig = _ed25519Sign(ed25519Auth, settlement.getClaimBatchDigest(claims));
        vm.expectRevert(x402BatchSettlementHedera.InvalidSignature.selector);
        settlement.claimWithSignature(claims, batchSig);
    }

    function test_claimWithSignature_hasRevertIsTreatedAsInvalid() public {
        bytes32 channelId = _depositEcdsa(DEPOSIT_AMOUNT, 1);
        x402BatchSettlementHedera.ChannelConfig memory cfg = _ecdsaConfig();
        bytes memory voucherSig = _sign(payerAuthWallet, settlement.getVoucherDigest(channelId, CLAIM_AMOUNT));
        x402BatchSettlementHedera.VoucherClaim[] memory claims = new x402BatchSettlementHedera.VoucherClaim[](1);
        claims[0] = _claim(cfg, CLAIM_AMOUNT, CLAIM_AMOUNT, voucherSig);
        bytes memory batchSig = _sign(receiverAuthWallet, settlement.getClaimBatchDigest(claims));
        has.revertNext();
        vm.expectRevert(x402BatchSettlementHedera.InvalidSignature.selector);
        settlement.claimWithSignature(claims, batchSig);
    }

    function test_claimWithSignature_wrongAuthorizerReverts() public {
        bytes32 channelId = _depositEcdsa(DEPOSIT_AMOUNT, 1);
        x402BatchSettlementHedera.ChannelConfig memory cfg = _ecdsaConfig();
        bytes memory voucherSig = _sign(payerAuthWallet, settlement.getVoucherDigest(channelId, CLAIM_AMOUNT));
        x402BatchSettlementHedera.VoucherClaim[] memory claims = new x402BatchSettlementHedera.VoucherClaim[](1);
        claims[0] = _claim(cfg, CLAIM_AMOUNT, CLAIM_AMOUNT, voucherSig);
        bytes memory batchSig = _sign(payerAuthWallet, settlement.getClaimBatchDigest(claims));
        vm.expectRevert(x402BatchSettlementHedera.InvalidSignature.selector);
        settlement.claimWithSignature(claims, batchSig);
    }

    // ---- settle -------------------------------------------------------------

    function test_settle_transfersToReceiver() public {
        bytes32 channelId = _depositEcdsa(DEPOSIT_AMOUNT, 1);
        x402BatchSettlementHedera.ChannelConfig memory cfg = _ecdsaConfig();
        x402BatchSettlementHedera.VoucherClaim[] memory claims = new x402BatchSettlementHedera.VoucherClaim[](1);
        claims[0] = _claim(cfg, CLAIM_AMOUNT, CLAIM_AMOUNT, _sign(payerAuthWallet, settlement.getVoucherDigest(channelId, CLAIM_AMOUNT)));
        settlement.claimWithSignature(claims, _sign(receiverAuthWallet, settlement.getClaimBatchDigest(claims)));

        settlement.settle(receiver, address(token));
        assertEq(token.balanceOf(receiver), CLAIM_AMOUNT);
        (uint128 rcvClaimed, uint128 rcvSettled) = settlement.receivers(receiver, address(token));
        assertEq(rcvClaimed, rcvSettled);
    }

    // ---- refunds ------------------------------------------------------------

    function test_refundWithSignature_ecdsaAuthorizer() public {
        bytes32 channelId = _depositEcdsa(DEPOSIT_AMOUNT, 1);
        x402BatchSettlementHedera.ChannelConfig memory cfg = _ecdsaConfig();
        uint128 refundAmount = 400e6;
        bytes memory sig = _sign(receiverAuthWallet, settlement.getRefundDigest(channelId, 0, refundAmount));
        uint256 before = token.balanceOf(payerWallet.addr);
        settlement.refundWithSignature(cfg, refundAmount, 0, sig);
        assertEq(token.balanceOf(payerWallet.addr), before + refundAmount);
        assertEq(settlement.refundNonce(channelId), 1);
    }

    function test_refundWithSignature_ed25519Authorizer() public {
        bytes32 channelId = _depositEd25519(DEPOSIT_AMOUNT, 1);
        x402BatchSettlementHedera.ChannelConfig memory cfg = _ed25519Config();
        bytes memory sig = _ed25519Sign(ed25519Auth, settlement.getRefundDigest(channelId, 0, DEPOSIT_AMOUNT));
        settlement.refundWithSignature(cfg, DEPOSIT_AMOUNT, 0, sig);
        (uint128 balance,) = settlement.channels(channelId);
        assertEq(balance, 0);
        assertEq(token.balanceOf(ed25519Payer), 100_000e6);
    }

    function test_refundWithSignature_staleNonceReverts() public {
        bytes32 channelId = _depositEcdsa(DEPOSIT_AMOUNT, 1);
        x402BatchSettlementHedera.ChannelConfig memory cfg = _ecdsaConfig();
        bytes memory sig = _sign(receiverAuthWallet, settlement.getRefundDigest(channelId, 0, 1e6));
        settlement.refundWithSignature(cfg, 1e6, 0, sig);
        vm.expectRevert(x402BatchSettlementHedera.InvalidRefundNonce.selector);
        settlement.refundWithSignature(cfg, 1e6, 0, sig);
    }

    function test_refundWithSignature_wrongSignerReverts() public {
        bytes32 channelId = _depositEcdsa(DEPOSIT_AMOUNT, 1);
        x402BatchSettlementHedera.ChannelConfig memory cfg = _ecdsaConfig();
        bytes memory sig = _sign(payerAuthWallet, settlement.getRefundDigest(channelId, 0, 1e6));
        vm.expectRevert(x402BatchSettlementHedera.InvalidSignature.selector);
        settlement.refundWithSignature(cfg, 1e6, 0, sig);
    }

    // ---- withdraw (payer-driven, direct call) --------------------------------

    function test_timedWithdraw_byEd25519PayerViaDirectCall() public {
        bytes32 channelId = _depositEd25519(DEPOSIT_AMOUNT, 1);
        x402BatchSettlementHedera.ChannelConfig memory cfg = _ed25519Config();
        vm.prank(ed25519Payer);
        settlement.initiateWithdraw(cfg, DEPOSIT_AMOUNT);
        vm.warp(block.timestamp + WITHDRAW_DELAY + 1);
        vm.prank(ed25519Payer);
        settlement.finalizeWithdraw(cfg);
        (uint128 balance,) = settlement.channels(channelId);
        assertEq(balance, 0);
        assertEq(token.balanceOf(ed25519Payer), 100_000e6);
    }
}
