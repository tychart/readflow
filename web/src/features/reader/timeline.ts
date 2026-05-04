export function calculateChunkSeekTargetSeconds(
  clientX: number,
  bounds: { left: number; width: number },
  chunkStartSeconds: number,
  chunkDurationSeconds: number,
) {
  if (bounds.width <= 0 || chunkDurationSeconds <= 0) {
    return chunkStartSeconds;
  }

  const relativeRatio = Math.min(Math.max((clientX - bounds.left) / bounds.width, 0), 1);
  return chunkStartSeconds + chunkDurationSeconds * relativeRatio;
}
