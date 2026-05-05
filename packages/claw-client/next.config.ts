import type { NextConfig } from "next";

// `output: "export"` produces a static bundle in `out/` that the openclaw
// plugin serves at /plugins/openclawos. basePath/assetPrefix make the emitted
// HTML reference assets under /plugins/openclawos/* so the plugin route resolves
// them. Set NEXT_OUTPUT=server to disable export (e.g. for `pnpm dev`).
const isStaticExport = process.env["NEXT_OUTPUT"] !== "server";

const nextConfig: NextConfig = {
  ...(isStaticExport ? { output: "export" as const } : {}),
  basePath: "/plugins/openclawos",
  assetPrefix: "/plugins/openclawos",
  // Disabled to work around thesysdev/openui#464 — React Strict Mode's
  // double-mount leaves the react-lang QueryManager with a dead refresh
  // timer (cleared on dispose, not re-armed on activate), so Query(..., N)
  // never re-fetches after the initial load. Remove once lang-core > 0.2.1
  // ships the upstream fix.
  reactStrictMode: false,
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
