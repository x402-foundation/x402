import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "x402 e2e",
  description: "x402 Next.js e2e resource server",
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
