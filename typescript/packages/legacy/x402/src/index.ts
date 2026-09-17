import { warnLegacyDeprecation } from "./shared/deprecation";

export * from "./client";
export * from "./facilitator";

export const x402Version = 1;

warnLegacyDeprecation("x402", "@x402/core", "core");
