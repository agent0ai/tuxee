export function compactSize(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(value) || value < 0) return '—   ';
    const units = 'BKMGTPE';
    let unit = 0;
    while (value >= 999.5 && unit < units.length - 1) { value /= 1000; unit++; }
    const rounded = Math.round(value * 10) / 10;
    return `${rounded < 10 ? rounded.toFixed(1) : Math.min(999, Math.round(value))}${units[unit]}`.padEnd(4);
}

export function networkFill(value: number | null, history: number[]): number {
    if (value == null) { history.length = 0; return 0; }
    history.push(value);
    if (history.length > 100) history.shift();
    const peak = Math.max(...history);
    return value > 0 ? Math.max(0.05, value / peak) : 0;
}
