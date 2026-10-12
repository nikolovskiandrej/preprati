# Brand

## Wordmark

- Always **`preprati.`** — lowercase Latin letters, bold, with the period. Never "Preprati", "PREPRATI", "PrePrati" or Cyrillic, in any locale.
- The logo wordmark is vector outlines (`src/client/brand/geometry.ts`) of **Outfit ExtraBold** (SIL Open Font License), tracked −0.03em, with the "ti" pair opened slightly. A thin round-joined stroke of the same colour softens the corners, echoing the hand-made mark. Outlining guarantees identical rendering everywhere and frees the UI typeface choice.
- Letters take the text colour (charcoal on light, cream on dark). The period is **always tangerine**.

## Mark

A hand-cut paper plane, split into wing and keel by a slit, trailing a looping hand-drawn line. Vectorised from the supplied concept (`Современ концепт за бренд Препрати.png`) and traced against it.

| Asset                                                                                                       | Use                                                            |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Full mark (plane + long looping trail + three spark dashes)                                                 | Home hero (`HeroMark`), draws itself once on first view        |
| Compact mark (plane + short loop)                                                                           | Header lockup, intro, favicon, app icons, QR image exports     |
| `public/favicon.svg`, `favicon-32.png`, `apple-touch-icon.png`, `icon-192/512.png`, `icon-maskable-512.png` | Browser and home-screen icons, generated from the compact mark |

Keep the mark tangerine. Don't add effects, outlines or gradients, and don't use the concept image itself in the product.

## Colour

| Token     | Hex       | Role                                           |
| --------- | --------- | ---------------------------------------------- |
| Cream     | `#FFF7ED` | Main light background                          |
| Tangerine | `#F97316` | Primary actions, the brand period, accents     |
| Charcoal  | `#252525` | Text, dark surfaces, **Quick Transfer** panels |
| Peach     | `#FED7AA` | Soft surfaces, **Share Files** panels          |

Derived shades (in `src/client/styles/tokens.css`) exist only for contrast and states: accent ink `#C2410C` for small tangerine text on light (tangerine on cream is just 2.8:1), muted text `#6B625B`/`#776D66`, hairlines, hover tints, and sparing success/danger colours that always come with an icon and words.

- **Mode colour-coding:** charcoal means "live, both devices now" (Quick Transfer); peach means "for later" (Share Files). Screens and panels keep that tint so the mode is recognisable at a glance.
- **Primary buttons:** tangerine with a **charcoal** label (5.5:1). White on tangerine (2.8:1) is not used.
- **QR codes:** always charcoal on white with a 4-module quiet zone, even in dark mode.

## Typography

**Manrope Variable** (self-hosted via Fontsource; Latin, Latin Extended and Cyrillic including Ѓ Ќ Ѕ Ј Љ Њ Џ for Macedonian) for all interface text:

- Display headline: 800, −0.05em, tight leading (`From here to there.`)
- Screen titles: 800, −0.035em. Body: 500 at 17px. Numbers use tabular figures.
- No all-caps labels, no monospace, no decorative arrows on buttons.

## Motion

One orchestrated moment per screen; everything else answers an action.

- **Intro (≤1.25 s, once per session, home only):** outline draws → fill lands with a small spring → loop draws → wordmark wipes in → the lockup flies into the header (shared-layout transition). Skipped for deep links, automation and `prefers-reduced-motion`.
- **Hero:** the trail draws itself once.
- **State changes:** short cross-fades within panels; dialogs scale (desktop) or slide up as sheets (phones); copy confirmations morph the icon into a check.
- **Progress:** spring-smoothed bar with a small plane riding its leading edge.
- Transform/opacity only; `MotionConfig reducedMotion="user"`.

## Voice

Plain, specific and calm. Say what happens ("Encrypt & create link", "Delete Share"), say what went wrong and what to do next, never over-promise privacy ("Anyone with the complete link can download them").

## Notea attribution

"Made by" + the Notea mark + "Notea", small, in the footer. It links to `NOTEA_URL` when configured.

The mark is transparent on both appearances, with no tile behind it:

- Light: Notea's dark green mark (`src/client/assets/notea-logo.png`), cut from the original artwork `Pasted image.png`.
- Dark: Notea's own mint mark (`src/client/assets/notea-logo-on-dark.png`), the version noteawork.com shows on its dark pages. The dark green would disappear on a dark background.

Both files are 130×96 px, trimmed to the mark, with the original proportions (about 1.35:1). The footer sets only the height, so the width always follows that ratio.
