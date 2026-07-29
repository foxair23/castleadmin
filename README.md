# Castle Garage Doors & Gates — Design System

> Veteran-owned, family-operated garage door and gate installation & repair company serving San Diego County to Riverside County since 1981.

This design system codifies the visual language, copy voice, and reusable components for **Castle Garage Doors & Gates** so designers and developers can produce on-brand artifacts (marketing pages, ads, social, decks, internal tools) without re-deriving everything.

## Company Snapshot

- **Founded:** 1981
- **HQ:** 1291 Simpson Way Suite D, Escondido, CA 92029
- **Phone:** (800) 576-1397
- **License:** CSLB #1154002, C-61/D-28
- **Credentials:** Veteran-owned · Family-operated · Authorized Home Depot Service Provider (28 stores) · Clopay Authorized Dealer · BBB A+
- **Service area:** San Diego, Escondido, Oceanside, Carlsbad, Encinitas, North County, Temecula, Murrieta, Fallbrook, Bonsall, Riverside County, Corona
- **Tagline:** "San Diego's Knight at the Gate"

## Products / Surfaces

The brand currently has **one primary surface**:

1. **Marketing website** — `castlegaragedoors.com` — service-area pages, services, blog ("Field Guides"), gallery, reviews, contact, specials.

(There is no consumer-facing app or admin product in scope for this design system. A separate `castleadmin` repo exists for an internal piecework payroll app but is not part of the public brand surface.)

## Sources

- **Codebase:** `foxair23/foxair23.github.io` (default branch `claude/markdown-to-html-landing-CNZMR`). Imported subset: `index.html`, `styles.css`, `script.js`, `logo.png`, `llms.txt`, `contact.html`, `gallery.html`, `reviews.html`, `specials.html`, `about/index.html`, `services/index.html`, `services/garage-door-repair/index.html`, `blog/index.html`.
- No Figma, no slide template provided.

---

## Content Fundamentals

**Voice:** Confident, plain-spoken, professional. Reads like a senior tradesman who happens to be a veteran — direct, no fluff, "we show up and fix it." No corporate-speak, no startup-speak.

**Person:** Mostly **first-person plural ("we")** for the company, **second-person ("you / your")** for the customer. ("We've built our reputation one garage door at a time" / "Get your free estimate today.")

**Casing:**
- **Title Case** for headings & button labels (`Schedule Service`, `Why Homeowners Trust Castle`).
- **ALL CAPS + wide tracking** for short eyebrow labels (`OUR SERVICES`, `VETERAN-OWNED & FAMILY-OPERATED · SINCE 1981`). Always pair with letter-spacing 0.1em+.
- Sentence case for body copy.

**Tone markers (use these freely):**
- Heritage signals: *"Since 1981"*, *"40+ years"*, *"four decades of experience"*.
- Trust stack: *"Licensed, bonded & insured"*, *"CSLB #1154002"*, *"Authorized Home Depot Provider"*, *"Clopay Authorized Dealer"*.
- Urgency without panic: *"24/7 Emergency Service"*, *"Same-day"*, *"Call any time"*.
- Honest pricing: *"No hidden fees, no pressure"*, *"Free estimates"*, *"Fair pricing"*.
- Military / values nod: *"Military values of discipline, integrity, and service excellence"*.

**Specifics:**
- **No emoji.** Anywhere. The brand is blue-collar serious; emoji read as flippant.
- Use **typographic ampersand** `&` (often colored red) inside the wordmark and headings: `Garage Door <red>&</red> Gate Repair`.
- En-dashes & em-dashes used liberally for asides — keep them tight.
- Phone number always formatted `(800) 576-1397`.
- Stars: render as the unicode glyph `★` colored red, never as emoji.
- Star ratings: always "4.4★ from 210+ Reviews" — keep the count visible.

