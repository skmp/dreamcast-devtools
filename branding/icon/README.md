# The icon of Dreamcast DevTools

Angle brackets, for developer tools, around an orange GD-ROM, the Dreamcast's disc, on a tile in the UI's own colors
(the background `#0f111a`, the accent `#4fc3f7`). It is original artwork: no Sega mark is used.

- `dreamcast-devtools.svg`: the icon, for 32 px and larger.
- `dreamcast-devtools-small.svg`: a pixel-aligned simplification for 16 and 24 px, where the full icon's rings and
  hole blur together: bolder brackets, a smaller disc, no rings.
- `png/`: the icon pre-rendered, with transparent corners: 16 and 24 px from the small SVG; 32, 48, 64, 128, 180, 192,
  256, 512 and 1024 px from the full one.
- `preview.png`: the PNGs of 16 to 256 px on a dark, a mid-grey and a light background.

`index.html` links the favicons of 16, 32 and 192 px, the apple-touch-icon (180 px) and the og:image / twitter:image
(512 px); copies of those five are in `public/`.

After a change to an SVG, `npm run build:icon` renders the PNGs and the preview again with Playwright's headless
Chromium and copies the five into `public/`. `scripts/build-icon.test.ts` checks the sizes, the copies and the links.
