// npm run build:icon
//
// Renders the icon of Dreamcast DevTools from its two SVGs in branding/icon/ with Playwright's headless Chromium:
//
//   branding/icon/png/dreamcast-devtools-<size>.png  every size of PNG_SIZES, with transparent corners: the sizes below
//                                                    SMALL_BELOW from dreamcast-devtools-small.svg, the others from
//                                                    dreamcast-devtools.svg
//   branding/icon/preview.png                        the PNGs of PREVIEW_SIZES on a dark, a mid-grey and a light background
//   public/dreamcast-devtools-<size>.png             the sizes of PUBLIC_SIZES, the ones index.html links
//
// Nothing here is run by the build or the tests: the PNGs are committed. scripts/build-icon.test.ts holds them to their
// sizes, public/ to branding/icon/png/ and index.html to public/.
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const ICON_DIR = join(ROOT, "branding", "icon");
export const PNG_DIR = join(ICON_DIR, "png");
export const PUBLIC_DIR = join(ROOT, "public");

/** Below this size the small SVG is rendered: the full one's rings and hole blur together at 16 and 24 px. */
export const SMALL_BELOW = 32;

export const PNG_SIZES = [16, 24, 32, 48, 64, 128, 180, 192, 256, 512, 1024] as const;

/** The PNGs index.html links: favicons of 16, 32 and 192 px, the apple-touch-icon (180), og:image and twitter:image (512). */
export const PUBLIC_SIZES = [16, 32, 180, 192, 512] as const;

const PREVIEW_SIZES = [16, 24, 32, 48, 64, 128, 256] as const;
const PREVIEW_BACKGROUNDS = ["#0f111a", "#35363a", "#f1f3f4"] as const;

export const pngName = (size: number): string => `dreamcast-devtools-${size}.png`;

export const svgFor = (size: number): string =>
  join(ICON_DIR, size < SMALL_BELOW ? "dreamcast-devtools-small.svg" : "dreamcast-devtools.svg");

const dataUri = (file: string, type: string): string => `data:${type};base64,${readFileSync(file).toString("base64")}`;

const main = async (): Promise<void> => {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    const decoded = () => page.locator("img").evaluateAll((images: HTMLImageElement[]) => Promise.all(images.map((image) => image.decode())));
    mkdirSync(PNG_DIR, { recursive: true });
    for (const size of PNG_SIZES) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(
        `<body style="margin:0"><img src="${dataUri(svgFor(size), "image/svg+xml")}" width="${size}" height="${size}" style="display:block"></body>`,
      );
      await decoded();
      await page.screenshot({ path: join(PNG_DIR, pngName(size)), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    }
    const rows = PREVIEW_BACKGROUNDS.map(
      (background) =>
        `<div style="display:flex;align-items:center;gap:28px;padding:14px;background:${background}">` +
        PREVIEW_SIZES.map((size) => `<img src="${dataUri(join(PNG_DIR, pngName(size)), "image/png")}" width="${size}" height="${size}">`).join("") +
        "</div>",
    ).join("");
    await page.setViewportSize({ width: 1000, height: 1000 });
    await page.setContent(`<body style="margin:0"><div id="preview" style="display:inline-block">${rows}</div></body>`);
    await decoded();
    await page.locator("#preview").screenshot({ path: join(ICON_DIR, "preview.png") });
  } finally {
    await browser.close();
  }
  mkdirSync(PUBLIC_DIR, { recursive: true });
  for (const size of PUBLIC_SIZES) {
    copyFileSync(join(PNG_DIR, pngName(size)), join(PUBLIC_DIR, pngName(size)));
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
