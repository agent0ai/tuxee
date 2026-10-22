import { api, button, el, icon, modal, size } from './ui';
import { id, type MonitoringPreferences } from './model';
import { compactNumber, compactSize } from './monitor-values';
import { Processes } from './processes';

type Capacity = { total: number; used: number; available: number; percent: number | null; cache?: number };
type Disk = Partial<Capacity> & { path: string; device: string; type: string };
type Network = { name: string; state: string; received: number; sent: number; receiveRate: number | null; sendRate: number | null };
type Snapshot = { time: string; scope: 'host' | 'container'; cpu: { percent: number | null; cores: number }; memory: Capacity | null; swap: Capacity | null; disks: Disk[]; networks: Network[] };
type Metric = { label: string; kind: 'cpu' | 'memory' | 'disk' | 'network'; percent?: number | null; value: string; detail: string; extra?: string; cache?: { percent: number; text: string }; network?: { uploadText: string; downloadText: string } };
const allNetworks = '/all';
const networkLabel = (name: string) => name === allNetworks ? 'NET' : name;
const defaults: MonitoringPreferences = { cpu: true, memory: true, swap: false, disks: ['/'], networks: [allNetworks], interval: 2 };
const percentage = (value?: number | null) => value == null ? '—' : `${compactNumber(value)}%`;
const rate = (value: number | null | undefined) => value == null ? '—' : `${size(value)}/s`;

export class Monitoring {
    private preferences: MonitoringPreferences;
    private data?: Snapshot;
    private error = '';
    private timer?: ReturnType<typeof setTimeout>;
    private request?: AbortController;
    private events = new AbortController();
    private header?: HTMLButtonElement;
    private dialog?: HTMLDialogElement;
    private details?: HTMLElement;
    private configuring = false;
    private processes?: Processes;
    private showingProcesses = false;

