const warnedPackages = new Set<string>();

export type LegacyDeprecationKind = "core" | "client" | "server";

/**
 * Warns once per process that a legacy x402 v1 package is frozen and should migrate to its
 * v2 replacement. Set X402_SUPPRESS_LEGACY_WARNING=1 to suppress this warning.
 *
 * @param pkg - The legacy package name, e.g. "x402-axios"
 * @param replacement - The v2 replacement package name, e.g. "@x402/axios"
 * @param kind - The shape of the package: "core" (the base x402 package), "client" (outbound payment wrappers), or "server" (inbound payment middleware)
 */
export function warnLegacyDeprecation(
  pkg: string,
  replacement: string,
  kind: LegacyDeprecationKind,
): void {
  if (process.env.X402_SUPPRESS_LEGACY_WARNING) return;
  if (warnedPackages.has(pkg)) return;
  warnedPackages.add(pkg);

  const detail =
    kind === "core"
      ? `is the x402 protocol v1 implementation and is frozen. Please migrate to "${replacement}" for x402 protocol v2 support`
      : kind === "client"
        ? "is the x402 protocol v1 client implementation and is frozen. It will not interoperate with " +
          `servers that only advertise payment terms via the v2 "PAYMENT-REQUIRED" header. Please migrate to "${replacement}"`
        : "implements x402 protocol v1 and only emits payment terms in the JSON response body. v2 " +
          `clients read the "PAYMENT-REQUIRED" header instead and will not be able to pay you. Please migrate to "${replacement}"`;

  console.warn(
    `[${pkg}] DEPRECATED: "${pkg}" ${detail}: https://www.npmjs.com/package/${replacement}`,
  );
}
