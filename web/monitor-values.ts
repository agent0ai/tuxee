export function compactSize(value: number | null | undefined, base = 1000): string {
    if (value == null || !Number.isFinite(value) || value < 0) return '—';
    const units = 'BKMGTPEZ';
    let unit = 0;
    while (value >= 999.5 && unit < units.length - 1) { value /= base; unit++; }
    return `${Math.round(value)}${units[unit]}`;
}
