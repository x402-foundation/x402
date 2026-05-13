export interface WritingPost {
  slug: string;
  title: string;
  displayDate: string;
  /** ISO date string for sorting (newest first) */
  sortDate: string;
  authors: string;
  heroSrc: string;
  excerpt: string;
}

export const writingPosts: WritingPost[] = [
  {
    slug: "x402-batch-settlement",
    title: "Introducing x402 Batch Settlement: High-velocity Agentic Commerce",
    displayDate: "May 11, 2026",
    sortDate: "2026-05-11",
    authors: "Philippe d'Argent, Carson Roscoe, Conner Swenberg, Josh Nickerson",
    heroSrc: "/images/x402-batch-settlement-hero.png",
    excerpt:
      "Batch settlement enables agents to transact at extremely low latency and fractions of a cent, with cryptographic vouchers and bulk onchain redemption.",
  },
  {
    slug: "x402-v2-launch",
    title: "Introducing x402 V2: Evolving the Standard for Internet-native Payments",
    displayDate: "December 11, 2025",
    sortDate: "2025-12-11",
    authors: "Erik Reppel, Carson Roscoe, Josh Nickerson",
    heroSrc: "/images/blog_intro.png",
    excerpt:
      "x402 V2 expands the protocol beyond single-call, exact payments: wallet-based identity, discovery, dynamic recipients, and a modular SDK.",
  },
];

/**
 * Returns writing posts sorted newest first by `sortDate`.
 *
 * @returns Ordered copy of {@link writingPosts}
 */
export function getWritingPostsSorted(): WritingPost[] {
  return [...writingPosts].sort((a, b) =>
    a.sortDate < b.sortDate ? 1 : a.sortDate > b.sortDate ? -1 : 0,
  );
}