    constructor(preferences: MonitoringPreferences | undefined, private save: (value: MonitoringPreferences) => Promise<void>) {
        this.preferences = structuredClone(preferences || defaults);
        document.addEventListener('visibilitychange', () => this.poll(), { signal: this.events.signal });
        this.poll();
    }
    get displayed() { return !this.preferences.hidden; }
    private async poll() {
        clearTimeout(this.timer); this.request?.abort();
        if (this.events.signal.aborted || document.hidden || (!this.displayed && !this.dialog?.isConnected)) return;
        const request = this.request = new AbortController();
        try {
            const data = await api<Snapshot>('/metrics', 'GET', undefined, request.signal);
            if (request.signal.aborted) return;
            this.data = data; this.error = '';
        }
        catch (error) { if (request.signal.aborted) return; this.error = error instanceof Error ? error.message : 'Resource monitor unavailable'; }
        if (request.signal.aborted || this.events.signal.aborted) return;
        this.paint();
        this.timer = setTimeout(() => this.poll(), this.preferences.interval * 1000);
    }
    summary(): HTMLButtonElement {
        const control = button('Resource monitor', undefined, () => this.open(), 'monitor-summary');
        control.setAttribute('aria-haspopup', 'dialog');
        this.header = control;
        this.paintSummary(control);
        return control;
    }
    private metrics(): Metric[] {
        const data = this.error ? undefined : this.data, prefs = this.preferences, items: Metric[] = [];
        if (prefs.cpu) items.push({ label: 'CPU', kind: 'cpu', percent: data?.cpu.percent, value: percentage(data?.cpu.percent), detail: data ? `${Number(data.cpu.cores.toFixed(2))} cores` : 'Unavailable' });
        const memory = (label: string, value: Capacity | null | undefined): Metric => ({
            label, kind: 'memory', percent: value?.percent, value: value?.total === 0 ? 'Off' : compactSize(value?.used, 1024),
            detail: value ? `Used ${size(value.used)} / ${size(value.total)}` : 'Unavailable',
            extra: value ? `${size(value.available)} available` : undefined,
            cache: value?.cache != null ? { percent: value.total > 0 ? value.cache / value.total * 100 : 0, text: `Cache ${size(value.cache)}` } : undefined,
        });
        if (prefs.memory) items.push(memory('RAM', data?.memory));
        if (prefs.swap) items.push(memory('SWAP', data?.swap));
        for (const path of prefs.disks) {
            const disk = data?.disks.find(disk => disk.path === path);
            items.push({ label: path === '/' ? 'DISK' : path, kind: 'disk', percent: disk?.percent, value: compactSize(disk?.used), detail: disk?.total ? `${size(disk.used!)} / ${size(disk.total)}` : 'Unavailable', extra: disk?.total ? `${size(disk.available!)} available · ${disk.type}` : undefined });
        }
        for (const name of prefs.networks) {
            const network = data?.networks.find(network => network.name === name);
            const downloadText = compactSize(network?.receiveRate), uploadText = compactSize(network?.sendRate);
            items.push({ label: networkLabel(name), kind: 'network', value: `↓${downloadText} ↑${uploadText}`, detail: network ? `Download ${rate(network.receiveRate)} · Upload ${rate(network.sendRate)}` : 'Unavailable', extra: network ? `↓ ${size(network.received)} · ↑ ${size(network.sent)} total · ${network.state || 'unknown'}` : undefined, network: { uploadText, downloadText } });
        }
        return items;
    }
    private reading(value: string) {
        const reading = el('strong', 'monitor-value'), parts = value.match(/^(\d+(?:\.\d)?)([%BKMGTPEZ])$/);
        if (parts) reading.append(el('span', 'monitor-number', parts[1]), el('span', 'monitor-unit', parts[2]));
        else reading.textContent = value;
        return reading;
    }
    private widget(metric: Metric, detailed = false) {
        const chip = el('span', 'monitor-chip'), text = el('span', 'monitor-chip-text');
        chip.dataset.kind = metric.kind;
        text.append(el(detailed ? 'h3' : 'span', 'monitor-label', metric.label));
        if (metric.network) {
            const reading = el('span', 'monitor-network-value');
            reading.setAttribute('aria-label', metric.detail);
            for (const direction of ['download', 'upload'] as const) {
                const value = el('span', `monitor-${direction}`), arrow = icon(direction === 'download' ? 'ArrowDown' : 'ArrowUp');
                arrow.setAttribute('aria-hidden', 'true');
                value.append(arrow, this.reading(metric.network[`${direction}Text`])); reading.append(value);
            }
            text.append(reading);
        } else {
            const gauge = el('span', 'monitor-gauge');
            gauge.style.setProperty('--usage', String(metric.percent ?? 0));
            gauge.style.setProperty('--cache', String(metric.cache?.percent ?? 0));
            gauge.setAttribute('aria-hidden', 'true'); chip.append(gauge);
            const reading = this.reading(metric.value);
            if (metric.cache) reading.title = 'Estimated non-reclaimable memory';
            text.append(reading);
        }
        chip.append(text);
        return chip;
    }
    private paintSummary(control: HTMLButtonElement) {
        const metrics = this.metrics();
        control.hidden = !this.displayed;
        control.replaceChildren();
        control.dataset.state = this.error ? 'error' : this.data ? 'ready' : 'loading';
        control.title = this.error || metrics.map(item => `${item.label}: ${item.network ? item.detail : item.value}${item.cache ? ` · ${item.cache.text}` : ''}`).join(' · ') || 'Resource monitor';
        control.setAttribute('aria-description', control.title);
        const strip = el('span', 'monitor-strip');
        const visible = innerWidth <= 1100 ? 3 : 4;
        for (const item of metrics.slice(0, visible)) strip.append(this.widget(item));
        if (!metrics.length) strip.append(icon('Activity'));
        if (metrics.length > visible) strip.append(el('span', 'monitor-more', `+${metrics.length - visible}`));
        control.append(strip);
    }
    private paint() {
        if (this.header?.isConnected) this.paintSummary(this.header);
        if (this.details?.isConnected && !this.configuring && !this.showingProcesses) this.paintDetails();
    }
    private paintDetails() {
        const content = this.details!;
        content.replaceChildren();
        if (this.error) { const error = el('p', 'monitor-error', this.error); error.setAttribute('role', 'alert'); content.append(error); }
        const grid = el('div', 'monitor-grid');
        for (const item of this.metrics()) {
            const card = el('section', 'monitor-card');
            card.append(this.widget(item, true), el('p', '', item.detail));
            if (item.cache) {
                const cache = el('p', 'monitor-cache', item.cache.text); cache.title = 'Estimated reclaimable memory'; card.append(cache);
            }
            if (item.extra) card.append(el('small', 'muted', item.extra));
            grid.append(card);
        }
        if (!grid.childElementCount) grid.append(el('p', 'muted', 'No metrics selected'));
        content.append(grid);
    }
    open() {
        if (this.dialog?.isConnected) { this.dialog.focus(); return; }
        this.configuring = false; this.showingProcesses = false;
        const content = el('div', 'monitor-content'), controls = el('div');
        const display = el('label', 'monitor-display'), toggle = el('input'), error = el('p', 'monitor-error');
        toggle.type = 'checkbox'; toggle.setAttribute('role', 'switch'); toggle.checked = this.displayed;
        display.append(el('span', '', 'Display resource monitor widget'), toggle);
        error.setAttribute('role', 'alert'); controls.append(display, error);
        const resourcePanel = el('section'), processPanel = el('section');
        this.details = el('div', 'monitor-content'); resourcePanel.append(controls, this.details);
        processPanel.hidden = true; content.append(resourcePanel, processPanel);
        const { dialog } = modal('Resource monitor', content);
        this.dialog = dialog; dialog.classList.add('monitor-modal');
        const tabs = el('div', 'monitor-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Resource monitor');
        const resources = button('Resources', undefined, () => selectTab(false));
        const processes = button('Processes', undefined, () => selectTab(true));
        for (const [tab, panel] of [[resources, resourcePanel], [processes, processPanel]]) {
            tab.id = id(); panel.id = id(); tab.setAttribute('role', 'tab'); panel.setAttribute('role', 'tabpanel');
            tab.setAttribute('aria-controls', panel.id); panel.setAttribute('aria-labelledby', tab.id); tabs.append(tab);
        }
        resources.setAttribute('aria-selected', 'true'); processes.setAttribute('aria-selected', 'false');
        tabs.onkeydown = event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); selectTab(!this.showingProcesses); (this.showingProcesses ? processes : resources).focus(); } };
        content.prepend(tabs);
        const selectTab = (show: boolean) => {
            if (show === this.showingProcesses) return;
            this.showingProcesses = show;
            resources.setAttribute('aria-selected', String(!show)); processes.setAttribute('aria-selected', String(show));
            resources.tabIndex = show ? -1 : 0; processes.tabIndex = show ? 0 : -1;
            resourcePanel.hidden = show; processPanel.hidden = !show; cog.hidden = show;
            dialog.classList.toggle('monitor-processes', show);
            if (show) {
                if (!this.processes) { this.processes = new Processes(); processPanel.append(this.processes.element); void this.processes.load(); }
            } else this.paintDetails();
        };
        processes.tabIndex = -1;
        const cog = button('Configure resource monitor', 'Settings', () => {
            this.configuring = !this.configuring;
            controls.hidden = this.configuring; tabs.hidden = this.configuring;
            cog.replaceChildren(icon(this.configuring ? 'ArrowLeft' : 'Settings'));
            cog.setAttribute('aria-label', this.configuring ? 'Back to resource monitor' : 'Configure resource monitor');
            cog.title = cog.getAttribute('aria-label')!;
            if (this.configuring) this.configure(() => { this.configuring = false; controls.hidden = false; tabs.hidden = false; cog.replaceChildren(icon('Settings')); cog.setAttribute('aria-label', 'Configure resource monitor'); cog.title = 'Configure resource monitor'; this.paint(); cog.focus(); });
            else this.paintDetails();
        });
        toggle.onchange = async () => {
            toggle.disabled = cog.disabled = true; error.textContent = '';
            try {
                const preferences = { ...this.preferences, hidden: !toggle.checked };
                await this.save(preferences); this.preferences = preferences; this.paint(); this.poll();
            } catch (value) {
                toggle.checked = this.displayed;
                error.textContent = value instanceof Error ? value.message : 'Cannot save resource monitor';
            } finally { toggle.disabled = cog.disabled = false; }
        };
        dialog.querySelector('.modal-head')!.insertBefore(cog, dialog.querySelector('.modal-head button'));
        dialog.addEventListener('close', () => { this.processes?.dispose(); this.processes = undefined; this.showingProcesses = false; this.details = undefined; this.dialog = undefined; if (!this.displayed) this.poll(); }, { once: true });
        this.paintDetails(); this.poll();
    }
    private configure(done: () => void) {
        const draft = structuredClone(this.preferences), form = el('form', 'monitor-config'), content = this.details!;
        const section = (title: string) => { const group = el('fieldset'); group.append(el('legend', '', title)); form.append(group); return group; };
        const choice = (group: HTMLElement, label: string, checked: boolean, change: (checked: boolean) => void, detail = '') => {
            const row = el('label', 'monitor-choice'), input = el('input'), text = el('span');
            input.type = 'checkbox'; input.checked = checked; input.setAttribute('aria-label', label); input.onchange = () => change(input.checked);
            text.append(el('span', '', label)); if (detail) text.append(el('small', 'muted', detail));
            row.append(input, text); group.append(row);
        };
        const system = section('System');
        for (const [key, label] of [['cpu', 'CPU'], ['memory', 'RAM'], ['swap', 'Swap']] as const) choice(system, label, draft[key], checked => { draft[key] = checked; });
        const disks = section('Disks');
        const select = (key: 'disks' | 'networks', value: string, checked: boolean) => { draft[key] = checked ? [...draft[key], value] : draft[key].filter(item => item !== value); };
        for (const path of new Set([...(this.data?.disks.map(disk => disk.path) || []), ...draft.disks])) {
            const disk = this.data?.disks.find(disk => disk.path === path);
            choice(disks, path, draft.disks.includes(path), checked => select('disks', path, checked), disk ? `${disk.type} · ${disk.total ? size(disk.total) : 'Unavailable'}` : 'Unavailable');
        }
        const networks = section('Networks');
        for (const name of new Set([allNetworks, ...(this.data?.networks.map(network => network.name) || []), ...draft.networks])) {
            const network = this.data?.networks.find(network => network.name === name);
            choice(networks, networkLabel(name), draft.networks.includes(name), checked => select('networks', name, checked), name === allNetworks ? 'Sum of all active interfaces' : network?.state || 'Unavailable');
        }
        const field = el('label', 'field', 'Refresh'), interval = el('select'); interval.setAttribute('aria-label', 'Resource monitor refresh');
        for (const seconds of [2, 5, 10]) { const option = el('option', '', `${seconds} seconds`); option.value = String(seconds); interval.append(option); }
        interval.value = String(draft.interval); field.append(interval); form.append(field);
        const error = el('p', 'monitor-error'), actions = el('div', 'actions'), submit = button('Save resource monitor', undefined, undefined, 'primary');
        error.setAttribute('role', 'alert'); submit.type = 'submit';
        actions.append(button('Cancel', undefined, done), submit); form.append(error, actions);
        form.onsubmit = async event => {
            event.preventDefault(); error.textContent = ''; submit.disabled = true;
            try {
                if (draft.disks.length > 8 || draft.networks.length > 8) throw new Error('Select up to 8 disks and 8 interfaces');
                draft.interval = Number(interval.value); await this.save(draft); this.preferences = draft; done(); this.poll();
            } catch (value) { error.textContent = value instanceof Error ? value.message : 'Cannot save resource monitor'; }
            finally { submit.disabled = false; }
        };
        content.replaceChildren(form);
    }
    dispose() { this.processes?.dispose(); this.processes = undefined; this.events.abort(); clearTimeout(this.timer); this.request?.abort(); this.dialog?.close(); }
}
