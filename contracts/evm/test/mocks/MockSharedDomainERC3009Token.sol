// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract MockSharedDomainERC3009Token is ERC20 {
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    bytes32 private constant _DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version)");
    bytes32 private constant _DOMAIN_SEPARATOR =
        keccak256(abi.encode(_DOMAIN_TYPEHASH, keccak256("Shared Domain Token"), keccak256("1")));

    mapping(address authorizer => mapping(bytes32 nonce => bool used)) public authorizationState;

    error AuthorizationExpired();
    error AuthorizationNotYetValid();
    error AuthorizationUsed();
    error CallerMustBePayee();
    error InvalidSignature();

    constructor() ERC20("Shared Domain Token", "SDT") {}

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }

    function domainSeparator() external pure returns (bytes32) {
        return _DOMAIN_SEPARATOR;
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
        if (msg.sender != to) revert CallerMustBePayee();
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (authorizationState[from][nonce]) revert AuthorizationUsed();

        bytes32 structHash =
            keccak256(abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _DOMAIN_SEPARATOR, structHash));
        if (ECDSA.recover(digest, signature) != from) revert InvalidSignature();

        authorizationState[from][nonce] = true;
        _transfer(from, to, value);
    }
}
