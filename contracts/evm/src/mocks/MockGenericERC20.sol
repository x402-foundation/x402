// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockGenericERC20
 * @notice Minimal ERC20 mock with no constructor arguments for deterministic CREATE2 deployment.
 * @dev No EIP-2612 / EIP-3009 extensions — pure vanilla ERC20.
 *      All metadata is hardcoded so that initCode == creationCode (no constructor args),
 *      which keeps the deterministic address independent of encoding.
 */
contract MockGenericERC20 is ERC20 {
    constructor() ERC20("Mock Generic ERC20", "MOCK") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) public {
        _mint(to, amount);
    }
}
