// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {ISignatureTransfer} from "./interfaces/ISignatureTransfer.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";

/**
 * @title x402SwapSettler
 * @notice Reference settler for the x402 `swap-settlement` extension: atomically acquires a
 *         payer's input asset, swaps it through a facilitator-whitelisted swap target, and
 *         delivers the exact required output asset and amount to `payTo` in one transaction.
 *
 * @dev Settlement invariants (normative, see specs/extensions/swap_settlement.md):
 *      - Either exactly `outputAmount` of `outputAsset` reaches `payTo`, or the whole
 *        transaction reverts. Output is measured as a balance delta within the transaction,
 *        independent of any guarantees from the routing provider.
 *      - The payer's exposure is bounded by `maxAmountIn` of the input asset. All surplus —
 *        unspent input asset and output asset in excess of `outputAmount` — is refunded to the
 *        payer within the same transaction.
 *      - The facilitator's compensation is exactly `facilitatorFee` (quoted, in the input
 *        asset) and is paid only on success.
 *      - Each quote settles at most once: a consumed set keyed by `quoteIdHash` reverts on
 *        reuse, layered on top of method-native replay protection (Permit2 nonces, EIP-3009
 *        authorizer state).
 *
 *      Swap calldata (`routeData`) is constructed server-side by the facilitator and executed
 *      against a whitelisted `swapTarget`; clients can never inject execution calldata. The
 *      whitelist MUST only ever contain swap router/aggregator entrypoints — never token
 *      contracts and never contracts that can pull arbitrary approvals — because `routeData`
 *      is an arbitrary call from the settler's context while it holds a live approval.
 *
 *      Settlement entrypoints are restricted to facilitator-authorized callers so that quote
 *      parameters (which are trusted inputs signed off-chain between payer and facilitator)
 *      cannot be replayed by third parties with hostile `routeData`.
 *
 *      Uses {ReentrancyGuardTransient} (EIP-1153); deploy only on chains with transient
 *      storage support.
 *
 * @author x402 Protocol
 */
