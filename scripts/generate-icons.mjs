/**
 * Generate Android launcher icons + splash icon from the CareCall
 * bell SVG, with "CareCall" text below the bell.
 *
 * Outputs:
 *   - android/app/src/main/res/mipmap-{m,h,xh,xxh,xxxh}dpi/ic_launcher.png
 *   - android/app/src/main/res/mipmap-{m,h,xh,xxh,xxxh}dpi/ic_launcher_round.png
 *   - android/app/src/main/res/mipmap-{m,h,xh,xxh,xxxh}dpi/ic_launcher_foreground.png
 */
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Bell + CareCall text SVG — designed for a 512×512 canvas.
// Bell sits in the upper area, "CareCall" text centered below.
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" rx="102" fill="#0D1520"/>
  <circle cx="256" cy="230" r="170" fill="#162032"/>
  <!-- Bell body -->
  <path d="M256 100 C190 100 140 155 140 230 L140 275 L126 290 L386 290 L372 275 L372 230 C372 155 322 100 256 100 Z" fill="#0EA5E9"/>
  <!-- Clapper -->
  <circle cx="256" cy="310" r="22" fill="#0EA5E9"/>
  <!-- Top knob -->
  <circle cx="256" cy="90" r="14" fill="#38BDF8"/>
  <!-- CareCall text -->
  <text x="256" y="420" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="700" font-size="72" fill="#F1F5F9" letter-spacing="2">
    <tspan>Care</tspan><tspan fill="#0EA5E9">Call</tspan>
  </text>
</svg>`;

// Foreground-only SVG (transparent bg) for adaptive icons.
// Adaptive icons use 108dp canvas; inner 72dp is visible (the rest is parallax).
// We place the bell at the center, scaled to fit the 72dp safe zone.
const FOREGROUND_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="108" height="108">
  <!-- 18dp padding on each side; visible area is 72dp centered.
       Bell scaled to match the compact proportions of the PWA icon
       (ic_launcher.png), not the larger fill from the first version. -->
  <!-- Background circle (subtle, matches the full icon) -->
  <circle cx="54" cy="48" r="28" fill="#162032"/>
  <!-- Bell body (compact — ~32dp wide) -->
  <path d="M54 30 C43 30 35 39 35 50 L35 57 L33 59 L75 59 L73 57 L73 50 C73 39 65 30 54 30 Z" fill="#0EA5E9"/>
  <!-- Clapper -->
  <circle cx="54" cy="63" r="4" fill="#0EA5E9"/>
  <!-- Top knob -->
  <circle cx="54" cy="28" r="2.5" fill="#38BDF8"/>
  <!-- CareCall text -->
  <text x="54" y="82" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="700" font-size="10" fill="#F1F5F9" letter-spacing="0.3">
    <tspan>Care</tspan><tspan fill="#0EA5E9">Call</tspan>
  </text>
</svg>`;

// Android mipmap density → pixel size mappings
const DENSITIES = {
  'mipmap-mdpi':    48,
  'mipmap-hdpi':    72,
  'mipmap-xhdpi':   96,
  'mipmap-xxhdpi':  144,
  'mipmap-xxxhdpi': 192,
};

const FOREGROUND_DENSITIES = {
  'mipmap-mdpi':    108,
  'mipmap-hdpi':    162,
  'mipmap-xhdpi':   216,
  'mipmap-xxhdpi':  324,
  'mipmap-xxxhdpi': 432,
};

const RES_DIR = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');

async function generate() {
  // Generate standard launcher icons
  for (const [dir, size] of Object.entries(DENSITIES)) {
    const outDir = path.join(RES_DIR, dir);
    fs.mkdirSync(outDir, { recursive: true });

    // Square icon
    await sharp(Buffer.from(ICON_SVG))
      .resize(size, size)
      .png()
      .toFile(path.join(outDir, 'ic_launcher.png'));

    // Round icon (same image, Android clips to circle)
    await sharp(Buffer.from(ICON_SVG))
      .resize(size, size)
      .png()
      .toFile(path.join(outDir, 'ic_launcher_round.png'));

    console.log(`✅ ${dir}: ${size}×${size}`);
  }

  // Generate foreground layers for adaptive icons
  for (const [dir, size] of Object.entries(FOREGROUND_DENSITIES)) {
    const outDir = path.join(RES_DIR, dir);
    fs.mkdirSync(outDir, { recursive: true });

    await sharp(Buffer.from(FOREGROUND_SVG))
      .resize(size, size)
      .png()
      .toFile(path.join(outDir, 'ic_launcher_foreground.png'));

    console.log(`✅ ${dir} foreground: ${size}×${size}`);
  }

  console.log('\n🎉 All Android icons generated!');

  // ── iOS App Icon ──
  // iOS requires a single 1024×1024 PNG in the asset catalog.
  // Xcode auto-generates all smaller sizes from this.
  const IOS_ICON_DIR = path.join(__dirname, '..', 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset');
  if (fs.existsSync(path.join(__dirname, '..', 'ios'))) {
    fs.mkdirSync(IOS_ICON_DIR, { recursive: true });

    // Generate 1024×1024 icon
    await sharp(Buffer.from(ICON_SVG))
      .resize(1024, 1024)
      .png()
      .toFile(path.join(IOS_ICON_DIR, 'AppIcon-1024.png'));

    // Write the Contents.json that tells Xcode to use this single image
    const contents = {
      images: [
        {
          filename: 'AppIcon-1024.png',
          idiom: 'universal',
          platform: 'ios',
          size: '1024x1024'
        }
      ],
      info: { version: 1, author: 'carecall-generate-icons' }
    };
    fs.writeFileSync(path.join(IOS_ICON_DIR, 'Contents.json'), JSON.stringify(contents, null, 2));

    console.log('✅ iOS: 1024×1024 AppIcon');
    console.log('\n🎉 All iOS icons generated!');
  } else {
    console.log('\n⚠️  ios/ directory not found — skipping iOS icons');
  }
}

generate().catch(e => { console.error(e); process.exit(1); });
