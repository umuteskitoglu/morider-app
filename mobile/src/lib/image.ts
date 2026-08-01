// Downscaling for anything the user uploads. Phone cameras hand us 12-48MP
// files (3-8 MB even at picker quality 0.7); shipping those to the server means
// slow uploads and, worse, a full-res decode on every device that later scrolls
// past the photo — which is what made the feed stutter during pinch-zoom.
// Everything goes through here so the wire format is always a sanely sized JPEG.
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

// Long edge caps. Feed photos are shown full-bleed and can be pinched to 4x, so
// 1600px still looks sharp on a 3x screen; avatars never render bigger than a
// list row or the profile header.
export const PHOTO_MAX_EDGE = 1600;
export const AVATAR_MAX_EDGE = 512;

const PHOTO_QUALITY = 0.82;

export type PickedAsset = { uri: string; width?: number; height?: number; mimeType?: string };
export type PreparedImage = { uri: string; mimeType: string };

/**
 * Resize `asset` so its long edge is at most `maxEdge` and re-encode it as JPEG.
 * Falls back to the original URI if manipulation fails — a slightly heavy upload
 * beats blocking the user on an unshareable photo.
 */
export async function prepareImageUpload(
  asset: PickedAsset,
  maxEdge: number = PHOTO_MAX_EDGE,
  compress: number = PHOTO_QUALITY,
): Promise<PreparedImage> {
  try {
    const ctx = ImageManipulator.manipulate(asset.uri);

    // The picker gives us dimensions up front; when it doesn't (or they look
    // bogus) render once just to measure, then resize off that reference.
    let { width, height } = asset;
    if (!width || !height) {
      const measured = await ctx.renderAsync();
      width = measured.width;
      height = measured.height;
    }

    const target = resizeTarget(width, height, maxEdge);
    if (target) ctx.resize(target);

    const rendered = await ctx.renderAsync();
    const out = await rendered.saveAsync({ format: SaveFormat.JPEG, compress });
    return { uri: out.uri, mimeType: 'image/jpeg' };
  } catch {
    return { uri: asset.uri, mimeType: asset.mimeType ?? 'image/jpeg' };
  }
}

/** Prepare a batch, keeping the picker's order. */
export async function prepareImageUploads(
  assets: PickedAsset[],
  maxEdge: number = PHOTO_MAX_EDGE,
): Promise<PreparedImage[]> {
  const out: PreparedImage[] = [];
  // Sequential on purpose: decoding several full-res images at once is exactly
  // the memory spike we're trying to avoid.
  for (const a of assets) out.push(await prepareImageUpload(a, maxEdge));
  return out;
}

// Long-edge fit. Returns null when the image is already small enough, so we skip
// the resize pass (the JPEG re-encode still runs, which normalises HEIC/PNG).
function resizeTarget(width: number, height: number, maxEdge: number): { width?: number; height?: number } | null {
  const long = Math.max(width, height);
  if (!Number.isFinite(long) || long <= maxEdge) return null;
  return width >= height ? { width: maxEdge } : { height: maxEdge };
}
