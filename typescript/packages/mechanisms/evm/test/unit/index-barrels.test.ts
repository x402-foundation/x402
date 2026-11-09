import { describe, expect, it } from "vitest";

import * as authCaptureFacilitator from "../../src/auth-capture/facilitator/index";
import * as batchSettlementClient from "../../src/batch-settlement/client/index";
import * as batchSettlementFacilitator from "../../src/batch-settlement/facilitator/index";
import * as batchSettlementServer from "../../src/batch-settlement/server/index";
import * as exactFacilitator from "../../src/exact/facilitator/index";
import * as exactServer from "../../src/exact/server/index";
import * as exactV1Client from "../../src/exact/v1/client/index";
import * as exactV1Facilitator from "../../src/exact/v1/facilitator/index";

describe("package index barrels", () => {
  it("re-export scheme entrypoints", () => {
    expect(authCaptureFacilitator.AuthCaptureEvmScheme).toBeTypeOf("function");
    expect(batchSettlementClient.BatchSettlementEvmScheme).toBeTypeOf("function");
    expect(batchSettlementFacilitator.BatchSettlementEvmScheme).toBeTypeOf("function");
    expect(batchSettlementServer.BatchSettlementEvmScheme).toBeTypeOf("function");
    expect(exactFacilitator.ExactEvmScheme).toBeTypeOf("function");
    expect(exactServer.ExactEvmScheme).toBeTypeOf("function");
    expect(exactV1Client.ExactEvmSchemeV1).toBeTypeOf("function");
    expect(exactV1Facilitator.ExactEvmSchemeV1).toBeTypeOf("function");
  });
});
