// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {DeployX402Proxies} from "../script/Deploy.s.sol";
import {x402UptoPermit2Proxy} from "../src/x402UptoPermit2Proxy.sol";

contract DeployX402ProxiesTest is Test {
    address constant CANONICAL_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

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
}
