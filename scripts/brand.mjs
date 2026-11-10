import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { favicons } from 'favicons';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = resolve(root, 'src/dashboard/web/public');
const brandDir = resolve(publicDir, 'brand');
const background = '#111113';
const foreground = '#f3f3f4';
const base = (process.env.PATRONUM_DASH_BASE ?? '/').replace(/\/?$/, '/');
let head;

for (const variant of ['patronum', 'patronum-pointed']) {
  const source = await readFile(resolve(brandDir, `${variant}.svg`), 'utf8');
  const light = source.replaceAll('fill="#111113"', `fill="${foreground}"`);
  await writeFile(resolve(brandDir, `${variant}-light.svg`), light);
  const shape = light.match(/<path[^>]+\/>/)[0];
  const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 180 180"><rect width="180" height="180" fill="${background}"/><g transform="translate(55 25)">${shape}</g></svg>`;
  const dir = resolve(brandDir, variant === 'patronum' ? 'icons' : 'icons-pointed');
  const url = `${base}brand/${variant === 'patronum' ? 'icons' : 'icons-pointed'}`;
  await mkdir(dir, { recursive: true });
  const response = await favicons(Buffer.from(icon), {
    path: url,
    appName: 'Patronum',
    appShortName: 'Patronum',
    appDescription: 'Local Instagram collection and media analysis workspace.',
    background,
    theme_color: background,
    display: 'standalone',
    start_url: base,
    scope: base,
    lang: 'en',
    manifestMaskable: true,
    icons: { android: true, appleIcon: true, appleStartup: true, favicons: true, windows: true, yandex: true },
  });
  await Promise.all([...response.images, ...response.files].map(file => writeFile(resolve(dir, file.name), file.contents)));
  await writeFile(resolve(dir, 'head.html'), response.html.join('\n') + '\n');
  await sharp(Buffer.from(source)).resize({ height: 1024 }).png().toFile(resolve(brandDir, `${variant}.png`));
  await sharp(Buffer.from(light)).resize({ height: 1024 }).png().toFile(resolve(brandDir, `${variant}-light.png`));
  await sharp(Buffer.from(icon)).resize(1080, 1080).png().toFile(resolve(brandDir, `${variant}-social.png`));
  const card = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="${background}"/><g transform="translate(170 170) scale(2.2)">${shape}</g><text x="390" y="315" fill="${foreground}" font-family="Inter, Arial, sans-serif" font-size="84" font-weight="600" letter-spacing="-3">patronum</text><text x="395" y="372" fill="#babcc5" font-family="Inter, Arial, sans-serif" font-size="25">Content workspace</text></svg>`;
  await sharp(Buffer.from(card)).png().toFile(resolve(brandDir, `${variant}-og.png`));
  if (variant === 'patronum') {
    head = response.html.join('\n    ');
    await copyFile(resolve(dir, 'favicon.ico'), resolve(publicDir, 'favicon.ico'));
    const adaptive = source.replace('fill="#111113"', 'class="mark"').replace('<path ', '<style>.mark{fill:#111113}@media(prefers-color-scheme:dark){.mark{fill:#f3f3f4}}</style>\n  <path ');
    await writeFile(resolve(publicDir, 'favicon.svg'), adaptive);
  }
  console.log(`${variant}: ${response.images.length} icons and splash images, ${response.files.length} manifests, SVG/PNG variants and social images`);
}

const indexPath = resolve(root, 'src/dashboard/web/index.html');
const index = await readFile(indexPath, 'utf8');
const block = `<!-- brand:start -->\n    <link rel="icon" type="image/svg+xml" href="${base}favicon.svg" />\n    ${head}\n    <meta name="description" content="Local Instagram collection and media analysis workspace." />\n    <meta property="og:type" content="website" />\n    <meta property="og:site_name" content="Patronum" />\n    <meta property="og:title" content="Patronum — Content workspace" />\n    <meta property="og:description" content="Local Instagram collection and media analysis workspace." />\n    <meta property="og:image" content="${base}brand/patronum-og.png" />\n    <meta property="og:image:width" content="1200" />\n    <meta property="og:image:height" content="630" />\n    <meta property="og:image:alt" content="Patronum logo and wordmark" />\n    <meta name="twitter:card" content="summary_large_image" />\n    <meta name="twitter:title" content="Patronum — Content workspace" />\n    <meta name="twitter:description" content="Local Instagram collection and media analysis workspace." />\n    <meta name="twitter:image" content="${base}brand/patronum-og.png" />\n    <meta name="twitter:image:alt" content="Patronum logo and wordmark" />\n    <!-- brand:end -->`;
await writeFile(indexPath, index.includes('<!-- brand:start -->')
  ? index.replace(/<!-- brand:start -->[\s\S]*?<!-- brand:end -->/, block)
  : index.replace('    <meta name="theme-color" content="#111113" />', `    ${block}`));
