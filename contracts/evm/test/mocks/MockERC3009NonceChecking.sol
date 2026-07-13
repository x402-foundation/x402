// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @dev Mock ERC-20 with EIP-3009 receiveWithAuthorization that enforces the parts of the
 *      standard x402SwapSettler relies on — caller must be the payee, validity window, and
 *      single-use nonces — and records the last nonce so tests can assert the settler's
 *      on-chain nonce derivation. Signatures are not verified (fork tests cover that).
 */
contract MockERC3009NonceChecking is ERC20 {
    uint8 private _decimals;

    bytes32 public lastNonce;
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory
    ) external {
        require(msg.sender == to, "ERC3009: caller must be the payee");
        require(block.timestamp > validAfter, "ERC3009: authorization not yet valid");
        require(block.timestamp < validBefore, "ERC3009: authorization expired");
        require(!authorizationState[from][nonce], "ERC3009: authorization used");
        authorizationState[from][nonce] = true;
        lastNonce = nonce;
        _transfer(from, to, value);
    }
}
