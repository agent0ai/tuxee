Parent DOX: [GitHub resources and releases](../AGENTS.md).

# Purpose

Optimized images for the root README.

# Ownership

`tuxee-video-preview.webp` is the README hero, preserving the supplied video
artwork at its original dimensions with subtly rounded transparent corners.
`screenshots/` owns WebP screenshots, infographics and matching `-thumb.webp`
previews. Keep these optimized copies only; do not retain
duplicate screenshot or infographic originals in `../../assets/`.

# Local Contracts

Use WebP for every image and thumbnail. Preserve image content and aspect ratio.
Use modest antialiased transparent corners, scaled for consistent visible rounding;
keep each thumbnail and full image's corner proportions aligned. Compress images
without materially degrading text; generate thumbnails from the best full-size source.
Full images retain their dimensions; no image type has a separate width requirement.
Screenshot/infographic thumbnails are at most 640 pixels wide. The Highlights table displays
thumbnails, alternating image/text sides, and links each to its full image with
`target="_blank"` and `rel="noopener noreferrer"`.

# Work Guidance

Use descriptive filenames reflecting the feature shown. Keep these documentation
assets separate from embedded frontend assets.

# Verification

Verify each README image/link resolves, both image variants decode as WebP, and
thumbnail dimensions preserve the source aspect ratio. Check transparent corners
and compare loaded image bytes. Preview images and links in light/dark browser
layouts and at phone width after changing images or markup.

# Child DOX Index

No children.
