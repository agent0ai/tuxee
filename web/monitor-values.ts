export function compactNumber(value: number): string {
    const rounded = Math.round(value * 10) / 10;
    return rounded > 0 && rounded < 10 ? rounded.toFixed(1) : String(Math.round(value));
}

export function compactSize(value: number | null | undefined, base = 1000, fullUnits = false): string {
    if (value == null || !Number.isFinite(value) || value < 0) return '—';
    const units = 'BKMGTPEZ';
    let unit = 0;
    while (value >= 999.5 && unit < units.length - 1) { value /= base; unit++; }
    return `${compactNumber(value)}${fullUnits ? ' ' : ''}${units[unit]}${fullUnits && unit > 0 ? 'B' : ''}`;
}
