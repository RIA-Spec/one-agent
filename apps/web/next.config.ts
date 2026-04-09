import type { NextConfig } from "next";
import { resolve } from "node:path";

const nextConfig: NextConfig = {
  turbopack: {
    root: resolve(__dirname, "../.."),
  },
  // Externalize packages that use native modules or WASM
  serverExternalPackages: [
    "pyodide",
    "@mcpc-tech/code-runner-mcp",
    "@mcpc-tech/handle-sandbox",
    "@one-agent/agent",
  ],
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Exclude native addons from bundling
      config.externals = config.externals || [];
      config.externals.push({
        fsevents: "commonjs fsevents",
      });
    }
    return config;
  },
  images: {
    remotePatterns: [
      {
        hostname: "avatar.vercel.sh",
      },
      {
        protocol: "https",
        //https://nextjs.org/docs/messages/next-image-unconfigured-host
        hostname: "*.public.blob.vercel-storage.com",
      },
    ],
  },
};

export default nextConfig;
