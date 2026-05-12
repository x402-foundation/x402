import fs from "fs";
import path from "path";
import { Suspense } from "react";
import { categories, type Partner } from "./data";
import EcosystemClient from "./EcosystemClient";
import { NavBar } from "../components/NavBar";
import { Footer } from "../components/Footer";

export const metadata = {
  title: "Ecosystem | x402",
  description:
    "Discover innovative projects, tools, and applications built by our growing community of partners and developers leveraging x402 technology.",
};

export const revalidate = 3600;

async function getPartners(): Promise<Partner[]> {
  const partnersDirectory = path.join(process.cwd(), "app/ecosystem/partners-data");
  let partnerFolders: string[] = [];

  try {
    partnerFolders = fs
      .readdirSync(partnersDirectory)
      .filter((file) => fs.statSync(path.join(partnersDirectory, file)).isDirectory());
  } catch (error) {
    console.error("Error reading partners directory:", error);
    return [];
  }

  const allPartnersData = partnerFolders.map((folder) => {
    const metadataFilePath = path.join(partnersDirectory, folder, "metadata.json");
    try {
      const fileContents = fs.readFileSync(metadataFilePath, "utf8");
      const metadata = JSON.parse(fileContents) as Omit<Partner, "slug">;
      return {
        ...metadata,
        slug: folder,
        logoUrl: metadata.logoUrl ?? `/images/ecosystem/logos/${folder}.png`,
      };
    } catch (error) {
      console.error(`Error reading or parsing metadata.json for ${folder}:`, error);
      return null;
    }
  });

  return allPartnersData.filter((partner) => partner !== null) as Partner[];
}

function EcosystemLoading() {
  return (
    <div className="mx-auto max-w-container px-6 py-16 sm:px-10">
      <div className="animate-pulse space-y-8">
        <div className="h-20 w-64 bg-gray-10" />
        <div className="grid grid-cols-4 gap-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-48 bg-gray-10" />
          ))}
        </div>
      </div>
    </div>
  );
}

async function EcosystemPageContent({
  searchParams,
}: {
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const partners = await getPartners();
  const resolvedParams = await searchParams;
  const selectedCategory =
    typeof resolvedParams?.filter === "string" ? resolvedParams.filter : null;

  return (
    <EcosystemClient
      initialPartners={partners}
      categories={categories}
      initialSelectedCategory={selectedCategory}
    />
  );
}

export default function EcosystemPage({
  searchParams,
}: {
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <NavBar />
      <Suspense fallback={<EcosystemLoading />}>
        <EcosystemPageContent searchParams={searchParams} />
      </Suspense>
      <Footer />
    </div>
  );
}
