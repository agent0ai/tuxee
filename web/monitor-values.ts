const units = 'BKMGTPEZ';

export function compactNumber(value: number): string {
    const rounded = Math.round(value * 10) / 10;
    return rounded > 0 && rounded < 10 ? rounded.toFixed(1) : String(Math.round(value));
}

export function compactSize(value: number | null | undefined, base: 1000 | 1024 = 1000, spaced = false): string {
    if (value == null || !Number.isFinite(value) || value < 0) return '—';
    let unit = 0;
    while (value >= 999.5 && unit < units.length - 1) { value /= base; unit++; }
    return `${compactNumber(value)}${spaced ? ' ' : ''}${units[unit]}`;
}

export function size(value: number | null | undefined, base: 1000 | 1024 = 1024): string {
    if (value == null || !Number.isFinite(value) || value < 0) return '—';
    let unit = 0;
    // Promote before rounding reaches the next unit's base.
    while (value >= base - (unit === 0 ? 0.5 : 0.05) && unit < units.length - 1) { value /= base; unit++; }
    return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${units[unit]}`;
}
