import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@nexus/core"],
  // Turbopack is enabled via `next dev --turbopack` (Next.js 15 default)
};

export default nextConfig;
