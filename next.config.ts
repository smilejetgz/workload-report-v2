import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native module — must stay external to Turbopack/webpack bundling.
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