**Examples (lifted verbatim from the site):**
- Hero: *"Garage Door & Gate Repair in San Diego County"*
- Subhead: *"Expert repair, installation, and maintenance from San Diego to Riverside County. Licensed, bonded, and insured — CSLB #1154002."*
- CTA: *"Schedule Service"* / *"Get Your Free Estimate"* / *"Call (800) 576-1397"*
- Testimonial frame: *"On time, professional, no BS."*
- Section eyebrow: *"OUR SERVICES"* → headline *"Expert Garage Door & Gate Solutions"*

---

## Visual Foundations

### Palette — black + red, warm off-white
- **Primary:** near-black `#0F0F0F`. Used for headings, footer, the dark hero.
- **Accent:** Castle Red `#C81E1E`. The single accent color — buttons, links, eyebrow labels, the ampersand, star icons, FAQ chevrons. Hover darkens to `#A51919`.
- **Surfaces:** warm off-white page (`#F5F5F3`), pure white cards (`#FFF`), subtle warm border `#E2E0DC`. The off-white is what gives the site its slightly aged, trustworthy feel — never use pure `#FFFFFF` as the page background.
- **Text:** primary `#1A1A1A`, secondary `#64646E`, muted `#8A8A94`.
- **Restraint:** **two brand colors only.** No teals, blues, purples, gradients-of-color. Semantic green/amber exist but are reserved for true status states.

### Typography — DM Sans + Source Sans 3
- **Display:** **DM Sans** 700 — headings, buttons, eyebrow labels. Tight tracking (`-0.02em`).
- **Body:** **Source Sans 3** 400/500/600 — paragraphs, form fields, captions.
- Eyebrow labels: Source Sans 3 600, ALL CAPS, tracking `0.1em`, red.
- Hero scale: 36px mobile → 52px desktop (mobile-first ramp via media query).

### Backgrounds & imagery
- **Hero:** dark `#0F0F0F` with a photographic background at **0.55 opacity**, plus a left-to-right black gradient overlay (`rgba(15,15,15,0.82) → 0.15`) that anchors the headline. Interior heroes drop the photo to **0.25 opacity** and a stronger overlay.
- **Imagery vibe:** real, sunlit, **warm-tone** photography of suburban garage doors and driveway gates — Southern California residential. No people in stock photos. No illustrated/vector imagery. No grain, no b&w, no synthetic gradients.
- **Section backgrounds alternate** off-white (`--color-bg-light`) and white (`.section-white`) — never colored. The CTA banner is the one exception: solid Castle Red `#C81E1E` with white text.
- **No repeating textures, no patterns, no hand-drawn anything.**

### Spacing & layout
- 4-base spacing scale (`--space-1` … `--space-24`). Sections pad **64px mobile → 96px desktop** vertically.
- Container max-width **1200px**, page gutter 24px (mobile) → 48px (desktop ≥1024).
- Header is **fixed**, 72px tall, shrinking to 64px on scroll, white background with a small bottom shadow.
- Mobile gets a fixed bottom **sticky nav bar** (Home / Services / Call / Schedule), 56px tall.
- Floating "Schedule Service" CTA appears bottom-right on desktop after scroll.

### Borders, radii, shadows
- **Radii:** 6px (small UI like nav pills), `8px` (`--radius`, default — buttons, fields, cards), `12px` (`--radius-lg`, image-y cards/pillars), 50% only for circular numerals/icons.
- **Borders:** 1px `#E2E0DC` for cards, 1.5px on form fields, **2px** on buttons (filled or outline). Card hover sometimes promotes the border to red.
- **Shadows:** four-tier, neutral black, never colored. `sm` 1/2/0.06 for resting cards, `md` 4/12/0.10 on hover, `lg` 12/32/0.14 for the floating CTA, `xl` for modal-class. **No inner shadows.** No glows.