contract x402SwapSettler is EIP712, Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @notice EIP-712 witness type string for Permit2 `PermitWitnessTransferFrom` (spec-normative)
    string public constant WITNESS_TYPE_STRING =
        "SwapWitness witness)SwapWitness(bytes32 quoteIdHash,bytes32 requirementsHash,address payTo,address outputAsset,uint256 outputAmount)TokenPermissions(address token,uint256 amount)";

    /// @notice EIP-712 typehash for the SwapWitness struct
    bytes32 public constant WITNESS_TYPEHASH = keccak256(
        "SwapWitness(bytes32 quoteIdHash,bytes32 requirementsHash,address payTo,address outputAsset,uint256 outputAmount)"
    );

    /// @notice EIP-712 typehash for the SwapSettlementIntent struct (allowance method, spec-normative)
    bytes32 public constant INTENT_TYPEHASH = keccak256(
        "SwapSettlementIntent(bytes32 quoteIdHash,bytes32 requirementsHash,address inputAsset,uint256 maxAmountIn,uint256 deadline)"
    );

    /// @notice The Permit2 contract address (set once at construction, immutable)
    ISignatureTransfer public immutable PERMIT2;

    /// @notice Addresses authorized to call the settlement entrypoints
    mapping(address facilitator => bool allowed) public facilitators;

    /// @notice Whitelisted swap targets `routeData` may be executed against
    /// @dev MUST only contain swap router/aggregator entrypoints — never token contracts
    mapping(address target => bool allowed) public swapTargets;

    /// @notice Consumed set keyed by `quoteIdHash`; reverts on reuse (spec replay layer 1)
    mapping(bytes32 quoteIdHash => bool consumed) public consumedQuotes;

    /**
     * @notice Facilitator quote commitment executed by this settler (spec-normative field order)
     * @param quoteIdHash keccak256(utf8(quoteId))
     * @param requirementsHash keccak256(jcs(paymentRequirements)) of the selected accepts[] entry
     * @param payer The token owner whose input asset is acquired
     * @param inputAsset The asset the payer holds and authorized
     * @param maxAmountIn Maximum input-asset amount acquirable from the payer (fees inclusive)
     * @param facilitatorFee Facilitator compensation in the input asset (must be < maxAmountIn)
     * @param outputAsset The asset required by the payment requirements
     * @param outputAmount The exact amount of outputAsset that must reach payTo
     * @param payTo The payment recipient from the payment requirements
     * @param swapTarget Whitelisted contract `routeData` is executed against
     * @param deadline Timestamp after which this quote can no longer settle
     */
    struct Quote {
        bytes32 quoteIdHash;
        bytes32 requirementsHash;
        address payer;
        address inputAsset;
        uint256 maxAmountIn;
        uint256 facilitatorFee;
        address outputAsset;
        uint256 outputAmount;
        address payTo;
        address swapTarget;
        uint256 deadline;
    }

    /**
     * @notice EIP-3009 ReceiveWithAuthorization parameters
     * @dev `to` is implicitly this settler and `value` is implicitly `maxAmountIn`; the 32-byte
     *      nonce is derived on-chain as keccak256(abi.encode(quoteIdHash, requirementsHash))
     *      (spec-normative), binding the token signature to exactly one quote.
     * @param validAfter Earliest timestamp the authorization is valid
     * @param validBefore Latest timestamp the authorization is valid
     * @param signature The payer's EIP-3009 signature
     */
    struct EIP3009Auth {
        uint256 validAfter;
        uint256 validBefore;
        bytes signature;
    }

    /**
     * @notice Permit2 PermitWitnessTransferFrom parameters
     * @dev The permitted token/amount are implicitly (inputAsset, maxAmountIn) and the witness
     *      is reconstructed on-chain from the quote, so a signature is only valid for the exact
     *      quoted payTo / outputAsset / outputAmount / requirements.
     * @param nonce Permit2 unordered nonce
     * @param deadline Permit2 signature deadline
     * @param signature The payer's Permit2 signature (ECDSA or EIP-1271)
     */
    struct Permit2WitnessAuth {
        uint256 nonce;
        uint256 deadline;
        bytes signature;
    }

    /**
     * @notice EIP-2612 permit parameters grouped to reduce stack depth
     * @param value Approval amount (must be >= maxAmountIn)
     * @param deadline Permit expiration timestamp
     * @param r ECDSA signature parameter
     * @param s ECDSA signature parameter
     * @param v ECDSA signature parameter
     */
    struct EIP2612Permit {
        uint256 value;
        uint256 deadline;
        bytes32 r;
        bytes32 s;
        uint8 v;
    }

    /**
     * @notice EIP-712 SwapSettlementIntent authorization (allowance method)
     * @param deadline Intent expiration timestamp
     * @param signature The payer's signature (ECDSA, or EIP-1271 when the payer has code)
     */
    struct IntentAuth {
        uint256 deadline;
        bytes signature;
    }

    /// @notice Emitted on every successful settlement (spec-normative parameter order)
    /// @param quoteIdHash keccak256(utf8(quoteId)) of the settled quote
    /// @param payer The token owner whose input asset was acquired
    /// @param inputAsset The asset acquired from the payer
    /// @param amountIn Input asset effectively taken from the payer (swap spend + facilitatorFee)
    /// @param outputAsset The asset delivered to payTo
    /// @param amount The exact output amount delivered to payTo
    /// @param payTo The payment recipient
    /// @param facilitatorFee Compensation paid to the calling facilitator, in the input asset
    event SwapSettled(
        bytes32 indexed quoteIdHash,
        address indexed payer,
        address inputAsset,
        uint256 amountIn,
        address outputAsset,
        uint256 amount,
        address payTo,
        uint256 facilitatorFee
    );

    /// @notice Emitted when a facilitator authorization changes
    event FacilitatorUpdated(address indexed facilitator, bool allowed);

    /// @notice Emitted when a swap target whitelist entry changes
    event SwapTargetUpdated(address indexed target, bool allowed);

    /// @notice Emitted when EIP-2612 permit() reverts with an Error(string) reason
    event EIP2612PermitFailedWithReason(address indexed token, address indexed owner, string reason);

    /// @notice Emitted when EIP-2612 permit() reverts with a Panic(uint256) code
    event EIP2612PermitFailedWithPanic(address indexed token, address indexed owner, uint256 errorCode);

    /// @notice Emitted when EIP-2612 permit() reverts with a custom error or empty data
    event EIP2612PermitFailedWithData(address indexed token, address indexed owner, bytes data);

    /// @notice Thrown when Permit2 address is zero
    error InvalidPermit2Address();

    /// @notice Thrown when the caller is not an authorized facilitator
    error NotFacilitator();

    /// @notice Thrown when a quoteIdHash was already settled
    error QuoteConsumed();

    /// @notice Thrown when the quote deadline has passed
    error QuoteDeadlineExpired();

    /// @notice Thrown when the quote's swap target is not whitelisted
    error SwapTargetNotAllowed(address target);

    /// @notice Thrown on malformed quotes (zero fields, fee >= maxAmountIn, inputAsset == outputAsset)
    error InvalidQuote();

    /// @notice Thrown when the swap target call reverts
    error SwapCallFailed(bytes returnData);

    /// @notice Thrown when the swap yields less output than the quote requires
    error InsufficientOutput(uint256 received, uint256 required);

    /// @notice Thrown when the EIP-2612 permit value is below maxAmountIn
    error PermitValueTooLow();

    /// @notice Thrown when the SwapSettlementIntent signature does not validate for the payer
    error InvalidIntentSignature();

    /// @notice Thrown when the SwapSettlementIntent deadline has passed
    error IntentDeadlineExpired();

    modifier onlyFacilitator() {
        if (!facilitators[msg.sender]) revert NotFacilitator();
        _;
    }

    /**
     * @notice Constructs the settler with the Permit2 contract address and initial owner
     * @param _permit2 Address of the Permit2 contract (canonical on all EVM chains)
     * @param _owner Initial owner managing the facilitator and swap-target sets
     * @dev The EIP-712 domain {name: "x402 swap-settlement", version: "1"} is spec-normative;
     *      binding intents to this settler's address scopes them to a single deployment.
     *      Using identical constructor arguments on every chain keeps the initCode identical,
     *      preserving CREATE2 address determinism.
     */
    constructor(
        address _permit2,
        address _owner
    ) EIP712("x402 swap-settlement", "1") Ownable(_owner) {
        if (_permit2 == address(0)) revert InvalidPermit2Address();
        PERMIT2 = ISignatureTransfer(_permit2);
    }

    // =========================================================================
    // Admin
    // =========================================================================

    /**
     * @notice Authorizes or revokes a settlement caller
     * @param facilitator The facilitator transaction-sender address
     * @param allowed Whether the address may call settlement entrypoints
     */
    function setFacilitator(address facilitator, bool allowed) external onlyOwner {
        facilitators[facilitator] = allowed;
        emit FacilitatorUpdated(facilitator, allowed);
    }

    /**
     * @notice Whitelists or removes a swap target
     * @param target The swap router/aggregator entrypoint
     * @param allowed Whether `routeData` may be executed against it
     * @dev NEVER whitelist token contracts or any contract able to move third-party approvals:
     *      `routeData` is executed from the settler's context while it holds a live approval,
     *      so a whitelisted token would turn settlement into an approval-drain primitive.
     */
    function setSwapTarget(address target, bool allowed) external onlyOwner {
        swapTargets[target] = allowed;
        emit SwapTargetUpdated(target, allowed);
    }

    // =========================================================================
    // Settlement entrypoints
    // =========================================================================

    /**
     * @notice Settles a quote by acquiring the input asset via EIP-3009 receiveWithAuthorization
     * @dev The authorization nonce is derived on-chain as
     *      keccak256(abi.encode(quoteIdHash, requirementsHash)) — spec-normative — so the token
     *      signature is bound to exactly one quote. receiveWithAuthorization requires the
     *      caller to be the payee, making this settler the sole valid submitter.
     * @param q The facilitator quote
     * @param a The EIP-3009 authorization parameters
     * @param routeData Facilitator-built calldata executed against q.swapTarget
     */
    function settleWith3009(
        Quote calldata q,
        EIP3009Auth calldata a,
        bytes calldata routeData
    ) external onlyFacilitator nonReentrant {
        (uint256 inBefore, uint256 outBefore) = _validateAndConsume(q);
        bytes32 nonce = keccak256(abi.encode(q.quoteIdHash, q.requirementsHash));
        IERC3009(q.inputAsset).receiveWithAuthorization(
            q.payer, address(this), q.maxAmountIn, a.validAfter, a.validBefore, nonce, a.signature
        );
        _swapAndDistribute(q, inBefore, outBefore, routeData);
    }

    /**
     * @notice Settles a quote by acquiring the input asset via Permit2 PermitWitnessTransferFrom
     * @dev The SwapWitness is reconstructed from the quote, so the payer's signature is invalid
     *      for any other quote, recipient, output asset, or amount. Permit2 verifies both ECDSA
     *      and EIP-1271 signatures, supporting smart-account payers.
     * @param q The facilitator quote
     * @param a The Permit2 witness authorization parameters
     * @param routeData Facilitator-built calldata executed against q.swapTarget
     */
    function settleWithPermit2(
        Quote calldata q,
        Permit2WitnessAuth calldata a,
        bytes calldata routeData
    ) external onlyFacilitator nonReentrant {
        (uint256 inBefore, uint256 outBefore) = _validateAndConsume(q);
        _acquireViaPermit2(q, a);
        _swapAndDistribute(q, inBefore, outBefore, routeData);
    }

    /**
     * @notice Settles a quote using an EIP-2612 permit as gasless approval bootstrap
     * @dev Two spec variants, discriminated by `a.signature.length`:
     *      - Permit2 bootstrap (a.signature non-empty, RECOMMENDED): the permit approves the
     *        canonical Permit2 contract, then acquisition runs through the witness-bound
     *        Permit2 path — full quote binding is retained.
     *      - Direct settler (a.signature empty): the permit approves this settler and funds are
     *        pulled via transferFrom; binding is enforced off-chain by the facilitator per the
     *        spec trust model. `a.nonce`/`a.deadline` are unused in this variant.
     *      Permit front-running is tolerated (spec MUST): if permit() reverts but sufficient
     *      allowance already exists, settlement proceeds; failures surface as events.
     * @param q The facilitator quote
     * @param p The EIP-2612 permit parameters (p.value must be >= q.maxAmountIn)
     * @param a The Permit2 witness authorization (empty signature selects the direct variant)
     * @param routeData Facilitator-built calldata executed against q.swapTarget
     */
    function settleWith2612(
        Quote calldata q,
        EIP2612Permit calldata p,
        Permit2WitnessAuth calldata a,
        bytes calldata routeData
    ) external onlyFacilitator nonReentrant {
        (uint256 inBefore, uint256 outBefore) = _validateAndConsume(q);
        if (p.value < q.maxAmountIn) revert PermitValueTooLow();
        if (a.signature.length > 0) {
            _tryPermit(q.inputAsset, q.payer, address(PERMIT2), p);
            _acquireViaPermit2(q, a);
        } else {
            _tryPermit(q.inputAsset, q.payer, address(this), p);
            IERC20(q.inputAsset).safeTransferFrom(q.payer, address(this), q.maxAmountIn);
        }
        _swapAndDistribute(q, inBefore, outBefore, routeData);
    }

    /**
     * @notice Settles a quote against a pre-existing direct ERC-20 allowance to this settler
     * @dev The payer authenticates the payment intent by signing an EIP-712
     *      SwapSettlementIntent over the quote binding; ECDSA and EIP-1271 signatures are
     *      accepted. Funds are pulled via transferFrom, bounded by maxAmountIn.
     * @param q The facilitator quote
     * @param a The intent authorization parameters
     * @param routeData Facilitator-built calldata executed against q.swapTarget
     */
    function settleWithAllowance(
        Quote calldata q,
        IntentAuth calldata a,
        bytes calldata routeData
    ) external onlyFacilitator nonReentrant {
        (uint256 inBefore, uint256 outBefore) = _validateAndConsume(q);
        if (block.timestamp > a.deadline) revert IntentDeadlineExpired();
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(INTENT_TYPEHASH, q.quoteIdHash, q.requirementsHash, q.inputAsset, q.maxAmountIn, a.deadline)
            )
        );
        if (!SignatureChecker.isValidSignatureNow(q.payer, digest, a.signature)) revert InvalidIntentSignature();
        IERC20(q.inputAsset).safeTransferFrom(q.payer, address(this), q.maxAmountIn);
        _swapAndDistribute(q, inBefore, outBefore, routeData);
    }

    // =========================================================================
    // Internals
    // =========================================================================

    /**
     * @notice Validates quote parameters and marks the quote consumed
     * @dev All state writes happen before any external call (checks-effects-interactions);
     *      the consumed flag naturally rolls back if settlement later reverts.
     * @return inBefore Input-asset balance snapshot (dust-tolerant delta accounting)
     * @return outBefore Output-asset balance snapshot
     */
    function _validateAndConsume(
        Quote calldata q
    ) internal returns (uint256 inBefore, uint256 outBefore) {
        if (block.timestamp > q.deadline) revert QuoteDeadlineExpired();
        if (consumedQuotes[q.quoteIdHash]) revert QuoteConsumed();
        if (!swapTargets[q.swapTarget]) revert SwapTargetNotAllowed(q.swapTarget);
        if (
            q.payer == address(0) || q.payTo == address(0) || q.inputAsset == address(0)
                || q.outputAsset == address(0) || q.maxAmountIn == 0 || q.outputAmount == 0
                || q.facilitatorFee >= q.maxAmountIn || q.inputAsset == q.outputAsset
        ) revert InvalidQuote();

        consumedQuotes[q.quoteIdHash] = true;

        inBefore = IERC20(q.inputAsset).balanceOf(address(this));
        outBefore = IERC20(q.outputAsset).balanceOf(address(this));
    }

    /**
     * @notice Acquires q.maxAmountIn of the input asset via Permit2 with the SwapWitness bound
     */
    function _acquireViaPermit2(Quote calldata q, Permit2WitnessAuth calldata a) internal {
        bytes32 witnessHash = keccak256(
            abi.encode(WITNESS_TYPEHASH, q.quoteIdHash, q.requirementsHash, q.payTo, q.outputAsset, q.outputAmount)
        );
        PERMIT2.permitWitnessTransferFrom(
            ISignatureTransfer.PermitTransferFrom({
                permitted: ISignatureTransfer.TokenPermissions({token: q.inputAsset, amount: q.maxAmountIn}),
                nonce: a.nonce,
                deadline: a.deadline
            }),
            ISignatureTransfer.SignatureTransferDetails({to: address(this), requestedAmount: q.maxAmountIn}),
            q.payer,
            witnessHash,
            WITNESS_TYPE_STRING,
            a.signature
        );
    }

    /**
     * @notice Attempts an EIP-2612 permit without reverting on failure
     * @dev The permit call must not revert settlement because the approval might already exist
     *      (permit front-running, spec MUST-tolerate) — if the resulting allowance is
     *      insufficient the subsequent pull reverts anyway.
     */
    function _tryPermit(address token, address owner, address spender, EIP2612Permit calldata p) internal {
        try IERC20Permit(token).permit(owner, spender, p.value, p.deadline, p.v, p.r, p.s) {
            // EIP-2612 permit succeeded
        } catch Error(string memory reason) {
            emit EIP2612PermitFailedWithReason(token, owner, reason);
        } catch Panic(uint256 errorCode) {
            emit EIP2612PermitFailedWithPanic(token, owner, errorCode);
        } catch (bytes memory data) {
            emit EIP2612PermitFailedWithData(token, owner, data);
        }
    }

    /**
     * @notice Executes the swap and distributes proceeds (spec Settlement Logic steps 2–6)
     * @dev The swap may spend at most `maxAmountIn - facilitatorFee` (the approval cap), so the
     *      quoted fee can never be consumed by the route. Output is measured as a balance
     *      delta; exactly `outputAmount` goes to `payTo`, every surplus goes back to the payer,
     *      and the fee is paid to the calling facilitator only after the output check passes.
     */
    function _swapAndDistribute(
        Quote calldata q,
        uint256 inBefore,
        uint256 outBefore,
        bytes calldata routeData
    ) internal {
        IERC20(q.inputAsset).forceApprove(q.swapTarget, q.maxAmountIn - q.facilitatorFee);
        {
            (bool ok, bytes memory ret) = q.swapTarget.call(routeData);
            if (!ok) revert SwapCallFailed(ret);
        }
        IERC20(q.inputAsset).forceApprove(q.swapTarget, 0);

        {
            uint256 outDelta = IERC20(q.outputAsset).balanceOf(address(this)) - outBefore;
            if (outDelta < q.outputAmount) revert InsufficientOutput(outDelta, q.outputAmount);

            IERC20(q.outputAsset).safeTransfer(q.payTo, q.outputAmount);
            uint256 outSurplus = outDelta - q.outputAmount;
            if (outSurplus > 0) IERC20(q.outputAsset).safeTransfer(q.payer, outSurplus);
        }

        // inHeld >= facilitatorFee because the swap could spend at most maxAmountIn - fee.
        uint256 inHeld = IERC20(q.inputAsset).balanceOf(address(this)) - inBefore;
        uint256 inRefund = inHeld - q.facilitatorFee;
        if (inRefund > 0) IERC20(q.inputAsset).safeTransfer(q.payer, inRefund);
        if (q.facilitatorFee > 0) IERC20(q.inputAsset).safeTransfer(msg.sender, q.facilitatorFee);

        // amountIn = input consumed by the route + fee; clamped in case the route donated input tokens.
        _emitSettled(q, inHeld >= q.maxAmountIn ? q.facilitatorFee : q.maxAmountIn - inHeld + q.facilitatorFee);
    }

    /// @dev Separate helper keeps the 8-field event emission out of _swapAndDistribute's stack frame.
    function _emitSettled(Quote calldata q, uint256 amountIn) internal {
        emit SwapSettled(
            q.quoteIdHash, q.payer, q.inputAsset, amountIn, q.outputAsset, q.outputAmount, q.payTo, q.facilitatorFee
        );
    }
}
