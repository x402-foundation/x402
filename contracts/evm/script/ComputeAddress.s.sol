// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";

import {x402ExactPermit2Proxy} from "../src/x402ExactPermit2Proxy.sol";
import {x402UptoPermit2Proxy} from "../src/x402UptoPermit2Proxy.sol";

/**
 * @title ComputeAddress
 * @notice Compute the deterministic CREATE2 addresses for x402 Permit2 Proxies
 *
 * @dev The Permit2 address is a constructor argument. Since the canonical Permit2
 *      address is the same on all EVM chains, the initCode is identical everywhere,
 *      preserving uniform CREATE2 addresses.
 *
 * @dev Run with default salts:
 *      forge script script/ComputeAddress.s.sol
 *
 * @dev Run with custom salts:
 *      forge script script/ComputeAddress.s.sol --sig "computeAddresses(bytes32,bytes32)" <EXACT_SALT> <UPTO_SALT>
 */
contract ComputeAddress is Script {
    /// @notice Arachnid's deterministic CREATE2 deployer
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// @notice Canonical Permit2 address (same on all EVM chains)
    address constant CANONICAL_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /// @notice Default salt for x402ExactPermit2Proxy
    /// @dev Vanity mined for address 0x402085c248eea27d92e8b30b2c58ed07f9e20001
    bytes32 constant DEFAULT_EXACT_SALT = 0x0000000000000000000000000000000000000000000000003000000007263b0e;

    /// @notice Default salt for x402UptoPermit2Proxy
    /// @dev Vanity mined for address 0x402039b3d6e6bec5a02c2c9fd937ac17a6940002
    bytes32 constant DEFAULT_UPTO_SALT = 0x0000000000000000000000000000000000000000000000000000000000edb738;

    /**
     * @notice Computes the CREATE2 addresses using the default salts
     */
    function run() public view {
        computeAddresses(DEFAULT_EXACT_SALT, DEFAULT_UPTO_SALT);
    }

    /**
     * @notice Computes the CREATE2 addresses for both x402 Permit2 Proxies
     * @param exactSalt The salt to use for x402ExactPermit2Proxy
     * @param uptoSalt The salt to use for x402UptoPermit2Proxy
     */
    function computeAddresses(bytes32 exactSalt, bytes32 uptoSalt) public view {
        console2.log("");
        console2.log("============================================================");
        console2.log("  x402 Permit2 Proxy Address Computation");
        console2.log("============================================================");
        console2.log("");

        console2.log("Configuration:");
        console2.log("  CREATE2 Deployer:    ", CREATE2_DEPLOYER);
        console2.log("  Permit2 (ctor arg):  ", CANONICAL_PERMIT2);
        console2.log("");

        // Compute x402ExactPermit2Proxy address
        {
            bytes memory initCode =
                abi.encodePacked(type(x402ExactPermit2Proxy).creationCode, abi.encode(CANONICAL_PERMIT2));
            bytes32 initCodeHash = keccak256(initCode);
            address expectedAddress = _computeCreate2Addr(exactSalt, initCodeHash, CREATE2_DEPLOYER);

            console2.log("------------------------------------------------------------");
            console2.log("  x402ExactPermit2Proxy");
            console2.log("------------------------------------------------------------");
            console2.log("  Salt:           ", vm.toString(exactSalt));
            console2.log("  Init Code Hash: ", vm.toString(initCodeHash));
            console2.log("  Address:        ", expectedAddress);

            if (block.chainid != 0 && expectedAddress.code.length > 0) {
                console2.log("  Status: DEPLOYED");
            } else {
                console2.log("  Status: NOT DEPLOYED");
            }
            console2.log("");
        }

        // Compute x402UptoPermit2Proxy address
        {
            bytes memory initCode =
                abi.encodePacked(type(x402UptoPermit2Proxy).creationCode, abi.encode(CANONICAL_PERMIT2));
            bytes32 initCodeHash = keccak256(initCode);
            address expectedAddress = _computeCreate2Addr(uptoSalt, initCodeHash, CREATE2_DEPLOYER);

            console2.log("------------------------------------------------------------");
            console2.log("  x402UptoPermit2Proxy");
            console2.log("------------------------------------------------------------");
            console2.log("  Salt:           ", vm.toString(uptoSalt));
            console2.log("  Init Code Hash: ", vm.toString(initCodeHash));
            console2.log("  Address:        ", expectedAddress);

            if (block.chainid != 0 && expectedAddress.code.length > 0) {
                console2.log("  Status: DEPLOYED");
            } else {
                console2.log("  Status: NOT DEPLOYED");
            }
            console2.log("");
        }
    }

    function _computeCreate2Addr(
        bytes32 salt,
        bytes32 initCodeHash,
        address deployer
    ) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)))));
    }
}
