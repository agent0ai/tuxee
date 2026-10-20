Parent DOX: [GitHub resources and releases](../AGENTS.md).

# Purpose

Optimized images for the root README.

# Ownership

`screenshots/` owns full-size WebP screenshots and matching `-thumb.webp`
previews. Original JPGs stay in `../../assets/` under the same descriptive names.

# Local Contracts

Preserve screenshot content and aspect ratio. Full images retain their original
dimensions; thumbnails are at most 640 pixels wide. The README displays
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
