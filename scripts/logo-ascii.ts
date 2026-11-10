/**
 * Draw the Patronum mark with block characters for the terminal.
 *
 *   bun scripts/logo-ascii.ts [svg] [columns]
 *
 * Paste the output into src/cmd/patronum-logo.ts after the logo changes.
 */
import sharp from "sharp";
const [fileArg, colsArg] = process.argv.slice(2);
const file = fileArg ?? "src/dashboard/web/public/brand/patronum.svg";
const cols = Number(colsArg ?? 16);
const meta = await sharp(file!).metadata();
const rows = Math.round(cols * (meta.height! / meta.width!) * 0.5);
// 2x vertical, 2x horizontal subsamples per cell for half-block rendering
const { data, info } = await sharp(file!, { density: 600 }).flatten({ background: "#ffffff" }).resize(cols, rows * 2, { fit: "fill" }).greyscale().raw().toBuffer({ resolveWithObject: true });
const dark = (x: number, y: number) => data[y * info.width + x]! < 140;
let out = "";
for (let y = 0; y < rows; y++) {
  let line = "";
  for (let x = 0; x < cols; x++) {
    const top = dark(x, y * 2), bottom = dark(x, y * 2 + 1);
    line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
  }
  out += line.replace(/\s+$/, "") + "\n";
}
console.log(out);
