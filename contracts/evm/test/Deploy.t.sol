// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {DeployX402Proxies} from "../script/Deploy.s.sol";
import {x402ExactPermit2Proxy} from "../src/x402ExactPermit2Proxy.sol";
import {x402UptoPermit2Proxy} from "../src/x402UptoPermit2Proxy.sol";

/// @title DeployX402ProxiesTest
/// @notice Regression tests for the CREATE2 deployment path (non-local chain IDs), where
///         Deploy.s.sol must reproduce the documented canonical addresses exactly. A prior
///         change silently regressed UPTO_SALT to a stale value that no longer matched the
///         live, SDK-referenced x402UptoPermit2Proxy deployment; these tests pin both
///         canonical addresses so a future salt/initCode regression fails loudly here
///         instead of silently deploying an orphaned contract on a new chain.
contract DeployX402ProxiesTest is Test {
    address constant CANONICAL_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    address constant EXPECTED_EXACT_ADDRESS = 0x402085c248EeA27D92E8b30b2C58ed07f9E20001;
    address constant EXPECTED_UPTO_ADDRESS = 0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002;

    /// @dev Bytecode of Arachnid's deterministic CREATE2 deployer, same on every EVM chain.
    bytes constant CREATE2_DEPLOYER_CODE =
        hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

    function _simulateRealChain() internal {
        vm.chainId(8453); // any non-anvil chain ID forces the CREATE2 (non-local) deployment path
        vm.etch(CREATE2_DEPLOYER, CREATE2_DEPLOYER_CODE);
        vm.etch(CANONICAL_PERMIT2, hex"60006000fd"); // just needs non-empty code for the prereq check
    }

    function test_runDeploysToCanonicalAddresses() public {
        _simulateRealChain();

        DeployX402Proxies deployer = new DeployX402Proxies();
        deployer.run();

        assertGt(EXPECTED_EXACT_ADDRESS.code.length, 0, "no code at canonical Exact address");
        assertGt(EXPECTED_UPTO_ADDRESS.code.length, 0, "no code at canonical Upto address");

        assertEq(
            address(x402ExactPermit2Proxy(EXPECTED_EXACT_ADDRESS).PERMIT2()),
            CANONICAL_PERMIT2,
            "Exact PERMIT2 mismatch"
        );
        assertEq(
            address(x402UptoPermit2Proxy(EXPECTED_UPTO_ADDRESS).PERMIT2()), CANONICAL_PERMIT2, "Upto PERMIT2 mismatch"
        );
    }

    function test_runIsIdempotent() public {
        _simulateRealChain();

        DeployX402Proxies deployer = new DeployX402Proxies();
        deployer.run();
        deployer.run(); // must detect existing deployments and skip, not attempt to redeploy

        assertGt(EXPECTED_EXACT_ADDRESS.code.length, 0);
        assertGt(EXPECTED_UPTO_ADDRESS.code.length, 0);
    }

    function test_runUptoDeploysOnlyUpto() public {
        DeployX402Proxies deployer = new DeployX402Proxies();
        uint64 nonceBefore = vm.getNonce(DEFAULT_SENDER);
        address expectedAddress = vm.computeCreateAddress(DEFAULT_SENDER, nonceBefore);

        deployer.runUpto();

        assertEq(vm.getNonce(DEFAULT_SENDER), nonceBefore + 1);
        assertGt(expectedAddress.code.length, 0);
        x402UptoPermit2Proxy referenceProxy = new x402UptoPermit2Proxy(CANONICAL_PERMIT2);
        assertEq(expectedAddress.codehash, address(referenceProxy).codehash);
        assertEq(address(x402UptoPermit2Proxy(expectedAddress).PERMIT2()), CANONICAL_PERMIT2);
    }

    function test_runUptoDeploysToCanonicalAddress() public {
        _simulateRealChain();

        DeployX402Proxies deployer = new DeployX402Proxies();
        deployer.runUpto();

        assertGt(EXPECTED_UPTO_ADDRESS.code.length, 0, "no code at canonical Upto address");
        assertEq(EXPECTED_EXACT_ADDRESS.code.length, 0, "Exact should not be deployed");
        assertEq(
            address(x402UptoPermit2Proxy(EXPECTED_UPTO_ADDRESS).PERMIT2()), CANONICAL_PERMIT2, "Upto PERMIT2 mismatch"
        );
    }
}
