// Delay before retry number `failures` (1 = first retry): base, 2x, 4x ... capped, with +-20% jitter.
export function backoffMs(failures: number, baseMs = 1000, capMs = 60000): number {
    if (failures <= 0) return 0
    const d = Math.min(capMs, baseMs * 2 ** (failures - 1))
    return Math.round(d * (0.8 + Math.random() * 0.4))
}
