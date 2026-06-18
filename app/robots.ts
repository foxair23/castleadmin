import type { MetadataRoute } from 'next'

// Internal admin/scheduling tool — disallow all crawlers across the whole site.
// Served at /robots.txt.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      disallow: '/',
    },
  }
}
