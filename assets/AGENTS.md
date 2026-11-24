Parent DOX: [project](../AGENTS.md).

# Purpose

Original Tuxee artwork and supplied source media. Nothing here is bundled:
the frontend build and Go embed never read `assets/`, and `.dockerignore`
excludes it from the Docker context.

# Ownership

Own the user-supplied horizontal, vertical and emblem PNGs.
`tuxee-logo-*-light.png` are transparent light-theme edits; preserve the
original PNGs separately.
`howto/` keeps the supplied How to screenshots (PNG, or the earliest
full-resolution WebP when no PNG exists) under the base names of their
optimized `web/howto-*.webp` copies.
`readme/` keeps supplied README screenshot originals under the base names of
their optimized copies in `.github/resources/screenshots/`.
`web/` owns optimized runtime copies; `.github/resources/` owns README copies.

# Local Contracts

Preserve original artwork. Reuse existing logos; do not replace them with
generated approximations or treat them as disposable build output.
Light variants remove the backdrop and recolor only “Tux” to black, preserving
the yellow hexagon/“ee”, typography and opaque black-and-white penguin.
Login uses the transparent dark vertical WebP owned by `web/`; keep the original
dark PNG unchanged here.

# Work Guidance

Store every newly supplied image here before deriving optimized copies; never
reference `assets/` from code, the build or the Dockerfile.
When replacing a How to screenshot, store the original as
`howto/<webp-base-name>.png`, then export the WebP at about twice its rendered
CSS width: 1800px for full-width guide images (the modal content is about 900px),
872px for half-column images beside copy, or twice the CSS cap for constrained side images (e.g. 514px for the 257px
desktop menu). Use quality around 82, keep size budgets from `web/AGENTS.md`
and update the width/height passed to `screenshot()` in `web/how-to.ts` and
`tests/how-to.mjs`. Crop exports, never the originals, so the guide's own
border frames clean content: drop the 4px capture line above the Tips favorites
and customization screenshots, and crop the Tips processes screenshot to the
inside of the modal border (11,17–1807,1603 of the original) so no page
backdrop remains. README copies follow `.github/resources/AGENTS.md`.

# Verification

# Child DOX Index

No children.
