// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title x402BatchSettlement gas benchmarks
/// @notice Foundry gas snapshots for deposit / claim / settle / refund paths.
///
/// **Run locally (mock collectors + mock token):**
/// `forge test --match-contract X402BatchSettlementGasTest -vv`
///
/// **Gas report table:**
/// `forge test --match-contract X402BatchSettlementGasTest --gas-report`
///
/// **Interpretation:**
/// - **ERC-3009 deposit:** `MockERC3009Token` does not verify signatures; real USDC ERC-3009 may cost more.
/// - **Permit2 deposit:** `MockPermit2` omits canonical Permit2 crypto; see fork tests for real Permit2 gas.
/// - **First deposit** on a channel includes `ChannelCreated`; top-ups are cheaper (not measured here unless noted).
/// - **Refund** measured via `refund` (EOA receiverAuthorizer). `refundWithSignature` adds payer-side digest verification.
///
/// **Production-adjacent Permit2:** `test/x402BatchSettlement.fork.t.sol` defines `test_gas_fork_*`; run with `--fork-url $BASE_RPC_URL` (or mainnet) so Permit2 bytecode exists.
///
/// **Break-even sketch** (one channel, same receiver/token): compare summed snapshots to `baseline_erc20_transfer`.
/// Rough parity when N naive ERC-20 transfers (gas each ~= baseline) exceeds deposit + claim + settle (+ refund if applicable).

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {x402BatchSettlement} from "../src/x402BatchSettlement.sol";
import {ERC3009DepositCollector} from "../src/periphery/ERC3009DepositCollector.sol";
import {Permit2DepositCollector} from "../src/periphery/Permit2DepositCollector.sol";
import {GasMockDepositCollector} from "./mocks/GasMockDepositCollector.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockERC3009Token} from "./mocks/MockERC3009Token.sol";
import {MockPermit2} from "./mocks/MockPermit2.sol";

