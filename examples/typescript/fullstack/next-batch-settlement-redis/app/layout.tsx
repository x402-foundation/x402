import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "x402 batch-settlement (Next.js API)",
};

/**
 * Minimal root layout — this example is intended for `GET /api/weather` only.
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
