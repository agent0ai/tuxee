export type ProcessRow = {
    id: string; parentID: string; pid: number; start: string; parent: number; name: string; uid: number; state: string;
    cpu: number | null; ram: number; totalCPU: number | null; totalRAM: number;
    count: number; targets: number; ownTargets: number; unknownCPU?: boolean; targetCPU: number; targetRAM: number; canSignal: boolean; group?: boolean; zombies?: number;
};
export type ProcessSnapshot = { snapshot: string; allowCore: boolean; time: string; rows: ProcessRow[]; total: number; zombies: number };

export function selectProcess(rows: ProcessRow[], selected: Set<string>, id: string, checked: boolean) {
    const byID = new Map(rows.map(row => [row.id, row])), children = new Map<string, string[]>();
    for (const row of rows) { const list = children.get(row.parentID) || []; list.push(row.id); children.set(row.parentID, list); }
    const pending = [id], seen = new Set<string>();
    while (pending.length) {
        const key = pending.pop()!; if (seen.has(key)) continue; seen.add(key);
        const row = byID.get(key); if (!row) continue;
        if (checked && row.canSignal) selected.add(key); else selected.delete(key);
        pending.push(...children.get(key) || []);
    }
    if (!checked) {
        let parent = byID.get(id)?.parentID;
        while (parent && !seen.has(parent)) { seen.add(parent); selected.delete(parent); parent = byID.get(parent)?.parentID; }
    }
}
export function selectionRoots(rows: ProcessRow[], selected: Set<string>) {
    const byID = new Map(rows.map(row => [row.id, row]));
    return rows.filter(row => {
        if (!selected.has(row.id)) return false;
        const seen = new Set<string>(); let parent = row.parentID;
        while (parent && !seen.has(parent)) {
            if (selected.has(parent)) return false;
            seen.add(parent); parent = byID.get(parent)?.parentID || '';
        }
        return true;
    });
}
