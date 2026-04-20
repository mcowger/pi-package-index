export interface ReviewedPackage {
  name: string;
  version: string;
  fetchedAt: string;
}

export interface StateFile {
  packages: ReviewedPackage[];
}

export interface PackageLinks {
  npm: string;
  homepage: string | null;
  repository: string | null;
  bugs: string | null;
}

export interface PackageData {
  name: string;
  version: string;
  description: string | null;
  keywords: string[];
  date: string;
  publisher: string | null;
  links: PackageLinks;
  readme: string | null;
  readmeSource: 'npm' | 'github' | null;
  summary: string | null;
  stars: number | null;
  error?: string;
  fetchedAt: string;
}

export interface PackagesJson {
  generatedAt: string;
  query: string;
  total: number;
  packages: PackageData[];
}
