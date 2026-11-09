import { describe, it, expect } from "vitest";
import {
  ESCROW_ABI_V1_0,
  ESCROW_ABI_V1_1,
  escrowAbiForDeployment,
  escrowAbiForVersion,
} from "../../../src/auth-capture/abi";
import {
  AUTH_CAPTURE_DEPLOYMENT_V1_0,
  AUTH_CAPTURE_DEPLOYMENT_V1_1,
} from "../../../src/auth-capture/constants";

describe("auth-capture escrow ABI helpers", () => {
  it("selects v1.0 or v1.1 charge/capture ABI by deployment version", () => {
    expect(escrowAbiForVersion("v1.0")).toBe(ESCROW_ABI_V1_0);
    expect(escrowAbiForVersion("v1.1")).toBe(ESCROW_ABI_V1_1);
  });

  it("selects ABI from a resolved deployment record", () => {
    expect(escrowAbiForDeployment(AUTH_CAPTURE_DEPLOYMENT_V1_0)).toBe(ESCROW_ABI_V1_0);
    expect(escrowAbiForDeployment(AUTH_CAPTURE_DEPLOYMENT_V1_1)).toBe(ESCROW_ABI_V1_1);
  });
});
