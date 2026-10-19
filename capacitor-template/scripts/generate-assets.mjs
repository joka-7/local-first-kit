// Generates the Android launcher icon layers and splash screens from one square
// icon (512 px or larger), so an app needs a single image instead of ten.
//   Usage (from the app repo, after `npx cap add android`):
//     node generate-assets.mjs <icon.png> <background-hex, e.g. #14B8A6>
// Needs Playwright's Chromium (set CHROMIUM_PATH to use another browser).
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [iconPath, background] = process.argv.slice(2);
if (!iconPath || !/^#[0-9a-fA-F]{6}$/.test(background ?? '')) {
  console.error('usage: node generate-assets.mjs <icon.png> <background-hex like #14B8A6>');
  process.exit(1);
}

const RES = 'android/app/src/main/res';
const icon = `data:image/png;base64,${(await readFile(iconPath)).toString('base64')}`;

const html = (w, h, body) => `<body style="margin:0;width:${w}px;height:${h}px;overflow:hidden;background:transparent">${body}</body>`;
const centered = (w, h, size, extra = '') => `<img src="${icon}" style="position:absolute;left:${(w - size) / 2}px;top:${(h - size) / 2}px;width:${size}px;height:${size}px;${extra}">`;

// Android keeps only the inner 66 of 108 units visible under any adaptive-icon mask.
const foreground = (s) => html(s, s, centered(s, s, s * (66 / 108)));
const solid = (s) => html(s, s, `<div style="width:${s}px;height:${s}px;background:${background}"></div>`);
const legacy = (s, round) => html(s, s,
  `<div style="width:${s}px;height:${s}px;background:${background};border-radius:${round ? '50%' : `${s * 0.22}px`};overflow:hidden;position:relative">${centered(s, s, s * 0.72)}</div>`);
const splash = (w, h) => html(w, h,
  `<div style="width:${w}px;height:${h}px;background:${background};position:relative">${centered(w, h, Math.min(w, h) * 0.5)}</div>`);

const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const SPLASH_SIZES = { mdpi: [320, 480], hdpi: [480, 800], xhdpi: [720, 1280], xxhdpi: [960, 1600], xxxhdpi: [1280, 1920] };

// [file, markup, [width, height], transparent]
const jobs = [];
for (const [name, scale] of Object.entries(DENSITIES)) {
  const dir = `${RES}/mipmap-${name}`;
  const big = 108 * scale;
  const small = 48 * scale;
  jobs.push([`${dir}/ic_launcher_foreground.png`, foreground(big), [big, big], true]);
  jobs.push([`${dir}/ic_launcher_background.png`, solid(big), [big, big], false]);
  jobs.push([`${dir}/ic_launcher.png`, legacy(small, false), [small, small], true]);
  jobs.push([`${dir}/ic_launcher_round.png`, legacy(small, true), [small, small], true]);
}
for (const [name, [shortSide, longSide]] of Object.entries(SPLASH_SIZES)) {
  jobs.push([`${RES}/drawable-port-${name}/splash.png`, splash(shortSide, longSide), [shortSide, longSide], false]);
  jobs.push([`${RES}/drawable-land-${name}/splash.png`, splash(longSide, shortSide), [longSide, shortSide], false]);
}
jobs.push([`${RES}/drawable/splash.png`, splash(480, 320), [480, 320], false]);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
try {
  const page = await browser.newPage();
  for (const [file, markup, [w, h], transparent] of jobs) {
    await page.setViewportSize({ width: w, height: h });
    await page.setContent(markup);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, await page.screenshot({ omitBackground: transparent, clip: { x: 0, y: 0, width: w, height: h } }));
  }
} finally {
  await browser.close();
}
await writeFile(`${RES}/values/ic_launcher_background.xml`,
  `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${background}</color>\n</resources>\n`);
console.log(`Wrote ${jobs.length} images and the launcher background colour.`);
