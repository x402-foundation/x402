import type { MetadataRoute } from "next";

/**
 * Generates the sitemap.xml for x402.org.
 *
 * @returns Array of sitemap entries with URLs, priorities, and change frequencies
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: "https://x402.org",
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: "https://x402.org/ecosystem",
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: "https://x402.org/writing/x402-v2-launch",
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.7,
    },
  ];
}
