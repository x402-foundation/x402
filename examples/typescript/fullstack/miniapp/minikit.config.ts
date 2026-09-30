const ROOT_URL =
  process.env.NEXT_PUBLIC_URL ||
  (process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`) ||
  "http://localhost:3000";

/**
 * MiniApp configuration object. Must follow the mini app manifest specification.
 *
 * @see {@link https://docs.base.org/mini-apps/features/manifest}
 * @see {@link https://miniapps.farcaster.xyz/docs/guides/publishing}
 */
export const minikitConfig = {
  accountAssociation: {
    header: "",
    payload: "",
    signature: "",
  },
  baseBuilder: {
    ownerAddress: "",
  },
  miniapp: {
    version: "1",
    name: "x402 Mini App",
    subtitle: "Payment-protected APIs",
    description: "A Farcaster Mini App with payment protected endpoints",
    screenshotUrls: [] as string[],
    iconUrl: process.env.NEXT_PUBLIC_ICON_URL || `${ROOT_URL}/icon.png`,
    splashImageUrl: process.env.NEXT_PUBLIC_SPLASH_IMAGE || `${ROOT_URL}/splash.png`,
    splashBackgroundColor: process.env.NEXT_PUBLIC_SPLASH_BACKGROUND_COLOR || "#3b82f6",
    homeUrl: ROOT_URL,
    webhookUrl: `${ROOT_URL}/api/webhook`,
    primaryCategory: "developer-tools" as const,
    tags: ["payments"],
    heroImageUrl: process.env.NEXT_PUBLIC_APP_HERO_IMAGE || `${ROOT_URL}/hero.png`,
    tagline: "Payment Protocol",
    ogTitle: "Mini App",
    ogDescription: "Payment protected APIs ",
    ogImageUrl: process.env.NEXT_PUBLIC_APP_HERO_IMAGE || `${ROOT_URL}/hero.png`,
  },
};
