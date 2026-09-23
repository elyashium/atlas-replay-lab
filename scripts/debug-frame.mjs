import { readFile } from "node:fs/promises";
import { decodePng } from "../src/image/png.js";
const file = process.argv[2];
const png = decodePng(await readFile(file));
console.log("size:", png.width, "x", png.height);
// Background clear color is rgb(16,20,24) approx. Find bounding columns/rows
// that differ from it beyond tolerance.
const bg = [16, 20, 24];
let minX = png.width, maxX = -1, minY = png.height, maxY = -1, n = 0;
for (let y = 0; y < png.height; y++) {
  for (let x = 0; x < png.width; x++) {
    const i = (y * png.width + x) * 4;
    const d = Math.abs(png.data[i] - bg[0]) + Math.abs(png.data[i + 1] - bg[1]) + Math.abs(png.data[i + 2] - bg[2]);
    if (d > 24) {
      n++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}
console.log("subject pixels:", n, "x-range:", minX, "-", maxX, "width frac:", ((maxX - minX + 1) / png.width).toFixed(2));
