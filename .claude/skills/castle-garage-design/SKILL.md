---
name: castle-garage-design
description: Use this skill to generate well-branded interfaces and assets for Castle Garage Doors & Gates (San Diego garage door & gate installation/repair company, veteran-owned, since 1981), either for production or throwaway prototypes/mocks. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping.
user-invocable: true
---

Read the README.md file within this skill, and explore the other available files.

If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy assets out and create static HTML files for the user to view. If working on production code, you can copy assets and read the rules here to become an expert in designing with this brand.

If the user invokes this skill without any other guidance, ask them what they want to build or design, ask some questions, and act as an expert designer who outputs HTML artifacts _or_ production code, depending on the need.

Key resources in this skill:
- `README.md` — full brand context: company snapshot, sources, content fundamentals, visual foundations, iconography, index.
- `colors_and_type.css` — design tokens (colors, type, spacing, shadows, radii) + base semantic styles. Always import this when building Castle assets.
- `styles.css` — full website stylesheet (component-level rules, mobile-first).
- `assets/logo.png` — Castle wordmark.
- `assets/icons/*.svg` — extracted brand icons (phone, shield, star, clock, check, home, building, wrench, pin, calendar, chevron-down, facebook, google).
- `ui_kits/website/` — pixel-faithful React component recreation of the marketing site (Header, Hero, TrustStrip, ServicesSection, WhyCastle, Testimonials, CTABanner, Footer + runnable index.html).
- `preview/` — design-system spec cards.

Brand essentials:
- Two brand colors only: Castle Black `#0F0F0F` and Castle Red `#C81E1E`. No gradients, no third color.
- Type: DM Sans 700 for display, Source Sans 3 400/500/600 for body. Both via Google Fonts.
- Voice: confident, plain-spoken, blue-collar professional. "We" for company, "you" for customer. No emoji.
- Heritage signals (since 1981, 40+ years, veteran-owned, CSLB #1154002, Home Depot Authorized, Clopay Dealer) belong on most pages.
- Imagery: real, sunlit, warm-tone photography of suburban garage doors/driveway gates. No people, no illustrations.
