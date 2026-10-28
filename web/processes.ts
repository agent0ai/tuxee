import { locale, t, errorText } from './i18n';
import { api, button, el, icon, modal, size } from './ui';
import { selectProcess, selectionRoots, type ProcessSnapshot } from './process-tree';
import { compactNumber } from './monitor-values';

const percent = (value: number | null) => value == null ? '—' : `${compactNumber(value)}%`;
const memory = (value: number | null, approximate = false) => value == null ? '—' : `${approximate ? '~' : ''}${size(value).replace(' ', '')}`;
const memoryDetail = (estimated: boolean | undefined) => t("processes.memoryDescription") + (estimated ? t("processes.memoryEstimate") : '') + t("processes.memoryWidget");

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
    private refresh = button(t("processes.refreshProcesses"), 'RefreshCw', () => this.load());
    private kill = button(t("processes.kill"), 'X', () => this.confirmKill(), 'danger');
    private allowCore = el('input');
    private error = el('p', 'monitor-error');
    private table = el('table', 'process-table');
    private footer = el('p', 'process-footer');
    private checks = new Map<string, HTMLInputElement>();
    private rowElements = new Map<string, HTMLTableRowElement>();

    constructor() {
        const toolbar = el('div', 'process-toolbar');
        const core = el('label', 'process-core'); this.allowCore.type = 'checkbox';
        core.append(this.allowCore, el('span', '', t("processes.allowKillingCore")));
        this.allowCore.onchange = () => { this.selected.clear(); void this.load(); };
        this.kill.append(el('span', '', t("processes.kill")));
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
        if (!this.data) this.footer.textContent = t("common.loading");
        try {
            const data = await api<ProcessSnapshot>(`/processes?sort=${this.sort}&allowCore=${this.allowCore.checked}`, 'GET', undefined, request.signal);
            if (request.signal.aborted || this.disposed) return;
            this.data = data; this.selected.clear(); this.collapsed.clear(); this.paint();
        } catch (error) {
            if (!request.signal.aborted) {
                this.allowCore.checked = this.data?.allowCore ?? false;
                this.error.textContent = error instanceof Error ? errorText(error) : t("processes.processesUnavailable"); if (!this.data) this.footer.textContent = '';
            }
        } finally {
            if (!request.signal.aborted && !this.disposed) { this.request = undefined; this.allowCore.disabled = this.refresh.disabled = false; this.element.setAttribute('aria-busy', 'false'); this.updateSelection(); }
        }
    }
    private paint() {
        const data = this.data!; this.checks.clear(); this.rowElements.clear();
        const head = el('thead'), heading = el('tr'); heading.append(el('th', '', t("processes.process")));
        for (const [key, label] of [['cpu', t("processes.cpuOwn")], ['ram', t("processes.ramOwn")]] as const) {
            const cell = el('th'), control = button(t("files.sortBy", { column: key.toUpperCase() }), undefined, () => {
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
                line.append(el('span', 'process-zombie-label', t("processes.zombies", { count: row.zombies.toLocaleString(locale()) })));
                name.append(line); name.colSpan = 3; tr.append(name); body.append(tr); this.rowElements.set(row.id, tr); continue;
            }
            const check = el('input'); check.type = 'checkbox'; check.disabled = !row.canSignal;
            const label = row.group ? t("processes.count", { count: row.count.toLocaleString(locale()) }) : `${row.name} (${row.pid})`;
            check.setAttribute('aria-label', t("processes.selectProcess", { name: label }));
            check.onchange = () => { selectProcess(data.rows, this.selected, row.id, check.checked); this.updateSelection(); };
            this.checks.set(row.id, check);
            const hit = el('label', 'process-check'); hit.append(check); line.append(hit);
            if (parents.has(row.id)) {
                const fold = button(t("processes.collapse", { name: label }), 'ChevronDown', () => {
                    if (this.collapsed.has(row.id)) this.collapsed.delete(row.id); else this.collapsed.add(row.id);
                    const expanded = !this.collapsed.has(row.id); fold.setAttribute('aria-expanded', String(expanded));
                    fold.setAttribute('aria-label', t(expanded ? "processes.collapse" : "processes.expand", { name: label })); this.updateVisibility();
                }, 'process-fold');
                fold.setAttribute('aria-expanded', 'true'); line.append(fold);
            } else line.append(el('span', 'process-fold-space'));
            const text = el('span', 'process-label');
            text.append(el('span', '', row.group ? label : `${row.pid} • ${row.name}`));
            text.title = row.group ? label : `PID ${row.pid} · UID ${row.uid} · ${row.state}`;
            if (!row.group) {
                const command = Array.from(row.commandLine || '—');
                const subtitle = el('small', '', command.length > 100 ? command.slice(0, 99).join('') + '…' : command.join(''));
                subtitle.title = row.commandLine || ''; text.append(subtitle);
            }
            line.append(text); name.append(line);
            const cpu = el('td', 'process-number'), ram = el('td', 'process-number');
            cpu.append(el('span', '', percent(row.totalCPU))); ram.append(el('span', '', memory(row.totalRAM, true)));
            if (!row.group) { cpu.append(el('small', '', ` (${percent(row.cpu)})`)); ram.append(el('small', '', ` (${memory(row.ram, row.estimatedRAM)})`)); }
            cpu.title = t("processes.cpuCorePercentHint");
            ram.title = memoryDetail(row.totalEstimatedRAM) + t("processes.fileMemory", { size: memory(row.totalFileRAM, true) }) + (row.group ? '' : t("processes.ownMemory", { size: memory(row.fileRAM) })) + t('processes.unavailableLegend');
            tr.append(name, cpu, ram); body.append(tr); this.rowElements.set(row.id, tr);
        }
        this.table.replaceChildren(head, body);
        this.footer.textContent = t(data.rows.length === data.total ? "processes.footerAll" : "processes.footer", { shown: data.rows.length.toLocaleString(locale()), total: data.total.toLocaleString(locale()), time: new Date(data.time).toLocaleTimeString(locale()) });
        if (!data.rows.length) this.footer.textContent = t("processes.noProcesses");
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
        const count = roots.reduce((n, row) => n + row.targets, 0), cpu = roots.reduce((n, row) => n + row.targetCPU, 0);
        const ram = roots.some(row => row.targetRAM == null) ? null : roots.reduce((n, row) => n + row.targetRAM!, 0);
        const selectedCount = roots.reduce((n, row) => n + row.ownTargets, 0);
        const content = el('form', 'process-kill'), summary = el('div', 'process-kill-summary');
        const ramSummary = el('span', '', `RAM ${memory(ram, true)}`); ramSummary.title = memoryDetail(roots.some(row => row.targetEstimatedRAM));
        summary.append(el('strong', '', t("processes.count", { count: count.toLocaleString(locale()) })), el('span', '', `CPU ${percent(roots.some(row => row.unknownCPU) ? null : cpu)}`), ramSummary);
        summary.append(el('small', 'process-kill-counts', t("processes.selection", { selected: selectedCount.toLocaleString(locale()), children: (count - selectedCount).toLocaleString(locale()) })));
        const options = el('fieldset', 'process-signal'); options.append(el('legend', 'sr-only', t("processes.signal")));
        for (const [value, label] of [[15, 'SIGTERM'], [9, t("processes.forceKill")]] as const) {
            const choice = el('label', 'monitor-choice'), input = el('input'); input.type = 'radio'; input.name = 'signal'; input.value = String(value); input.checked = value === 15;
            choice.append(input, el('span', '', label)); options.append(choice);
        }
        const error = el('p', 'monitor-error'); error.setAttribute('role', 'alert');
        const actions = el('div', 'actions'), confirm = button(t("processes.killProcesses"), 'X', undefined, 'danger'); confirm.append(el('span', '', t("processes.kill"))); confirm.type = 'submit';
        content.append(summary, options, error, actions);
        const { dialog, close } = modal(t("processes.killProcesses"), content); this.killDialog = dialog;
        const cancel = button(t("common.cancel"), undefined, close); actions.append(cancel, confirm);
        const request = new AbortController(); dialog.addEventListener('close', () => { request.abort(); this.killDialog = undefined; }, { once: true });
        content.onsubmit = async event => {
            event.preventDefault(); if (confirm.disabled) return;
            const signal = Number(new FormData(content).get('signal'));
            confirm.disabled = true; options.disabled = true; error.textContent = '';
            try {
                const response = await api<{ results: { pid: number; error?: string }[] }>('/processes', 'POST', { snapshot: data.snapshot, selected: roots.map(row => row.id), signal, allowCore: data.allowCore }, request.signal);
                if (request.signal.aborted || this.disposed) return;
                const failed = response.results.filter(item => item.error), sent = response.results.length - failed.length;
                this.error.textContent = failed.length ? t("processes.signalResults", { sent, failed: failed.length, details: failed.slice(0, 3).map(item => `${item.pid}: ${errorText(item)}`).join(' · ') }) : '';
                this.footer.textContent = t("processes.signalsSent", { count: sent });
                close();
            } catch (value) {
                if (request.signal.aborted || this.disposed) return;
                error.textContent = value instanceof Error ? errorText(value) : t("processes.signalFailed");
                // A failed response may follow a delivered signal; require a fresh explicit action.
                cancel.textContent = t("common.close");
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
