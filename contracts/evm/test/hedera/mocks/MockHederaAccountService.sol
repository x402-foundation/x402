// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Test double for the Hedera Account Service system contract (HIP-632), etched at `address(0x16a)`.
///
/// @dev Mirrors the observed semantics of `isAuthorizedRaw`:
///      - 65-byte blob → ECDSA path: `ecrecover(digest, v, r, s)` must equal the account's registered ECDSA
///        signer address (or the account address itself when nothing is registered, i.e. an EVM-alias account).
///      - 64-byte blob → ED25519 path: the account must be registered as ED25519 and the exact
///        `(account, digest, signature)` triple must have been marked valid by the test.
///      - Key-type mismatch reverts with the same reason string the real precompile uses.
///      - `revertNext()` forces the next call to revert, to prove callers treat reverts as `false`.
contract MockHederaAccountService {
    enum KeyType {
        None,
        ECDSA,
        ED25519
    }

    mapping(address account => KeyType) public keyTypes;
    mapping(address account => address signer) public ecdsaSigners;
    mapping(bytes32 key => bool valid) public ed25519Valid;
    bool public revertOnce;
    uint256 public calls;

    function setEcdsaAccount(address account, address signer) external {
        keyTypes[account] = KeyType.ECDSA;
        ecdsaSigners[account] = signer;
    }

    function setEd25519Account(address account) external {
        keyTypes[account] = KeyType.ED25519;
    }

    function setEd25519Signature(address account, bytes32 digest, bytes calldata signature, bool valid) external {
        ed25519Valid[keccak256(abi.encode(account, digest, signature))] = valid;
    }

    function revertNext() external {
        revertOnce = true;
    }

    function isAuthorizedRaw(address account, bytes memory messageHash, bytes memory signature)
        external
        returns (bool)
    {
        calls++;
        if (revertOnce) {
            revertOnce = false;
            revert("MOCK_HAS_REVERT");
        }
        require(messageHash.length == 32, "MOCK_HAS_BAD_HASH");
        bytes32 digest = abi.decode(abi.encodePacked(messageHash), (bytes32));

        if (signature.length == 65) {
            if (keyTypes[account] == KeyType.ED25519) revert("INVALID_SIGNATURE_TYPE_MISMATCHING_KEY");
            bytes32 r;
            bytes32 s;
            uint8 v;
            assembly {
                r := mload(add(signature, 32))
                s := mload(add(signature, 64))
                v := byte(0, mload(add(signature, 96)))
            }
            if (v < 27) v += 27;
            address recovered = ecrecover(digest, v, r, s);
            if (recovered == address(0)) return false;
            address expected = keyTypes[account] == KeyType.ECDSA ? ecdsaSigners[account] : account;
            return recovered == expected;
        }
        if (signature.length == 64) {
            if (keyTypes[account] != KeyType.ED25519) revert("INVALID_SIGNATURE_TYPE_MISMATCHING_KEY");
            return ed25519Valid[keccak256(abi.encode(account, digest, signature))];
        }
        revert("INVALID_SIGNATURE_LENGTH");
    }
}
