import { api, button, el, icon, modal, size } from './ui';
import { selectProcess, selectionRoots, type ProcessSnapshot } from './process-tree';

const percent = (value: number | null) => value == null ? '—' : `${value > 0 && value < 10 ? value.toFixed(1) : Math.round(value)}%`;
const memory = (value: number) => size(value).replace(' ', '');

export class Processes {
    readonly element = el('section', 'processes');
    private data?: ProcessSnapshot;
    private sort: 'ram' | 'cpu' = 'ram';
    private selected = new Set<string>();
    private collapsed = new Set<string>();
    private request?: AbortController;
    private refreshTimer?: ReturnType<typeof setTimeout>;
    private disposed = false;
    private killDialog?: HTMLDialogElement;
    private refresh = button('Refresh processes', 'RefreshCw', () => this.load());
    private kill = button('Kill', 'X', () => this.confirmKill(), 'danger');
    private allowCore = el('input');
    private error = el('p', 'monitor-error');
    private table = el('table', 'process-table');
    private footer = el('p', 'process-footer');
    private checks = new Map<string, HTMLInputElement>();
    private rowElements = new Map<string, HTMLTableRowElement>();

    constructor() {
        const toolbar = el('div', 'process-toolbar');
        const core = el('label', 'process-core'); this.allowCore.type = 'checkbox';
        core.append(this.allowCore, el('span', '', 'Allow killing core'));
        this.allowCore.onchange = () => { this.selected.clear(); void this.load(); };
        this.kill.append(el('span', '', 'Kill'));
        toolbar.append(this.refresh, core, this.kill); this.kill.disabled = true;
        this.error.setAttribute('role', 'alert');
        this.footer.setAttribute('role', 'status');
        const scroll = el('div', 'process-scroll'); scroll.append(this.table);
        this.element.append(toolbar, this.error, scroll, this.footer);
    }
    async load(preserveError = false) {
        clearTimeout(this.refreshTimer);
        if (this.disposed) return;
        this.request?.abort(); const request = this.request = new AbortController();
        this.allowCore.disabled = this.refresh.disabled = this.kill.disabled = true;
        if (!preserveError) this.error.textContent = '';
        this.element.setAttribute('aria-busy', 'true');
        if (!this.data) this.footer.textContent = 'Loading…';
        try {
            const data = await api<ProcessSnapshot>(`/processes?sort=${this.sort}&allowCore=${this.allowCore.checked}`, 'GET', undefined, request.signal);
            if (request.signal.aborted || this.disposed) return;
            this.data = data; this.selected.clear(); this.collapsed.clear(); this.paint();
        } catch (error) {
            if (!request.signal.aborted) {
                this.allowCore.checked = this.data?.allowCore ?? false;
                this.error.textContent = error instanceof Error ? error.message : 'Processes unavailable'; if (!this.data) this.footer.textContent = '';
            }
        } finally {
            if (!request.signal.aborted && !this.disposed) { this.request = undefined; this.allowCore.disabled = this.refresh.disabled = false; this.element.setAttribute('aria-busy', 'false'); this.updateSelection(); }
        }
    }
    private paint() {
        const data = this.data!; this.checks.clear(); this.rowElements.clear();
        const head = el('thead'), heading = el('tr'); heading.append(el('th', '', 'Process'));
        for (const [key, label] of [['cpu', 'CPU (own)'], ['ram', 'RAM (own)']] as const) {
            const cell = el('th'), control = button(`Sort by ${key.toUpperCase()}`, undefined, () => {
                if (this.sort === key) return;
                this.sort = key; void this.load();
            });
            control.textContent = label;
            if (this.sort === key) { control.append(icon('ArrowDown')); cell.setAttribute('aria-sort', 'descending'); }
            cell.append(control); heading.append(cell);
        }
        head.append(heading); const body = el('tbody');
        const parents = new Set(data.rows.map(row => row.parentID));
        const depths = new Map<string, number>();
        for (const row of data.rows) {
            const depth = row.parentID ? (depths.get(row.parentID) || 0) + 1 : 0; depths.set(row.id, depth);
            const tr = el('tr'); tr.dataset.id = row.id; if (row.pid) tr.dataset.pid = String(row.pid);
            tr.dataset.parent = row.parentID; tr.dataset.state = row.state || ''; tr.classList.toggle('process-group', !!row.group); tr.classList.toggle('process-zombies', !!row.zombies);
            const name = el('td'), line = el('div', 'process-name'); line.style.setProperty('--depth', String(depth));
            if (row.zombies) {
                line.append(el('span', 'process-zombie-label', `Zombies (${row.zombies.toLocaleString()})`));
                name.append(line); name.colSpan = 3; tr.append(name); body.append(tr); this.rowElements.set(row.id, tr); continue;
            }
            const check = el('input'); check.type = 'checkbox'; check.disabled = !row.canSignal;
            const label = row.group ? `${row.count.toLocaleString()} processes` : `${row.name} (${row.pid})`;
            check.setAttribute('aria-label', `Select ${label}`);
            check.onchange = () => { selectProcess(data.rows, this.selected, row.id, check.checked); this.updateSelection(); };
            this.checks.set(row.id, check);
            const hit = el('label', 'process-check'); hit.append(check); line.append(hit);
            if (parents.has(row.id)) {
                const fold = button(`Collapse ${label}`, 'ChevronDown', () => {
                    if (this.collapsed.has(row.id)) this.collapsed.delete(row.id); else this.collapsed.add(row.id);
                    const expanded = !this.collapsed.has(row.id); fold.setAttribute('aria-expanded', String(expanded));
                    fold.setAttribute('aria-label', `${expanded ? 'Collapse' : 'Expand'} ${label}`); this.updateVisibility();
                }, 'process-fold');
                fold.setAttribute('aria-expanded', 'true'); line.append(fold);
            } else line.append(el('span', 'process-fold-space'));
            const text = el('span', 'process-label', row.group ? `${row.count.toLocaleString()} processes` : row.name);
            text.title = row.group ? label : `PID ${row.pid} · UID ${row.uid} · ${row.state}`;
            if (!row.group) text.append(el('small', '', String(row.pid)));
            line.append(text); name.append(line);
            const cpu = el('td', 'process-number'), ram = el('td', 'process-number');
            cpu.append(el('span', '', percent(row.totalCPU))); ram.append(el('span', '', `~${memory(row.totalRAM)}`));
            if (!row.group) { cpu.append(el('small', '', ` (${percent(row.cpu)})`)); ram.append(el('small', '', ` (${memory(row.ram)})`)); }
            cpu.title = '100% = one CPU core'; ram.title = 'Approximate RSS; shared pages may be counted more than once';
            tr.append(name, cpu, ram); body.append(tr); this.rowElements.set(row.id, tr);
        }
        this.table.replaceChildren(head, body);
        this.footer.textContent = `Showing top ${data.rows.length.toLocaleString()} of ${data.total.toLocaleString()} total processes · ${new Date(data.time).toLocaleTimeString()}`;
        if (!data.rows.length) this.footer.textContent = 'No processes';
        this.updateSelection();
    }
    private updateVisibility() {
        const hidden = new Set<string>();
        for (const row of this.data!.rows) {
            if (hidden.has(row.parentID) || this.collapsed.has(row.parentID)) hidden.add(row.id);
            this.rowElements.get(row.id)!.hidden = hidden.has(row.id);
        }
    }
    private updateSelection() {
        for (const [id, check] of this.checks) { check.checked = this.selected.has(id); this.rowElements.get(id)?.classList.toggle('selected', check.checked); }
        this.kill.disabled = !!this.request || !this.selected.size;
    }
    private confirmKill() {
        if (!this.data || this.request || !this.selected.size) return;
        clearTimeout(this.refreshTimer);
        const data = this.data, roots = selectionRoots(data.rows, this.selected);
        const count = roots.reduce((n, row) => n + row.targets, 0), cpu = roots.reduce((n, row) => n + row.targetCPU, 0), ram = roots.reduce((n, row) => n + row.targetRAM, 0);
        const selectedCount = roots.reduce((n, row) => n + row.ownTargets, 0);
        const content = el('form', 'process-kill'), summary = el('div', 'process-kill-summary');
        summary.append(el('strong', '', `${count.toLocaleString()} processes`), el('span', '', `CPU ${percent(roots.some(row => row.unknownCPU) ? null : cpu)}`), el('span', '', `RAM ~${memory(ram)}`));
        summary.append(el('small', 'process-kill-counts', `${selectedCount.toLocaleString()} selected · ${(count - selectedCount).toLocaleString()} children`));
        const options = el('fieldset', 'process-signal'); options.append(el('legend', 'sr-only', 'Signal'));
        for (const [value, label] of [[15, 'SIGTERM'], [9, 'Force kill']] as const) {
            const choice = el('label', 'monitor-choice'), input = el('input'); input.type = 'radio'; input.name = 'signal'; input.value = String(value); input.checked = value === 15;
            choice.append(input, el('span', '', label)); options.append(choice);
        }
        const error = el('p', 'monitor-error'); error.setAttribute('role', 'alert');
        const actions = el('div', 'actions'), confirm = button('Kill processes', 'X', undefined, 'danger'); confirm.append(el('span', '', 'Kill')); confirm.type = 'submit';
        content.append(summary, options, error, actions);
        const { dialog, close } = modal('Kill processes', content); this.killDialog = dialog;
        const cancel = button('Cancel', undefined, close); actions.append(cancel, confirm);
        const request = new AbortController(); dialog.addEventListener('close', () => { request.abort(); this.killDialog = undefined; }, { once: true });
        content.onsubmit = async event => {
            event.preventDefault(); if (confirm.disabled) return;
            const signal = Number(new FormData(content).get('signal'));
            confirm.disabled = true; options.disabled = true; error.textContent = '';
            try {
                const response = await api<{ results: { pid: number; error?: string }[] }>('/processes', 'POST', { snapshot: data.snapshot, selected: roots.map(row => row.id), signal, allowCore: data.allowCore }, request.signal);
                if (request.signal.aborted || this.disposed) return;
                const failed = response.results.filter(item => item.error), sent = response.results.length - failed.length;
                this.error.textContent = failed.length ? `${sent} signals sent; ${failed.length} failed. ${failed.slice(0, 3).map(item => `${item.pid}: ${item.error}`).join(' · ')}` : '';
                this.footer.textContent = `${sent} signals sent`;
                close();
            } catch (value) {
                if (request.signal.aborted || this.disposed) return;
                error.textContent = value instanceof Error ? value.message : 'Signal failed';
                // A failed response may follow a delivered signal; require a fresh explicit action.
                cancel.textContent = 'Close';
            }
            this.selected.clear(); this.updateSelection();
            this.refreshTimer = setTimeout(() => { void this.load(true); }, 500);
        };
        confirm.focus();
    }
    dispose() {
        if (this.disposed) return;
        clearTimeout(this.refreshTimer);
        this.disposed = true; this.request?.abort(); this.killDialog?.close();
        if (this.data) void api(`/processes?snapshot=${encodeURIComponent(this.data.snapshot)}`, 'DELETE').catch(() => {});
    }
}