### States & motion
- **Hover (buttons):** background steps from `--color-red` → `--color-red-dark`, shadow upgrades from `sm` → `md`, plus a 1px lift (`translateY(-1px)`).
- **Hover (cards):** shadow upgrades, `translateY(-2px)`.
- **Hover (links/nav):** color → red, plus a 2px red `border-bottom` underline that's transparent at rest.
- **Press/active:** no shrink animation; just the darker color.
- **Focus-visible:** 2px solid red outline at 2px offset on every focusable element.
- **Animation:** restrained. `fade-up` (opacity 0→1, translateY 20px→0, 0.6s ease) on scroll-revealed sections. Header height transition 0.3s. Mobile menu slide-in 0.3s. **No bounces, no springs, no parallax, no auto-playing video.** Honors `prefers-reduced-motion`.

### Transparency & blur
- Used sparingly: the `hero-overlay` gradient, mobile-menu solid white. **No backdrop-blur, no glassmorphism.** Hero photo at 55% opacity is the largest use of transparency on the site.

### Cards
A "card" = white background, `--radius-lg` (12px) corners, 1px `#F0EEEB` border, `--shadow-sm` resting, `--shadow-md` on hover, 32px (`--space-8`) interior padding. **Testimonial cards** add a 3px solid red `border-left`. No left-color-bar on any other card type — keep it reserved for quotes.

### Section rhythm
Eyebrow (red, all-caps, small) → centered headline → centered support paragraph (max-width 680px) → component grid. This is the page's metronome — every section follows it.

---

## Iconography

**See the assets/ folder and the ICONOGRAPHY section below for full details.**

The site uses **inline SVG only** — no icon font, no icon library, no PNG icons. Each `<svg>` is hand-placed where used, sized 14–26px depending on context, and **filled in `--color-red`** for action/accent icons or `currentColor` for neutrals. Stroke icons aren't used; everything is filled-shape.

**Icon families spotted in source:**
- Phone receiver, calendar, checkmark, clock, star, shield, home/Home-Depot mark, building, document, location pin, hamburger lines, chevron, arrow.
- Social: simplified Facebook "f", 5-pointed star (Yelp stand-in), full-color Google "G".

We've extracted the SVGs into `assets/icons/` as standalone files so they can be referenced consistently. **For new icons not in the set, use [Material Symbols filled](https://fonts.google.com/icons) at 24px as a substitute (closest stroke-weight/fill match).** Flag any substitution to the user.

**Emoji & unicode:** No emoji. Unicode glyphs used as content: `★` (red, for ratings), `→` `↦` `▾` (red, for directional/disclosure cues), `&` (often red, the brand ampersand).

---

## Index

- `colors_and_type.css` — design tokens (colors, type, spacing, shadows, radii) + base semantic styles. Import this anywhere you need the brand.
- `styles.css` — full website stylesheet (imported via UI kit). Component-level rules.
- `script.js` — header scroll behavior, mobile menu, fade-up observer.
- `assets/` — `logo.png` (the wordmark) and `icons/` (extracted brand SVGs).
- `preview/` — design-system preview cards (rendered as cards in the Design System tab).
- `ui_kits/website/` — pixel-faithful recreation of the marketing site as React components + a runnable `index.html`.
- `SKILL.md` — Agent-Skill spec so this can be loaded by Claude Code as a brand skill.
- Imported reference HTML at the project root (`index.html`, `contact.html`, `gallery.html`, etc.) for ground-truth comparison.

---

## Caveats & Open Questions

- The current site uses **Unsplash stock URLs** for all photography. A real production deploy needs Castle's own job-site photography. Treat all `images.unsplash.com` URLs as placeholders.
- No real logo SVG was provided — only `logo.png`. A vector wordmark would be ideal.
- Fonts are loaded from Google Fonts (DM Sans + Source Sans 3); no local TTFs needed.
- No icon system file in the source — icons are loose inline SVGs. We've extracted them into `assets/icons/` here, but coverage is limited to what appears on the live site.
- No slide template was provided, so no `slides/` directory was generated.
