// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/// @dev Hedera Account Service system contract (HIP-632), at 0x16a.
interface IHederaAccountService {
    function isAuthorized(address account, bytes memory message, bytes memory signatureBlob)
        external
        returns (int64 responseCode, bool authorized);
}

/// @dev Hedera Token Service system contract, at 0x167. Only what an HBAR transfer needs.
interface IHederaTokenService {
    struct AccountAmount {
        address accountID;
        int64 amount;
        bool isApproval;
    }

    struct TransferList {
        AccountAmount[] transfers;
    }

    struct NftTransfer {
        address senderAccountID;
        address receiverAccountID;
        int64 serialNumber;
        bool isApproval;
    }

    struct TokenTransferList {
        address token;
        AccountAmount[] transfers;
        NftTransfer[] nftTransfers;
    }

    function cryptoTransfer(TransferList memory transferList, TokenTransferList[] memory tokenTransfers)
        external
        returns (int64 responseCode);
}

/**
 * @title SignedOwnerExecutor
 * @notice INTEGRATION-TEST CONTRACT ONLY. NOT AUDITED. DO NOT USE IN PRODUCTION.
 *
 *         NOT REPRESENTATIVE OF A REAL EXECUTOR. The spec defines no canonical executor, and this
 *         is not one, a reference, or a template: it is the smallest contract that exercises an
 *         owner signature and an allowance, and it omits what a real one needs (EIP-712 domain
 *         separation, policy and recipient limits, token support, key types other than a single
 *         ECDSA key).
 *
 *         A deliberately small `ITransferExecutor` that exists so the facilitator's simulation
 *         and settlement can be exercised against the two things the behavioural mock cannot
 *         show: an owner signature checked on chain against the owner account's CURRENT key,
 *         and funds that move through a HIP-336 allowance instead of the executor's own balance.
 *
 *         `from` is an owner account that granted this contract an HBAR allowance. The owner
 *         signs a digest of the exact transfer; the contract builds the same digest from its
 *         arguments and asks HAS `isAuthorized(from, digest, signatureMap)`. Hedera looks up the
 *         account's live key, so a key rotation invalidates a signature made with the old key,
 *         even though the account's EVM alias still names the old key.
 *
 * authorization = abi.encode(uint256 validBefore, bytes32 nonce, bytes pubKey, bytes signature)
 *
 *   pubKey    = the signer's 33-byte compressed secp256k1 key.
 *   signature = 64 bytes, r || s, over keccak256(digest) (what the Hiero SDK's ECDSA `sign` makes).
 *   digest    = abi.encode(DOMAIN, from, asset, to, amount, validBefore, nonce, chainid, this)
 *
 * HBAR only. Single ECDSA key owners only.
 */
contract SignedOwnerExecutor {
    /// HAS system contract.
    address public constant HAS = address(0x16a);
    /// HTS system contract.
    address public constant HTS = address(0x167);
    int64 private constant SUCCESS = 22;

    /// Domain tag of the signed digest.
    bytes32 public constant DOMAIN = "SignedOwnerExecutor.v1";

    /// Authorizations consumed by a successful call, by `(from, nonce)`.
    mapping(bytes32 => bool) public consumed;

    event Executed(address indexed from, address indexed to, uint256 amount, bytes32 nonce);

    /// The digest the owner signs for one transfer.
    function digestOf(
        address from,
        address asset,
        address to,
        uint256 amount,
        uint256 validBefore,
        bytes32 nonce
    ) public view returns (bytes memory) {
        return abi.encode(DOMAIN, from, asset, to, amount, validBefore, nonce, block.chainid, address(this));
    }

    function executeTransfer(address from, address asset, address to, uint256 amount, bytes calldata authorization)
        external
    {
        require(asset == address(0), "HBAR only");
        require(amount <= uint256(uint64(type(int64).max)), "amount too large");

        bytes32 nonce = _verifyOwner(from, asset, to, amount, authorization);
        consumed[keccak256(abi.encode(from, nonce))] = true;
        _spendAllowance(from, to, int64(uint64(amount)));
        emit Executed(from, to, amount, nonce);
    }

    /// Checks expiry, single use and the owner's signature; returns the authorization's nonce.
    function _verifyOwner(address from, address asset, address to, uint256 amount, bytes calldata authorization)
        private
        returns (bytes32 nonce)
    {
        uint256 validBefore;
        bytes memory pubKey;
        bytes memory signature;
        (validBefore, nonce, pubKey, signature) = abi.decode(authorization, (uint256, bytes32, bytes, bytes));
        require(block.timestamp <= validBefore, "authorization expired");
        require(!consumed[keccak256(abi.encode(from, nonce))], "authorization consumed");
        require(pubKey.length == 33, "pubKey must be compressed");
        require(signature.length == 64, "signature must be r||s");

        // A CALL, not a STATICCALL: the node halts `isAuthorized` in a static frame.
        (bool ok, bytes memory ret) = HAS.call(
            abi.encodeCall(
                IHederaAccountService.isAuthorized,
                (from, digestOf(from, asset, to, amount, validBefore, nonce), _signatureMap(pubKey, signature))
            )
        );
        require(ok && ret.length == 64, "isAuthorized call failed");
        (int64 code, bool authorized) = abi.decode(ret, (int64, bool));
        require(code == SUCCESS && authorized, "owner signature not authorized by the account's current key");
    }

    /// Moves HBAR from `from` to `to`, spending the allowance `from` granted this contract.
    function _spendAllowance(address from, address to, int64 amount) private {
        IHederaTokenService.AccountAmount[] memory legs = new IHederaTokenService.AccountAmount[](2);
        legs[0] = IHederaTokenService.AccountAmount({accountID: from, amount: -amount, isApproval: true});
        legs[1] = IHederaTokenService.AccountAmount({accountID: to, amount: amount, isApproval: false});
        (bool ok, bytes memory ret) = HTS.call(
            abi.encodeCall(
                IHederaTokenService.cryptoTransfer,
                (IHederaTokenService.TransferList(legs), new IHederaTokenService.TokenTransferList[](0))
            )
        );
        require(ok && ret.length >= 32 && abi.decode(ret, (int64)) == SUCCESS, "allowance transfer failed");
    }

    /// protobuf `SignatureMap { sigPair: [ { pubKeyPrefix: pubKey, ECDSA_secp256k1: signature } ] }`.
    function _signatureMap(bytes memory pubKey, bytes memory signature) private pure returns (bytes memory) {
        // SignaturePair: field 1 (pubKeyPrefix) tag 0x0a, field 6 (ECDSA_secp256k1) tag 0x32.
        bytes memory pair = abi.encodePacked(hex"0a", uint8(pubKey.length), pubKey, hex"32", uint8(signature.length), signature);
        // SignatureMap: field 1 (sigPair) tag 0x0a.
        return abi.encodePacked(hex"0a", uint8(pair.length), pair);
    }
}
