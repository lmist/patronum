/**
 * The Patronum mark for the terminal: a shield with a four-point star.
 * Drawn from src/dashboard/web/public/brand/patronum.svg by
 * `bun scripts/logo-ascii.ts`; regenerate it there if the logo changes.
 */
export const LOGO = `
     ▄▄▄▄▄▄
     ██████
   ▄▄███████▄
 ▄████████████▄
 ██████▀▀██████
 ██████  ██████
 █████▀  ▀█████
 ████      ████
 █████    █████
 ██████  ██████
 ██████  █████▀
 ███████████▀
  ▀████████▀
    ▀████▀
       ▀
`.slice(1, -1);

/** The logo with a few lines of text set to its right, starting at `firstRow`. */
export function logoWith(lines: string[], firstRow = 5): string {
  const rows = LOGO.split("\n");
  const width = Math.max(...rows.map((row) => row.length)) + 3;
  return rows
    .map((row, index) => {
      const text = lines[index - firstRow];
      return text ? row.padEnd(width) + text : row;
    })
    .join("\n");
}
