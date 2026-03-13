import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Empty turbopack config to silence warning about webpack config
  turbopack: {},
  // Externalize packages that use native modules or WASM
  serverExternalPackages: [
    "pyodide",
    "@mcpc-tech/core",
    "@mcpc/code-runner-mcp",
    "@modelcontextprotocol/sdk",
    "@one/agent",
    "@one/reason",
    "@one/act",
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
