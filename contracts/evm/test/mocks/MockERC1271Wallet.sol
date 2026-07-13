// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @dev Minimal EIP-1271 smart wallet for x402SwapSettler allowance-method tests.
 *      Validates signatures as ECDSA from a fixed owner key; `alwaysReject` simulates a
 *      wallet that refuses the signature. `approveToken` lets tests set ERC-20 allowances
 *      from the wallet's context.
 */
contract MockERC1271Wallet {
    bytes4 internal constant MAGIC_VALUE = 0x1626ba7e;

    address public immutable OWNER;
    bool public alwaysReject;

    constructor(
        address _owner
    ) {
        OWNER = _owner;
    }

    function setAlwaysReject(
        bool _alwaysReject
    ) external {
        alwaysReject = _alwaysReject;
    }

    function approveToken(address token, address spender, uint256 amount) external {
        require(IERC20(token).approve(spender, amount), "approve failed");
    }

    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        if (alwaysReject) return 0xffffffff;
        (address recovered,,) = ECDSA.tryRecover(hash, signature);
        return recovered == OWNER && recovered != address(0) ? MAGIC_VALUE : bytes4(0xffffffff);
    }
}
