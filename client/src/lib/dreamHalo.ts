/** A hole larger than the whole provider viewport, including every control/edge. */
export function dreamHaloHole(
  media: { left: number; top: number; width: number; height: number },
  layer: { left: number; top: number; width: number; height: number },
  clientWidth: number,
  clientHeight: number,
): { x: number; y: number; width: number; height: number } | null {
  const values = [media.left, media.top, media.width, media.height, layer.left, layer.top, layer.width, layer.height, clientWidth, clientHeight];
  if (!values.every(Number.isFinite) || media.width <= 0 || media.height <= 0 || layer.width <= 0 || layer.height <= 0 || clientWidth <= 0 || clientHeight <= 0) return null;
  const scaleX = clientWidth / layer.width;
  const scaleY = clientHeight / layer.height;
  const x = Math.floor((media.left - layer.left) * scaleX) - 2;
  const y = Math.floor((media.top - layer.top) * scaleY) - 2;
  const right = Math.ceil((media.left + media.width - layer.left) * scaleX) + 2;
  const bottom = Math.ceil((media.top + media.height - layer.top) * scaleY) + 2;
  return { x, y, width: right - x, height: bottom - y };
}
