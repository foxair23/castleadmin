# Castle Garage Doors & Gates — Developer Handoff

> Hand this whole folder to a developer using **Claude Code**. The goal: recreate the marketing site at <https://castlegaragedoors.com> in the existing repo using these design references as ground truth.

---

## How to use this package with Claude Code

**Option A — Browser (easiest, no install needed)**

1. On <https://github.com> open your `foxair23/foxair23.github.io` repo and use **Add file → Upload files** to drop this whole folder in. (Name it `Castle Garage Design System/` to match the rest of these docs.)
2. Open <https://claude.ai/code> in your browser, connect it to that repo.
3. Paste this prompt:

   > Read `Castle Garage Design System/HANDOFF.md` and `Castle Garage Design System/README.md` first. Then walk page by page through the existing site (`index.html`, `contact.html`, `about/index.html`, `services/...`, `service-areas/...`, `blog/...`) and update each one to match the design references in `Castle Garage Design System/preview/` and the React kit in `Castle Garage Design System/ui_kits/website/`. Copy `Castle Garage Design System/assets/` into the repo root (or reference the existing path — your call), and replace the existing `styles.css` and `colors_and_type.css` with the versions in the handoff folder. Wire up the partner logos in the trust strip, the mascot in the CTA / footer / 404 / about / blog byline, and the city photos on each service-area page. After each page, show me a diff and wait for my OK before moving on.

4. When Claude Code is done, it opens a pull request you merge from the GitHub web UI.

**Option B — Local (if you have the repo cloned)**

Same prompt, just run it inside the CLI version of Claude Code pointed at your local clone of the repo with the `Castle Garage Design System/` folder dropped in.

---

## What's in this package

| Path | What it is |
|---|---|
| `README.md` | Brand context — company snapshot, voice, visual foundations, iconography, image specs |
| `SKILL.md` | Skill spec — short brand reference; load this into any agent doing Castle work |
| `colors_and_type.css` | **Design tokens** — colors, type scale, spacing, shadows, radii. Import this anywhere |
| `styles.css` | **Production stylesheet** — every component-level rule used across the site |
| `assets/logo.png` | Castle wordmark (works on light + dark) |
| `assets/mascot.webp` | The Knight mascot — for CTA, footer, 404, about, blog byline |
| `assets/partners/` | Real partner logos: Clopay MAD + Gold Bar, LiftMaster, Genie, Home Depot |
| `assets/icons/` | Inline SVG icons used across the site (phone, shield, star, etc.) |
| `assets/fonts/` | Self-hosted DM Sans + Source Sans 3 (variable .ttf) + OFL licenses |
| `assets/photos/hero/` | Homepage hero photo |
| `assets/photos/pillars/` | Garage Doors + Gates service pillar photos |
| `assets/photos/blog/` | 11 Field Guide article images (filenames match the existing blog slugs) |
| `assets/photos/service-areas/` | 12 city photos (filenames match the existing service-area slugs) |
| `preview/` | **Design reference cards** — one HTML file per component or page section. These are the visual source of truth |
| `ui_kits/website/` | React/JSX recreations of the marketing site sections — useful as structural reference |

---

## About the design files

The files in `preview/` and `ui_kits/website/` are **design references created in HTML**. They are not production code to copy directly. Claude Code's job is to **recreate these designs in the existing site's environment** — which is plain HTML + CSS + a small `script.js`. So most of the work is updating existing `.html` files to match the references, not introducing React.

If a future redesign migrates the site to React (Next.js, Astro, etc.), the JSX components in `ui_kits/website/` become more directly reusable.

---

## Fidelity

**High-fidelity (hi-fi).** Every value in `colors_and_type.css` and `styles.css` is final. Pixel-perfect implementation expected. Brand colors, exact hex codes, type scale, spacing scale, partner logos, mascot, and copy are all production-ready.

---

## Pages to update (with their primary design references)

| Page in repo | Reference file(s) in this handoff |
|---|---|
| `index.html` (homepage) | `preview/hero-dark.html`, `preview/component-trust.html`, `preview/component-service-pillars.html`, `preview/component-service-card.html`, `preview/component-testimonial.html`, `preview/component-cta-banner.html` |
| `about/index.html` | `preview/page-about-hero.html` |
| `contact.html` | `preview/form-inputs.html` |
| `gallery.html` | (uses existing layout; just update photos) |
| `reviews.html` | `preview/component-testimonial.html` |
| `blog/index.html` | `preview/page-blog-index.html`, `preview/component-blog-byline.html` |
| `service-areas/index.html` | `preview/page-service-areas.html` |
| `services/*` | `preview/component-service-card.html` |
| `404.html` | `preview/page-404.html` |
| Footer (every page) | `preview/component-footer-knight.html` |
| Trust strip (every page) | `preview/component-trust.html` |

