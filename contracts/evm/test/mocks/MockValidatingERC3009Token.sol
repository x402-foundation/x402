// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

contract MockValidatingERC3009Token is ERC20, EIP712 {
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    mapping(address authorizer => mapping(bytes32 nonce => bool used)) public authorizationState;

    address public failedRecipient;
    address public reentryTarget;
    bytes public reentryData;
    bool public reentrySucceeded;
    uint256 public receiveShortfall;
    address public outgoingFrom;
    uint256 public outgoingShortfall;
    bool public bytesAuthorizationEnabled = true;
    bool public vrsAuthorizationEnabled = true;
    bool public emptyVRSRevert;
    uint256 public bytesAuthorizationCalls;
    uint256 public vrsAuthorizationCalls;

    error AuthorizationExpired();
    error AuthorizationNotYetValid();
    error AuthorizationUsed();
    error BytesAuthorizationUnsupported();
    error CallerMustBePayee();
    error InvalidSignature();
    error TransferFailed();
    error VRSAuthorizationUnsupported();

    constructor() ERC20("Mock USD Coin", "mUSDC") EIP712("Mock USD Coin", "2") {}

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function setFailedRecipient(
        address recipient
    ) external {
        failedRecipient = recipient;
    }

    function setReentry(
        address target,
        bytes calldata data
    ) external {
        reentryTarget = target;
        reentryData = data;
        reentrySucceeded = false;
    }

    /// @notice Makes `receiveWithAuthorization` deliver `shortfall` fewer tokens than `value`.
    function setReceiveShortfall(
        uint256 shortfall
    ) external {
        receiveShortfall = shortfall;
    }

    /// @notice Makes transfers from `from` deliver `shortfall` fewer tokens than requested.
    function setOutgoingShortfall(
        address from,
        uint256 shortfall
    ) external {
        outgoingFrom = from;
        outgoingShortfall = shortfall;
    }

    function setAuthorizationInterfaces(
        bool bytesEnabled,
        bool vrsEnabled
    ) external {
        bytesAuthorizationEnabled = bytesEnabled;
        vrsAuthorizationEnabled = vrsEnabled;
    }

    function setEmptyVRSRevert(
        bool enabled
    ) external {
        emptyVRSRevert = enabled;
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external {
        if (!bytesAuthorizationEnabled) revert BytesAuthorizationUnsupported();
        bytesAuthorizationCalls++;
        _receiveWithAuthorization(from, to, value, validAfter, validBefore, nonce, signature);
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (!vrsAuthorizationEnabled) revert VRSAuthorizationUnsupported();
        if (emptyVRSRevert) revert();
        vrsAuthorizationCalls++;
        _receiveWithAuthorization(from, to, value, validAfter, validBefore, nonce, abi.encodePacked(r, s, v));
    }

    function _receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) private {
        if (msg.sender != to) revert CallerMustBePayee();
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (authorizationState[from][nonce]) revert AuthorizationUsed();

        bytes32 structHash =
            keccak256(abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce));
        if (!SignatureChecker.isValidSignatureNow(from, _hashTypedDataV4(structHash), signature)) {
            revert InvalidSignature();
        }

        authorizationState[from][nonce] = true;

        address target = reentryTarget;
        if (target != address(0)) {
            bytes memory data = reentryData;
            reentryTarget = address(0);
            (reentrySucceeded,) = target.call(data);
        }

        uint256 shortfall = receiveShortfall;
        if (shortfall >= value) revert TransferFailed();
        _transfer(from, to, value - shortfall);
    }

    function _update(
        address from,
        address to,
        uint256 value
    ) internal override {
        if (from != address(0) && failedRecipient != address(0) && to == failedRecipient) revert TransferFailed();
        if (outgoingShortfall != 0 && from == outgoingFrom && outgoingShortfall < value) {
            super._update(from, to, value - outgoingShortfall);
            return;
        }
        super._update(from, to, value);
    }
}
