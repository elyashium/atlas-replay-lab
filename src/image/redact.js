import { decodePng, encodePng } from "./png.js";

/**
 * Opaque-redact DOM rectangles in a Chromium PNG without changing the page.
 * Rectangles use CSS viewport coordinates; screenshot scale is derived from the
 * image size so device-pixel-ratio profiles are handled without guessing.
 *
 * @param {Buffer} png
 * @param {Array<{x:number;y:number;width:number;height:number}>} rectangles
 * @param {{cssOriginX?:number;cssOriginY?:number;cssWidth:number;cssHeight:number;paddingCssPx?:number}} viewport
 */
export function redactPngRectangles(png, rectangles, viewport) {
  if (!Array.isArray(rectangles) || !rectangles.length) throw new Error("at least one measured redaction rectangle is required");
  const { cssOriginX = 0, cssOriginY = 0, cssWidth, cssHeight, paddingCssPx = 12 } = viewport ?? {};
  if (![cssOriginX, cssOriginY, cssWidth, cssHeight, paddingCssPx].every(Number.isFinite) || cssWidth <= 0 || cssHeight <= 0 || paddingCssPx < 0 || paddingCssPx > 128) {
    throw new Error("invalid screenshot viewport for redaction");
  }
  const image = decodePng(png);
  const scaleX = image.width / cssWidth;
  const scaleY = image.height / cssHeight;
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) throw new Error("screenshot has invalid redaction scale");

  for (const rect of rectangles) {
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
      throw new Error("invalid screenshot redaction rectangle");
    }
    const left = Math.max(0, Math.floor((rect.x - cssOriginX - paddingCssPx) * scaleX));
    const top = Math.max(0, Math.floor((rect.y - cssOriginY - paddingCssPx) * scaleY));
    const right = Math.min(image.width, Math.ceil((rect.x + rect.width - cssOriginX + paddingCssPx) * scaleX));
    const bottom = Math.min(image.height, Math.ceil((rect.y + rect.height - cssOriginY + paddingCssPx) * scaleY));
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const offset = (y * image.width + x) * 4;
        image.data[offset] = 0;
        image.data[offset + 1] = 0;
        image.data[offset + 2] = 0;
        image.data[offset + 3] = 255;
      }
    }
  }
  return encodePng(image);
}
