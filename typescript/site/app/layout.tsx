import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "x402",
  description: "x402 testnet facilitator and protected content.",
};

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
