Parent DOX: [GitHub resources and releases](../AGENTS.md).

# Purpose

Optimized images for the root README.

# Ownership

`screenshots/` owns full-size WebP screenshots, a JPG metrics infographic and
matching `-thumb` previews. Original JPGs and PNGs stay in `../../assets/`
under the same descriptive names.

# Local Contracts

Preserve image content and aspect ratio. Full screenshots retain their original
dimensions; the metrics infographic uses a lightly compressed 1000-pixel JPG.
Thumbnails are at most 640 pixels wide. The README displays
thumbnails, alternating image/text sides, and links each to its full image with
`target="_blank"` and `rel="noopener noreferrer"`.

# Work Guidance

Use descriptive filenames reflecting the feature shown. Keep these documentation
assets separate from embedded frontend assets.

# Verification

Verify each README image/link resolves, both image variants decode, and
thumbnail dimensions preserve the source aspect ratio. Preview the table in a
browser after changing images or markup.

# Child DOX Index

No children.
