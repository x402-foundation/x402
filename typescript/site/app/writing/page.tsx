import Image from "next/image";
import type { Metadata } from "next";
import Link from "next/link";
import { NavBar } from "../components/NavBar";
import { Footer } from "../components/Footer";
import { getWritingPostsSorted } from "./posts";

const pageTitle = "Writing | x402";
const pageDescription = "Articles and updates on the x402 internet-native payments protocol.";

export const metadata: Metadata = {
  title: pageTitle,
  description: pageDescription,
  openGraph: {
    title: pageTitle,
    description: pageDescription,
    url: "/writing",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: pageTitle,
    description: pageDescription,
  },
};

export default function WritingIndexPage() {
  const posts = getWritingPostsSorted();

  return (
    <div className="min-h-screen bg-white text-black flex flex-col">
      <NavBar />

      <div className="flex-1">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 md:px-10 lg:px-16 pt-12 sm:pt-16 md:pt-20 pb-20">
          <header className="max-w-3xl mb-12 md:mb-16">
            <h1 className="text-3xl sm:text-4xl lg:text-5xl font-semibold leading-tight mb-4">Writing</h1>
            <p className="text-base text-gray-70 leading-relaxed">
              Protocol announcements, deep dives, and ecosystem updates from the x402 team.
            </p>
          </header>

          <ul className="grid gap-8 sm:grid-cols-2 list-none p-0 m-0">
            {posts.map((post) => (
              <li key={post.slug}>
                <Link
                  href={`/writing/${post.slug}`}
                  className="group flex flex-col h-full overflow-hidden rounded-lg border border-gray-10 bg-white shadow-sm hover:shadow-md hover:border-gray-200 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
                >
                  <div className="relative aspect-[16/9] w-full overflow-hidden bg-gray-50">
                    <Image
                      src={post.heroSrc}
                      alt={post.title}
                      fill
                      className="object-cover transition-transform duration-300 group-hover:scale-[1.02]"
                      sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
                    />
                  </div>
                  <div className="flex flex-col flex-1 p-5 sm:p-6">
                    <h2 className="text-lg sm:text-xl font-semibold leading-snug text-black group-hover:text-gray-800 transition-colors">
                      {post.title}
                    </h2>
                    <p className="text-sm text-gray-60 mt-2">{post.displayDate}</p>
                    <p className="text-sm text-gray-60 mt-1">By: {post.authors}</p>
                    <p className="text-sm text-gray-70 leading-relaxed mt-4 flex-1">{post.excerpt}</p>
                    <span className="text-sm font-medium text-blue-600 mt-4 group-hover:underline">
                      Read article
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <Footer />
    </div>
  );
}