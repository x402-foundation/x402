export interface FacilitatorInfo {
  baseUrl: string;
  networks: string[];
  schemes: string[];
  assets: string[];
  addresses: {
    [key: string]: string[];
  };
  supports: {
    verify: boolean;
    settle: boolean;
    supported: boolean;
    list: boolean;
  };
}

export interface Partner {
  name: string;
  description: string;
  logoUrl: string; // Path to the logo, e.g., /images/ecosystem/logos/project-logo.png
  websiteUrl: string;
  category: string; // Main category name as defined in categories array
  typeLabel?: string;
  top_section?: boolean;
  // Additional fields like a slug for directory name can be added if needed for linking or lookup
  slug?: string;
  // Facilitator-specific data (only present for facilitators)
  facilitator?: FacilitatorInfo;
}

export interface CategoryInfo {
  id: string; // e.g., "client-side-integrations"
  name: string; // e.g., "Client-Side Integrations"
}

// These categories will be used for filtering and can be referenced in partner metadata.json
export const categories: CategoryInfo[] = [
  {
    id: "client-side-integrations",
    name: "Client-Side Integrations",
  },
  {
    id: "services-endpoints",
    name: "Services/Endpoints",
  },
  {
    id: "ecosystem-infrastructure",
    name: "Infrastructure & Tooling",
  },
  {
    id: "learning-community",
    name: "Learning & Community Resources",
  },
  {
    id: "facilitators",
    name: "Facilitators",
  },
];

// The partners array is removed from here. It will be dynamically loaded.
