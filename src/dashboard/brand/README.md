# Patronum mark

The logo was drawn in Paper. `paper.svg` preserves the original export and symbol paths.

- `../web/public/brand/patronum.svg`: capped mark, used in the header and default icons.
- `../web/public/brand/patronum-pointed.svg`: pointed alternate.
- `*-light.svg`: reversed marks for dark surfaces.
- `icons/` and `icons-pointed/`: platform icons, splash images, manifests, and HTML references for each variant.
- `*-social.png`: 1080 × 1080 square images.
- `*-og.png`: 1200 × 630 link-preview images.

Run `bun run brand` to regenerate assets and the document's icon and social metadata using the pinned `favicons` package. SVG source paths remain unchanged. Run `bun run dash:build` afterward to copy the public assets into the dashboard build. For a deployment under a path prefix, set the same `PATRONUM_DASH_BASE` for both commands.

The dashboard is local. Social images are ready to use, but external preview services cannot access localhost. A public deployment should use its own absolute image URLs in social metadata.
