/**
 * Max-pools a source peak array to a target bar count.
 *
 * Max-pooling keeps loud transients visible, which is what gives the
 * waveform its punch. The source is at fixed high resolution (256 bins per
 * chunk server-side); the display bar count derives from the rendered width.
 */
export function maxPool(data: Float32Array, target: number): Float32Array {
  const result = new Float32Array(target);
  const sourceLength = data.length;
  if (sourceLength === 0 || target <= 0) return result;
  for (let bar = 0; bar < target; bar++) {
    const start = Math.floor((bar / target) * sourceLength);
    const end = Math.max(start + 1, Math.floor(((bar + 1) / target) * sourceLength));
    let peak = 0;
    for (let i = start; i < end; i++) {
      if (data[i] > peak) peak = data[i];
    }
    result[bar] = peak;
  }
  return result;
}
