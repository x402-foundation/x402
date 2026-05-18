// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Multicall} from "@openzeppelin/contracts/utils/Multicall.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {IDepositCollector} from "./interfaces/IDepositCollector.sol";

/// @title x402BatchSettlement
/// @notice Stateless unidirectional payment channel contract for the x402 `batch-settlement` scheme on EVM.
///
/// @dev Channel identity is derived from an immutable `ChannelConfig`:
///      `channelId = keccak256(abi.encode(channelConfig))`.
///      Deploy at the same address on every chain via CREATE2.
///      Uses `ReentrancyGuardTransient` (EIP-1153); deploy only where transient storage is supported.
///      Fee-on-transfer and rebasing tokens are not recommended and are not guaranteed to behave like standard ERC-20s.
///
/// @author Coinbase
contract x402BatchSettlement is EIP712, Multicall, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    // =========================================================================
    // Structs
    // =========================================================================

    /// @notice Immutable channel parameters; hashed to form `channelId`.
    ///
    /// @dev `withdrawDelay` must be between `MIN_WITHDRAW_DELAY` and `MAX_WITHDRAW_DELAY` (inclusive) at deposit time.
    ///      The floor is a protocol minimum; high-value channels often use **longer** delays so receiver-side `claim`
    ///      transactions have time to land before a payer can finalize a timed withdrawal (an integrator policy choice).
    struct ChannelConfig {
        address payer;
        address payerAuthorizer;
        address receiver;
        address receiverAuthorizer;
        address token;
        uint40 withdrawDelay;
        bytes32 salt;
    }

    /// @notice Per-channel escrow and claim totals.
    struct ChannelState {
        uint128 balance;
        uint128 totalClaimed;
    }

    /// @notice In-flight timed withdrawal for a channel.
    struct WithdrawalState {
        uint128 amount;
        /// @dev Timestamp (seconds) when the withdrawal was started; zero if none pending.
        uint40 initiatedAt;
    }

    /// @notice Per-receiver, per-token aggregates for settlement sweeps.
    struct ReceiverState {
        uint128 totalClaimed;
        uint128 totalSettled;
    }

    /// @notice Payer-signed authorization data (no signature field here; that lives on `VoucherClaim`).
    struct Voucher {
        ChannelConfig channel;
        uint128 maxClaimableAmount;
    }

    /// @notice One signed voucher row plus the cumulative amount the receiver side is claiming.
    ///
    /// @dev Cumulative `totalClaimed` (not a delta) gives replay protection: replaying an old voucher after it
    ///      was applied is a no-op.
    struct VoucherClaim {
        Voucher voucher;
        bytes signature;
        uint128 totalClaimed;
    }

    // =========================================================================
    // Constants
    // =========================================================================

    uint40 public constant MIN_WITHDRAW_DELAY = 15 minutes;
    uint40 public constant MAX_WITHDRAW_DELAY = 30 days;

    // =========================================================================
    // Constants — EIP-712 Type Hashes
    // =========================================================================

    bytes32 public constant CHANNEL_CONFIG_TYPEHASH = keccak256(
        "ChannelConfig(address payer,address payerAuthorizer,address receiver,address receiverAuthorizer,address token,uint40 withdrawDelay,bytes32 salt)"
    );

    bytes32 public constant VOUCHER_TYPEHASH = keccak256("Voucher(bytes32 channelId,uint128 maxClaimableAmount)");

    bytes32 public constant REFUND_TYPEHASH = keccak256("Refund(bytes32 channelId,uint256 nonce,uint128 amount)");

    /// @dev EIP-712 entry for one row in a signed claim batch (mirrors on-chain `VoucherClaim` fields used for authorization).
    bytes32 public constant CLAIM_ENTRY_TYPEHASH =
        keccak256("ClaimEntry(bytes32 channelId,uint128 maxClaimableAmount,uint128 totalClaimed)");

    /// @dev Full nested EIP-712 type so wallets can render `ClaimEntry[]` for user review.
    bytes32 public constant CLAIM_BATCH_TYPEHASH = keccak256(
        "ClaimBatch(ClaimEntry[] claims)ClaimEntry(bytes32 channelId,uint128 maxClaimableAmount,uint128 totalClaimed)"
    );

    // =========================================================================
    // Storage
    // =========================================================================

    mapping(bytes32 channelId => ChannelState) public channels;

    /// @dev Monotonic sequence per `channelId` for EIP-712 `Refund` replay protection. Incremented inside
    ///      `_executeRefund` **before** the capped refund amount is applied, for **both** `refund` and
    ///      `refundWithSignature`, including when the capped amount is zero (no transfer, no `Refunded` event).
    ///      A direct `refund` therefore advances the nonce and invalidates any presigned `refundWithSignature`
    ///      digest that was bound to the previous nonce; coordinate receiver vs relayer flows off-chain.
    mapping(bytes32 channelId => uint256) public refundNonce;
    mapping(bytes32 channelId => WithdrawalState) public pendingWithdrawals;
    mapping(address receiver => mapping(address token => ReceiverState)) public receivers;

    // =========================================================================
    // Events
    // =========================================================================

    /// @notice Emitted the first time a channel receives escrowed balance.
    event ChannelCreated(bytes32 indexed channelId, ChannelConfig config);

    /// @notice Emitted when unclaimed escrow returns to zero and no claims were recorded.
    event ChannelClosed(bytes32 indexed channelId, ChannelConfig config);

    /// @notice Emitted after a successful deposit into a channel.
    event Deposited(bytes32 indexed channelId, address indexed sender, uint128 amount, uint128 newBalance);

    /// @notice Emitted when the receiver side increases the cumulative claimed amount for a channel.
    event Claimed(bytes32 indexed channelId, address indexed sender, uint128 claimAmount, uint128 newTotalClaimed);

    /// @notice Emitted when claimed funds are transferred to the receiver during settlement.
    event Settled(address indexed receiver, address indexed token, address indexed sender, uint128 amount);

    /// @notice Emitted when escrowed funds are refunded to the payer.
    event Refunded(bytes32 indexed channelId, address indexed sender, uint128 amount);

    /// @notice Emitted when a timed withdrawal is started.
    event WithdrawInitiated(bytes32 indexed channelId, uint128 amount, uint40 finalizeAfter);

    /// @notice Emitted when a timed withdrawal completes and funds move to the payer.
    event WithdrawFinalized(bytes32 indexed channelId, address indexed sender, uint128 amount);

    // =========================================================================
    // Errors
    // =========================================================================

    /// @dev Errors use CapWords naming.

    error InvalidChannel();
    error ZeroDeposit();
    error DepositOverflow();
    error InvalidSignature();
    error NotReceiverAuthorizer();
    error NotAuthorizedToClaim();
    error NotAuthorizedToRefund();
    error ClaimExceedsCeiling();
    error ClaimExceedsBalance();
    error WithdrawalAlreadyPending();
    error WithdrawalNotPending();
    error NotAuthorizedToFinalizeWithdraw();
    error WithdrawDelayNotElapsed();
    error NothingToWithdraw();
    error WithdrawAmountExceedsAvailable();
    error WithdrawDelayOutOfRange();
    error EmptyBatch();
    error DepositCollectionFailed();
    error InvalidCollector();
    error InvalidRefundNonce();
    error ZeroRefund();

    // =========================================================================
    // Constructor
    // =========================================================================

    /// @notice Sets the EIP-712 domain for vouchers, refunds, and claim batches.
    constructor() EIP712("x402 Batch Settlement", "1") {}

    // =========================================================================
    // Deposits
    // =========================================================================

    /// @notice Deposits tokens into a channel using a pluggable collector.
    ///
    /// @dev The collector executes the pull; this function checks the contract's token balance increased
    ///      by `amount` after the call (post-condition) to detect fee-on-transfer or failed pulls.
    ///
    /// @param config The immutable channel configuration.
    /// @param amount The exact amount of tokens to deposit.
    /// @param collector The deposit collector contract address.
    /// @param collectorData Opaque bytes forwarded to the collector (signatures, nonces, etc.).
    function deposit(
        ChannelConfig calldata config,
        uint128 amount,
        address collector,
        bytes calldata collectorData
    ) external nonReentrant {
        if (config.payer == address(0)) revert InvalidChannel();
        if (config.receiver == address(0)) revert InvalidChannel();
        if (config.receiverAuthorizer == address(0)) revert InvalidChannel();
        if (config.token == address(0)) revert InvalidChannel();
        if (config.withdrawDelay < MIN_WITHDRAW_DELAY || config.withdrawDelay > MAX_WITHDRAW_DELAY) {
            revert WithdrawDelayOutOfRange();
        }
        if (amount == 0) revert ZeroDeposit();
        if (collector == address(0)) revert InvalidCollector();

        bytes32 channelId = getChannelId(config);
        ChannelState storage ch = channels[channelId];

        if (amount > type(uint128).max - ch.balance) revert DepositOverflow();
        ch.balance += amount;

        uint256 balBefore = IERC20(config.token).balanceOf(address(this));
        IDepositCollector(collector).collect(config.payer, config.token, amount, channelId, collectorData);
        uint256 balAfter = IERC20(config.token).balanceOf(address(this));
        if (balAfter != balBefore + amount) revert DepositCollectionFailed();

        // First deposit on this channel (escrow was empty before this deposit)
        if (ch.balance == amount && ch.totalClaimed == 0) {
            emit ChannelCreated(channelId, config);
        }
        emit Deposited(channelId, msg.sender, amount, ch.balance);
    }

    // =========================================================================
    // Claim & Settle
    // =========================================================================

    /// @notice Applies a batch of voucher claims and updates channel accounting.
    ///
    /// @param voucherClaims Signed voucher rows with cumulative claim totals.
    ///
    /// @dev For each row, `msg.sender` must be `receiverAuthorizer` or `receiver` for that row's channel.
    ///
    ///      Receiver-side integrators should submit `claim` **promptly** once a payer-signed voucher should bind on-chain
    ///      entitlement: only **recorded** claims (`totalClaimed`) reduce what the payer can withdraw. If the payer
    ///      finalizes a timed withdrawal before this call executes, later `claim` can revert with `ClaimExceedsBalance`.
    function claim(
        VoucherClaim[] calldata voucherClaims
    ) external nonReentrant {
        if (voucherClaims.length == 0) revert EmptyBatch();

        for (uint256 i = 0; i < voucherClaims.length; ++i) {
            ChannelConfig calldata c = voucherClaims[i].voucher.channel;
            if (!_isReceiverSide(msg.sender, c)) {
                revert NotAuthorizedToClaim();
            }
            _processVoucherClaim(voucherClaims[i]);
        }
    }

    /// @notice Applies voucher claims authorized by a `receiverAuthorizer` EIP-712 signature over the batch.
    ///
    /// @param voucherClaims Claim rows for channels sharing the same `receiverAuthorizer`.
    /// @param authorizerSignature Signature from `receiverAuthorizer` over `getClaimBatchDigest(voucherClaims)`.
    ///
    /// @dev Callable by anyone (relay-friendly). All rows must match the same `receiverAuthorizer`.
    ///
    ///      Same liveness consideration as `claim`: relays should submit before payer timed withdrawal drains escrow
    ///      (see `finalizeWithdraw` / `initiateWithdraw`).
    function claimWithSignature(
        VoucherClaim[] calldata voucherClaims,
        bytes calldata authorizerSignature
    ) external nonReentrant {
        if (voucherClaims.length == 0) revert EmptyBatch();

        address authorizer = voucherClaims[0].voucher.channel.receiverAuthorizer;

        bytes32 digest = getClaimBatchDigest(voucherClaims);
        if (!SignatureChecker.isValidSignatureNow(authorizer, digest, authorizerSignature)) {
            revert InvalidSignature();
        }

        for (uint256 i = 0; i < voucherClaims.length; ++i) {
            if (voucherClaims[i].voucher.channel.receiverAuthorizer != authorizer) {
                revert NotReceiverAuthorizer();
            }
            _processVoucherClaim(voucherClaims[i]);
        }
    }

    /// @notice Transfers claimed-but-not-yet-settled tokens to the receiver for a `(receiver, token)` pair.
    ///
    /// @param receiver The receiver address whose pending settlement is swept.
    /// @param token The ERC-20 token to transfer.
    ///
    /// @dev Permissionless: typically called by the receiver or a facilitator.
    function settle(address receiver, address token) external nonReentrant {
        ReceiverState storage rs = receivers[receiver][token];
        uint128 amount = rs.totalClaimed - rs.totalSettled;
        if (amount == 0) return;

        rs.totalSettled = rs.totalClaimed;

        IERC20(token).safeTransfer(receiver, amount);

        emit Settled(receiver, token, msg.sender, amount);
    }

    // =========================================================================
    // Withdrawal Flow
    // =========================================================================

    /// @notice Starts the payer-side timed withdrawal window for unclaimed escrow.
    ///
    /// @param config The channel configuration.
    /// @param amount The gross amount requested; may be capped on finalization.
    ///
    /// @dev Only `config.payer` or `config.payerAuthorizer` may call. Reverts if a withdrawal is already pending.
    ///
    ///      Available liquidity is `ch.balance - ch.totalClaimed` using **only** on-chain `totalClaimed`. Payer-signed
    ///      vouchers that are not yet claimed do **not** reserve funds; receivers relying on voucher value must treat
    ///      inclusion of `claim` during the withdrawal window as an operational requirement (RPC outages, censorship,
    ///      or relay failure can interact badly with `finalizeWithdraw`).
    function initiateWithdraw(ChannelConfig calldata config, uint128 amount) external nonReentrant {
        if (msg.sender != config.payer && msg.sender != config.payerAuthorizer) {
            revert InvalidChannel();
        }
        if (amount == 0) revert NothingToWithdraw();

        bytes32 channelId = getChannelId(config);

        WithdrawalState storage ws = pendingWithdrawals[channelId];
        if (ws.initiatedAt != 0) revert WithdrawalAlreadyPending();

        ChannelState storage ch = channels[channelId];
        uint128 available = ch.balance - ch.totalClaimed;
        if (amount > available) revert WithdrawAmountExceedsAvailable();

        ws.amount = amount;
        ws.initiatedAt = uint40(block.timestamp);

        uint40 finalizeAfter = uint40(block.timestamp) + config.withdrawDelay;
        emit WithdrawInitiated(channelId, amount, finalizeAfter);
    }

    /// @notice Finalizes a pending withdrawal after `withdrawDelay` and sends tokens to the payer.
    ///
    /// @param config The channel configuration.
    ///
    /// @dev Only `config.payer` or `config.payerAuthorizer` may call. Amount may be capped by available escrow.
    ///
    ///      Uses **current** `ch.balance` and `ch.totalClaimed` at execution time. If this transaction executes before a
    ///      competing `claim`, it can reduce escrow such that the claim later reverts with `ClaimExceedsBalance`.
    function finalizeWithdraw(
        ChannelConfig calldata config
    ) external nonReentrant {
        if (msg.sender != config.payer && msg.sender != config.payerAuthorizer) {
            revert NotAuthorizedToFinalizeWithdraw();
        }

        bytes32 channelId = getChannelId(config);
        WithdrawalState storage ws = pendingWithdrawals[channelId];

        if (ws.initiatedAt == 0) revert WithdrawalNotPending();
        if (block.timestamp < uint256(ws.initiatedAt) + uint256(config.withdrawDelay)) {
            revert WithdrawDelayNotElapsed();
        }

        ChannelState storage ch = channels[channelId];
        uint128 available = ch.balance - ch.totalClaimed;
        uint128 withdrawAmount = ws.amount > available ? available : ws.amount;

        ws.amount = 0;
        ws.initiatedAt = 0;
        ch.balance -= withdrawAmount;

        emit WithdrawFinalized(channelId, msg.sender, withdrawAmount);

        if (ch.balance == 0 && ch.totalClaimed == 0) {
            emit ChannelClosed(channelId, config);
        }

        if (withdrawAmount > 0) {
            IERC20(config.token).safeTransfer(config.payer, withdrawAmount);
        }
    }

    /// @notice Cooperative refund of unclaimed escrow to the payer.
    ///
    /// @param config The channel configuration.
    /// @param amount Requested refund; capped to `balance - totalClaimed`. Reverts with `ZeroRefund` if `amount == 0`.
    ///               If the capped amount is zero but `amount > 0`, no token transfer occurs (no `Refunded` event)
    ///               yet `refundNonce` still advances (see `_executeRefund`).
    ///
    /// @dev Only `receiverAuthorizer` or `receiver` may call. Shares `_executeRefund` with `refundWithSignature`, so
    ///      every successful call advances `refundNonce` for the channel. Any in-flight EIP-712 `Refund` signature
    ///      produced for the previous nonce becomes unusable; relayers and authorizers should expect re-signing if
    ///      direct refunds race ahead of relayed `refundWithSignature` submissions.
    function refund(ChannelConfig calldata config, uint128 amount) external nonReentrant {
        if (!_isReceiverSide(msg.sender, config)) {
            revert NotAuthorizedToRefund();
        }
        _executeRefund(config, amount);
    }

    /// @notice Refunds unclaimed escrow to the payer using an EIP-712 `Refund` signature from `receiverAuthorizer`.
    ///
    /// @param config The channel configuration.
    /// @param amount The amount in the signature; capped like `refund`. If the capped amount is zero, no transfer
    ///               and no `Refunded` event, but `refundNonce` still advances once `_executeRefund` runs.
    /// @param nonce Must equal `refundNonce(channelId)` at entry; `_executeRefund` increments it (same as `refund`).
    /// @param receiverAuthorizerSignature EIP-712 signature from `receiverAuthorizer` over the refund digest.
    ///
    /// @dev Callable by anyone (relay-friendly). A prior direct `refund` on the same channel can advance the nonce
    ///      and cause `InvalidRefundNonce` here until the authorizer signs at the new nonce.
    function refundWithSignature(
        ChannelConfig calldata config,
        uint128 amount,
        uint256 nonce,
        bytes calldata receiverAuthorizerSignature
    ) external nonReentrant {
        bytes32 channelId = getChannelId(config);
        if (nonce != refundNonce[channelId]) revert InvalidRefundNonce();
        bytes32 digest = getRefundDigest(channelId, nonce, amount);
        if (!SignatureChecker.isValidSignatureNow(config.receiverAuthorizer, digest, receiverAuthorizerSignature)) {
            revert InvalidSignature();
        }
        _executeRefund(config, amount);
    }

    // =========================================================================
    // View Functions
    // =========================================================================

    /// @notice Returns the canonical `channelId` for a channel configuration.
    ///
    /// @param config The channel configuration to hash.
    ///
    /// @return The EIP-712 typed-data hash of `ChannelConfig`, bound to this contract's domain
    ///         (chainId + verifyingContract). Identical configs on different chains or different
    ///         deployments produce different ids, preventing cross-chain channel-state collision.
    function getChannelId(
        ChannelConfig calldata config
    ) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(CHANNEL_CONFIG_TYPEHASH, config)));
    }

    /// @notice EIP-712 digest for a `Voucher` with the given `channelId` and `maxClaimableAmount`.
    ///
    /// @param channelId The channel identifier.
    /// @param maxClaimableAmount The ceiling encoded in the voucher.
    ///
    /// @return The typed data hash signers use for payer authorization.
    function getVoucherDigest(bytes32 channelId, uint128 maxClaimableAmount) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(VOUCHER_TYPEHASH, channelId, maxClaimableAmount)));
    }

    /// @notice EIP-712 digest for a cooperative `Refund` authorization.
    ///
    /// @param channelId The channel identifier.
    /// @param nonce The refund nonce; must equal on-chain `refundNonce(channelId)` when `refundWithSignature` runs.
    /// @param amount The signed refund amount.
    ///
    /// @return The typed data hash for `receiverAuthorizer` to sign.
    ///
    /// @dev Off-chain signers should use the current `refundNonce(channelId)` as `nonce`. A successful direct `refund`
    ///      on the same channel advances that nonce and invalidates digests signed for the old value until re-signed.
    function getRefundDigest(bytes32 channelId, uint256 nonce, uint128 amount) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(REFUND_TYPEHASH, channelId, nonce, amount)));
    }

    /// @notice EIP-712 digest for the signed `ClaimBatch` (used by `claimWithSignature` and off-chain signing).
    ///
    /// @param voucherClaims The claim rows hashed into the batch.
    ///
    /// @return The typed data hash `receiverAuthorizer` signs for the batch.
    ///
    /// @dev `claim` and `claimWithSignature` revert with `EmptyBatch()` when `voucherClaims.length == 0`, so they
    ///      never call this with an empty array. The digest for `length == 0` is still defined (`entriesRoot = keccak256("")`)
    ///      for `eth_call` and off-chain tools to match this contract’s EIP-712 encoding without duplicating hashing logic.
    function getClaimBatchDigest(
        VoucherClaim[] calldata voucherClaims
    ) public view returns (bytes32) {
        uint256 n = voucherClaims.length;
        bytes32 entriesRoot;
        if (n == 0) {
            entriesRoot = keccak256("");
        } else {
            bytes32[] memory entryHashes = new bytes32[](n);
            for (uint256 i = 0; i < n; ++i) {
                bytes32 cid = getChannelId(voucherClaims[i].voucher.channel);
                entryHashes[i] = keccak256(
                    abi.encode(
                        CLAIM_ENTRY_TYPEHASH,
                        cid,
                        voucherClaims[i].voucher.maxClaimableAmount,
                        voucherClaims[i].totalClaimed
                    )
                );
            }
            entriesRoot = keccak256(abi.encodePacked(entryHashes));
        }
        return _hashTypedDataV4(keccak256(abi.encode(CLAIM_BATCH_TYPEHASH, entriesRoot)));
    }

    // =========================================================================
    // Internal Helpers
    // =========================================================================

    /// @dev True if `sender` may submit a claim for this channel (`receiver` or `receiverAuthorizer`).
    function _isReceiverSide(address sender, ChannelConfig calldata config) internal pure returns (bool) {
        return sender == config.receiverAuthorizer || sender == config.receiver;
    }

    /// @dev Validates the payer signature, updates `channels` and `receivers`, and emits `Claimed`.
    function _processVoucherClaim(
        VoucherClaim calldata vc
    ) internal {
        bytes32 channelId = getChannelId(vc.voucher.channel);
        ChannelState storage ch = channels[channelId];

        if (vc.totalClaimed <= ch.totalClaimed) return;
        if (vc.totalClaimed > vc.voucher.maxClaimableAmount) {
            revert ClaimExceedsCeiling();
        }
        if (vc.totalClaimed > ch.balance) revert ClaimExceedsBalance();

        bytes32 digest = getVoucherDigest(channelId, vc.voucher.maxClaimableAmount);

        address payerAuth = vc.voucher.channel.payerAuthorizer;
        if (payerAuth != address(0)) {
            address recovered = ECDSA.recoverCalldata(digest, vc.signature);
            if (recovered != payerAuth) revert InvalidSignature();
        } else {
            if (!SignatureChecker.isValidSignatureNow(vc.voucher.channel.payer, digest, vc.signature)) {
                revert InvalidSignature();
            }
        }

        uint128 claimDelta = vc.totalClaimed - ch.totalClaimed;
        ch.totalClaimed = vc.totalClaimed;
        receivers[vc.voucher.channel.receiver][vc.voucher.channel.token].totalClaimed += claimDelta;

        emit Claimed(channelId, msg.sender, claimDelta, vc.totalClaimed);
    }

    /// @dev Caps refund to available unclaimed escrow, reduces or clears any pending withdrawal, transfers to payer.
    ///
    /// @dev Increments `refundNonce[channelId]` **first** (before computing the capped refund). That applies to both
    ///      `refund` and `refundWithSignature`, including when `amount > 0` but available unclaimed escrow is zero
    ///      (no transfer, no `Refunded` event). This ties replay protection for signed refunds to the same counter
    ///      used whenever the receiver side executes a cooperative refund through this helper. `amount == 0` reverts
    ///      with `ZeroRefund` and does not bump the nonce.
    function _executeRefund(ChannelConfig calldata config, uint128 amount) internal {
        if (amount == 0) revert ZeroRefund();

        bytes32 channelId = getChannelId(config);
        unchecked {
            refundNonce[channelId]++;
        }

        ChannelState storage ch = channels[channelId];
        uint128 available = ch.balance - ch.totalClaimed;
        uint128 refundAmount = amount > available ? available : amount;
        if (refundAmount == 0) return;

        ch.balance -= refundAmount;

        WithdrawalState storage pws = pendingWithdrawals[channelId];
        if (pws.initiatedAt != 0) {
            if (refundAmount >= pws.amount) {
                pws.amount = 0;
                pws.initiatedAt = 0;
            } else {
                pws.amount -= refundAmount;
            }
        }

        emit Refunded(channelId, msg.sender, refundAmount);

        if (ch.balance == 0 && ch.totalClaimed == 0) {
            emit ChannelClosed(channelId, config);
        }

        IERC20(config.token).safeTransfer(config.payer, refundAmount);
    }
}
