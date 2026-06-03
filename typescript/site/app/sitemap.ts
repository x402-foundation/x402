import type { MetadataRoute } from "next";
import { writingPosts } from "./writing/posts";

/**
 * Generates the sitemap.xml for x402.org.
 *
 * @returns Array of sitemap entries with URLs, priorities, and change frequencies
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: "https://x402.org",
      lastModified: new Date("2026-04-23"),
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: "https://x402.org/ecosystem",
      lastModified: new Date("2026-04-23"),
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: "https://x402.org/writing",
      lastModified: new Date("2026-05-11"),
      changeFrequency: "weekly",
      priority: 0.75,
    },
    ...writingPosts.map(post => ({
      url: `https://x402.org/writing/${post.slug}`,
      lastModified: new Date(post.sortDate),
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
    {
      url: "https://x402.org/protected",
      lastModified: new Date("2026-04-23"),
      changeFrequency: "monthly",
      priority: 0.5,
    },
  ];
}