contract X402BatchSettlementGasTest is Test {
    x402BatchSettlement public settlement;
    GasMockDepositCollector public mockCollector;

    MockERC20 public erc20Token;
    MockERC3009Token public erc3009Token;
    ERC3009DepositCollector public erc3009Collector;

    MockPermit2 public mockPermit2;
    Permit2DepositCollector public permit2Collector;

    VmSafe.Wallet public payerWallet;
    VmSafe.Wallet public payerAuthWallet;
    VmSafe.Wallet public receiverWallet;
    VmSafe.Wallet public receiverAuthWallet;

    uint40 internal constant WITHDRAW_DELAY = 3600;
    uint128 internal constant DEPOSIT_AMOUNT = 1000e6;
    uint128 internal constant CLAIM_AMOUNT = 100e6;

    function setUp() public {
        vm.warp(1_000_000);

        payerWallet = vm.createWallet("gas_payer");
        payerAuthWallet = vm.createWallet("gas_payerAuth");
        receiverWallet = vm.createWallet("gas_receiver");
        receiverAuthWallet = vm.createWallet("gas_receiverAuth");

        settlement = new x402BatchSettlement();
        mockCollector = new GasMockDepositCollector();

        erc20Token = new MockERC20("USDC", "USDC", 6);
        erc20Token.mint(payerWallet.addr, 10_000_000e6);

        vm.prank(payerWallet.addr);
        erc20Token.approve(address(mockCollector), type(uint256).max);

        erc3009Token = new MockERC3009Token("USDC3009", "USDC", 6);
        erc3009Token.mint(payerWallet.addr, 10_000_000e6);

        erc3009Collector = new ERC3009DepositCollector(address(settlement));

        mockPermit2 = new MockPermit2();
        mockPermit2.setShouldActuallyTransfer(true);
        permit2Collector = new Permit2DepositCollector(address(settlement), address(mockPermit2));

        vm.prank(payerWallet.addr);
        erc20Token.approve(address(mockPermit2), type(uint256).max);
    }

    function _makeConfig(
        address token,
        bytes32 salt
    ) internal view returns (x402BatchSettlement.ChannelConfig memory) {
        return x402BatchSettlement.ChannelConfig({
            payer: payerWallet.addr,
            payerAuthorizer: payerAuthWallet.addr,
            receiver: receiverWallet.addr,
            receiverAuthorizer: receiverAuthWallet.addr,
            token: token,
            withdrawDelay: WITHDRAW_DELAY,
            salt: salt
        });
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

    function _depositErc20(x402BatchSettlement.ChannelConfig memory config, uint128 amount) internal {
        settlement.deposit(config, amount, address(mockCollector), "");
    }

    /// @notice Baseline: simple ERC-20 transfer (break-even denominator).
    function test_gas_baseline_erc20_transfer() public {
        address recipient = receiverWallet.addr;
        erc20Token.mint(address(this), DEPOSIT_AMOUNT);
        erc20Token.transfer(recipient, DEPOSIT_AMOUNT);
        uint256 g = vm.snapshotGasLastCall("baseline_erc20_transfer");
        console2.log("baseline_erc20_transfer", g);
    }

    /// @notice First ERC-20 deposit via pull collector (MockDepositCollector), not ERC-3009 / Permit2.
    function test_gas_deposit_erc20_pull_first() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig(address(erc20Token), bytes32(0));
        vm.prank(payerWallet.addr);
        _depositErc20(config, DEPOSIT_AMOUNT);
        uint256 g = vm.snapshotGasLastCall("deposit_erc20_pull_first");
        console2.log("deposit_erc20_pull_first", g);
    }

    /// @notice ERC-3009-style deposit: receiveWithAuthorization + forward to settlement (`MockERC3009Token`).
    function test_gas_deposit_erc3009_first() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig(address(erc3009Token), bytes32(0));
        bytes32 channelId = settlement.getChannelId(config);
        uint256 salt = 7;
        bytes32 expectedNonce = keccak256(abi.encode(channelId, salt));
        bytes memory dummySig = abi.encodePacked(expectedNonce, bytes32(0)); // unused by mock token

        bytes memory collectorData = abi.encode(uint256(0), type(uint256).max, salt, dummySig);

        vm.prank(payerWallet.addr);
        settlement.deposit(config, DEPOSIT_AMOUNT, address(erc3009Collector), collectorData);
        uint256 g = vm.snapshotGasLastCall("deposit_erc3009_first");
        console2.log("deposit_erc3009_first", g);
    }

    /// @notice Permit2 witness transfer via `MockPermit2` + `Permit2DepositCollector`.
    function test_gas_deposit_permit2_mock_first() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig(address(erc20Token), bytes32(0));
        uint256 nonce = uint256(keccak256("gas_permit2_nonce"));
        uint256 deadline = block.timestamp + 3600;
        bytes memory permit2Sig = hex"";
        bytes memory collectorData = abi.encode(nonce, deadline, permit2Sig, bytes(""));

        vm.prank(payerWallet.addr);
        settlement.deposit(config, DEPOSIT_AMOUNT, address(permit2Collector), collectorData);
        uint256 g = vm.snapshotGasLastCall("deposit_permit2_mock_first");
        console2.log("deposit_permit2_mock_first", g);
    }

    /// @notice Single-voucher `claim` after funding via pull deposit.
    function test_gas_claim_one_voucher() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig(address(erc20Token), bytes32(0));
        bytes32 channelId = settlement.getChannelId(config);

        vm.prank(payerWallet.addr);
        _depositErc20(config, DEPOSIT_AMOUNT);

        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](1);
        claims[0] = x402BatchSettlement.VoucherClaim({
            voucher: x402BatchSettlement.Voucher({channel: config, maxClaimableAmount: CLAIM_AMOUNT}),
            signature: _signVoucher(payerAuthWallet, channelId, CLAIM_AMOUNT),
            totalClaimed: CLAIM_AMOUNT
        });

        vm.prank(receiverAuthWallet.addr);
        settlement.claim(claims);
        uint256 g = vm.snapshotGasLastCall("claim_1_voucher");
        console2.log("claim_1_voucher", g);
    }

    /// @notice Ten distinct channels in one `claim` batch (each channel pre-funded).
    function test_gas_claim_ten_channels() public {
        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](10);

        for (uint256 i = 0; i < 10; ++i) {
            x402BatchSettlement.ChannelConfig memory cfg = _makeConfig(address(erc20Token), bytes32(uint256(i + 1)));
            bytes32 cid = settlement.getChannelId(cfg);

            vm.prank(payerWallet.addr);
            _depositErc20(cfg, DEPOSIT_AMOUNT);

            claims[i] = x402BatchSettlement.VoucherClaim({
                voucher: x402BatchSettlement.Voucher({channel: cfg, maxClaimableAmount: CLAIM_AMOUNT}),
                signature: _signVoucher(payerAuthWallet, cid, CLAIM_AMOUNT),
                totalClaimed: CLAIM_AMOUNT
            });
        }

        vm.prank(receiverAuthWallet.addr);
        settlement.claim(claims);
        uint256 g = vm.snapshotGasLastCall("claim_10_channels");
        console2.log("claim_10_channels", g);
    }

    /// @notice Sweep claimed-but-not-settled balance to receiver (single token).
    function test_gas_settle() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig(address(erc20Token), bytes32(0));
        bytes32 channelId = settlement.getChannelId(config);

        vm.prank(payerWallet.addr);
        _depositErc20(config, DEPOSIT_AMOUNT);

        x402BatchSettlement.VoucherClaim[] memory claims = new x402BatchSettlement.VoucherClaim[](1);
        claims[0] = x402BatchSettlement.VoucherClaim({
            voucher: x402BatchSettlement.Voucher({channel: config, maxClaimableAmount: CLAIM_AMOUNT}),
            signature: _signVoucher(payerAuthWallet, channelId, CLAIM_AMOUNT),
            totalClaimed: CLAIM_AMOUNT
        });

        vm.prank(receiverAuthWallet.addr);
        settlement.claim(claims);

        settlement.settle(receiverWallet.addr, address(erc20Token));
        uint256 g = vm.snapshotGasLastCall("settle_receiver_token");
        console2.log("settle_receiver_token", g);
    }

    /// @notice Cooperative refund of available escrow (`receiverAuthorizer` caller).
    function test_gas_refund_full() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig(address(erc20Token), bytes32(0));

        vm.prank(payerWallet.addr);
        _depositErc20(config, DEPOSIT_AMOUNT);

        vm.prank(receiverAuthWallet.addr);
        settlement.refund(config, DEPOSIT_AMOUNT);
        uint256 g = vm.snapshotGasLastCall("refund_full_receiverAuth");
        console2.log("refund_full_receiverAuth", g);
    }

    /// @notice Relay-style refund with EIP-712 signature check on `receiverAuthorizer`.
    function test_gas_refund_with_signature() public {
        x402BatchSettlement.ChannelConfig memory config = _makeConfig(address(erc20Token), bytes32(uint256(777)));
        bytes32 channelId = settlement.getChannelId(config);

        vm.prank(payerWallet.addr);
        _depositErc20(config, DEPOSIT_AMOUNT);

        uint256 nonce = settlement.refundNonce(channelId);
        bytes32 structHash = keccak256(abi.encode(settlement.REFUND_TYPEHASH(), channelId, nonce, DEPOSIT_AMOUNT));
        bytes memory sig = _signTypedData(receiverAuthWallet, structHash);

        settlement.refundWithSignature(config, DEPOSIT_AMOUNT, nonce, sig);
        uint256 g = vm.snapshotGasLastCall("refund_with_signature_relay");
        console2.log("refund_with_signature_relay", g);
    }
}
