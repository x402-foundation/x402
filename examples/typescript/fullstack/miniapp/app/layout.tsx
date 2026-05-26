import "@coinbase/onchainkit/styles.css";
import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

const geist = Geist({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "x402 Mini App",
  description:
    "A Farcaster Mini App with x402 payment-protected endpoints using the v2 SDK.",
  keywords: ["mini app", "x402", "onchainkit", "farcaster", "web3", "payments"],
  authors: [{ name: "x402 Team" }],

  // Open Graph metadata for social sharing and embeds
  openGraph: {
    title: "x402 Mini App",
    description:
      "A Farcaster Mini App with x402 payment-protected endpoints using the v2 SDK.",
    type: "website",
    url: process.env.NEXT_PUBLIC_URL || "https://example.com/",
    siteName: "x402 Mini App",
    images: [
      {
        url: process.env.NEXT_PUBLIC_APP_HERO_IMAGE || "/icon.png",
        width: 1200,
        height: 630,
        alt: "x402 Mini App",
      },
    ],
  },

  // Twitter Card metadata
  twitter: {
    card: "summary_large_image",
    title: "x402 Mini App",
    description:
      "A Farcaster Mini App with x402 payment-protected endpoints using the v2 SDK.",
    images: [process.env.NEXT_PUBLIC_APP_HERO_IMAGE || "/icon.png"],
  },

  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: process.env.NEXT_PUBLIC_ONCHAINKIT_PROJECT_NAME || "x402 Mini App",
  },
  formatDetection: {
    telephone: false,
  },
  robots: {
    index: false,
    follow: false,
  },

  // Farcaster Mini App embed metadata
  other: {
    "fc:miniapp": JSON.stringify({
      version: "next",
      imageUrl: process.env.NEXT_PUBLIC_APP_HERO_IMAGE,
      button: {
        title: `Launch ${process.env.NEXT_PUBLIC_ONCHAINKIT_PROJECT_NAME || "x402 Mini App"}`,
        action: {
          type: "launch_frame",
          name:
            process.env.NEXT_PUBLIC_ONCHAINKIT_PROJECT_NAME || "x402 Mini App",
          url: process.env.NEXT_PUBLIC_URL,
          splashImageUrl: process.env.NEXT_PUBLIC_SPLASH_IMAGE,
          splashBackgroundColor:
            process.env.NEXT_PUBLIC_SPLASH_BACKGROUND_COLOR,
        },
      },
    }),
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0f172a" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full">
      <head>
        {/* Additional meta tags for mini app embedding */}
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta
          name="apple-mobile-web-app-title"
          content={
            process.env.NEXT_PUBLIC_ONCHAINKIT_PROJECT_NAME || "x402 Mini App"
          }
        />

        {/* Favicon and app icons */}
        <link rel="icon" href="/favicon.ico" />
        <link rel="apple-touch-icon" href="/icon.png" />
        <link rel="manifest" href="/manifest.json" />

        {/* Preconnect to external domains for better performance */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link rel="preconnect" href="https://auth.farcaster.xyz" />
      </head>
      <body className={`${geist.className} h-full antialiased bg-background`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