---

## Design tokens at a glance

**Colors**
- `--color-primary: #0F0F0F` (Castle Black — headings, dark sections, footer)
- `--color-red: #C81E1E` (Castle Red — CTAs, links, eyebrow labels, accents)
- `--color-red-dark: #A51919` (hover state)
- `--color-bg-light: #F5F5F3` (warm off-white page background)
- `--color-bg-white: #FFFFFF` (cards, header)
- `--color-border: #E2E0DC` (default border)
- `--color-text-primary: #1A1A1A`, `--color-text-secondary: #64646E`, `--color-text-muted: #8A8A94`

**Type**
- Display: **DM Sans** 700 — headings, buttons, eyebrows. Tight tracking (-0.02em).
- Body: **Source Sans 3** 400/500/600 — paragraphs, forms.
- Both self-hosted from `assets/fonts/` — no Google Fonts CDN dependency.
- Scale: 36→52 px hero, 30→40 px h1, 24→32 px h2, 20→24 px h3, 18 px body, 16 px body-sm, 14 px small.

**Spacing** — 4-base scale (`--space-1` 4 px … `--space-24` 96 px). Sections breathe at 64 px mobile, 96 px desktop.

**Radii** — 6 px (small UI), 8 px (default), 12 px (cards), 50% (numerals).

**Shadows** — four-tier, neutral black. sm 1/2/0.06, md 4/12/0.10, lg 12/32/0.14, xl 20/48/0.18. No colored shadows.

---

## Critical content facts (use everywhere)

- **Name:** Castle Garage Doors & Gates
- **Legal entity (footer copyright):** Castle Garage Inc.
- **Founded:** 1981
- **HQ:** 1291 Simpson Way Suite D, Escondido, CA 92029
- **Phone:** (800) 576-1397
- **CSLB License:** **#1154002**, C-61/D-28
- **Tagline:** "San Diego's Knight at the Gate"
- **Ownership:** Family-owned & operated (NOT veteran-owned — that was an earlier draft that was corrected)
- **Trust stack:** Family-Owned & Operated · Authorized Home Depot Installation Partner (only one across all of San Diego County) · Clopay Master Authorized Dealer · LiftMaster + Genie · BBB A+
- **Service area:** San Diego County → Riverside County (12 cities)
- **Rating:** 4.4★ from 210+ reviews

---

## Voice & copy rules

- "We" for the company, "you" for the customer.
- **Title Case** for headlines and buttons. ALL CAPS for short eyebrow labels (e.g. `OUR SERVICES`).
- **No emoji** anywhere.
- Use the typographic ampersand `&`, often colored Castle Red.
- Phone always formatted `(800) 576-1397`.
- Stars rendered as `★` unicode, colored Castle Red.
- Heritage cues OK to repeat: *Since 1981*, *40+ years*, *Licensed, bonded & insured*, *CSLB #1154002*.

---

## Imagery rules

- Daylight, warm-tone, Southern California. No twilight, no HDR, no B&W.
- No people in environment shots. Crew/family in uniform only.
- City photos for service-area pages live in `assets/photos/service-areas/`.
- Blog article images live in `assets/photos/blog/` (named to match slug).
- Full image-size spec is in `preview/image-specs.html`.

---

## Mascot usage

The Knight (`assets/mascot.webp`) is a flavor element, not a hero element.

**Use:** CTA banner, footer (small ~80 px), 404 page (full-size), About page hero (full-size), blog author byline (48 px circle), social posts, truck wraps, business cards.

**Don't use:** Homepage hero, service pillars, trust strip, header (the wordmark is already there).

---

## Open items / things the developer may need to add

- **Asset paths.** The previews reference assets via `../assets/...`. When Claude Code wires the same images into production pages at the repo root, paths become `./assets/...`. Adjust accordingly.
- **Gallery photos** — `gallery.html` still uses Unsplash stock URLs. Real before/after job photos should drop into `assets/photos/gallery/` and replace those.
- **About / team portrait** — `preview/page-about-hero.html` uses the mascot as a stand-in. If you have a real owner/family/crew portrait, it would go in `assets/photos/team/` and replace the mascot in the About hero.
- The `assets/fonts/` files are `.ttf` variable fonts (~250 KB each). Converting to `.woff2` would shrink them ~30% — optional optimization.

---

## Questions during implementation?

Most of these are answered in `README.md` (long-form) or the per-component preview cards under `preview/`. If something isn't covered, the simplest path is to look at the original castlegaragedoors.com page for current behavior, then improve to match the references here.
