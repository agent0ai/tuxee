Parent DOX: [GitHub resources and releases](../AGENTS.md).

# Purpose

Optimized images for the root README.

# Ownership

`screenshots/` owns WebP screenshots, infographics and matching `-thumb.webp`
previews. Keep these optimized copies only; do not retain
duplicate screenshot or infographic originals in `../../assets/`.

# Local Contracts

Use WebP for every image and thumbnail. Preserve image content and aspect ratio.
Full screenshots retain their original dimensions; the metrics infographic is 1000 pixels wide.
Thumbnails are at most 640 pixels wide. The README displays
thumbnails, alternating image/text sides, and links each to its full image with
`target="_blank"` and `rel="noopener noreferrer"`.

# Work Guidance

Use descriptive filenames reflecting the feature shown. Keep these documentation
assets separate from embedded frontend assets.

# Verification

Verify each README image/link resolves, both image variants decode as WebP, and
thumbnail dimensions preserve the source aspect ratio. Preview the table in a
browser after changing images or markup.

# Child DOX Index

No children.
