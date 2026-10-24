const units = 'BKMGTPEZ';

export function compactNumber(value: number): string {
    const rounded = Math.round(value * 10) / 10;
    return rounded > 0 && rounded < 10 ? rounded.toFixed(1) : String(Math.round(value));
}

export function compactSize(value: number | null | undefined, base: 1000 | 1024 = 1000, fullUnits = false): string {
    if (value == null || !Number.isFinite(value) || value < 0) return '—';
    let unit = 0;
    while (value >= 999.5 && unit < units.length - 1) { value /= base; unit++; }
    return `${compactNumber(value)}${fullUnits ? ' ' : ''}${units[unit]}${fullUnits && unit > 0 ? base === 1024 ? 'iB' : 'B' : ''}`;
}

export function size(value: number | null | undefined, base: 1000 | 1024 = 1024): string {
    if (value == null || !Number.isFinite(value) || value < 0) return '—';
    let unit = 0;
    // Promote before rounding would display 1000.0 KB or 1024.0 KiB.
    while (value >= base - (unit === 0 ? 0.5 : 0.05) && unit < units.length - 1) { value /= base; unit++; }
    return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${units[unit]}${base === 1024 ? 'iB' : 'B'}`;
}
