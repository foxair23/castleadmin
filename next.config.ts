import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Internal admin tool — block search indexing at the HTTP layer too, so even
  // non-HTML responses (API routes, assets) carry the directive.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
        ],
      },
    ]
  },
};

export default nextConfig;
