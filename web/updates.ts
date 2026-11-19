import { locale, t, errorText } from './i18n';
import { api, button, el, icon, notify } from './ui';

type Schedule = { enabled: boolean; hour: number; timezone: string };
type Status = { schedule?: Schedule; current: string; latest?: string; available: boolean; checkedAt: string; error?: string; command: string; canApply: boolean; restartNeeded: boolean; installing: boolean };

export class Updates {
    private status?: Status;
    private applying = false;
    private savingSchedule = false;
    private applyError = "";
    private timer?: ReturnType<typeof setTimeout>;
    private request?: AbortController;
    private events = new AbortController();
    private listeners = new Set<() => void>();
    constructor(private changed: () => void, private prepare: () => Promise<boolean>) {
        document.addEventListener('visibilitychange', () => this.poll(), { signal: this.events.signal });
        window.addEventListener('focus', () => this.poll(), { signal: this.events.signal });
        void this.poll();
    }
    get warning() { return this.status?.available ? t("updates.available", { version: this.status.latest }) : ''; }
    private publish(status: Status) {
        this.status = status; this.changed(); this.listeners.forEach(listener => listener());
    }
    private async poll() {
        clearTimeout(this.timer); this.request?.abort();
        if (document.hidden || this.events.signal.aborted || this.applying || this.savingSchedule) return;
        const request = this.request = new AbortController();
        try {
            const status = await api<Status>('/update', 'GET', undefined, request.signal);
            if (!request.signal.aborted && !this.applying) this.publish(status);
        } catch { /* Keep the last notice; connection.ts owns server outages. */ }
        finally {
            if (!request.signal.aborted) this.timer = setTimeout(() => this.poll(), 60000);
        }
    }
    private async apply() {
        if (this.applying) return;
        this.applying = true; this.applyError = '';
        this.request?.abort();
        this.listeners.forEach(listener => listener());
        let restarting = false;
        try {
            if (!await this.prepare()) return;
            await api('/update/apply', 'POST', undefined, this.events.signal);
            restarting = true;
            window.dispatchEvent(new Event('tuxee-connection-lost'));
        } catch (error) {
            if (!this.events.signal.aborted) this.applyError = t('updates.installFailed', { detail: errorText(error as Error) });
        } finally {
            if (!restarting) {
                this.applying = false;
                this.listeners.forEach(listener => listener());
                void this.poll();
            }
        }
    }
    view(signal: AbortSignal) {
        const content = el('tr', 'about-update'), cell = el('td'), summary = el('div', 'update-summary');
        content.setAttribute('aria-label', t("updates.updates")); cell.colSpan = 2;
        const message = el('span', 'update-status'), checked = el('span', 'update-checked muted'), detail = el('p', 'update-error');
        const subtitle = el('p', 'update-subtitle muted'), actions = el('span', 'update-actions');
        const install = button(t('updates.install'), 'Download', () => this.apply(), 'primary update-install');
        const installLabel = el('span'); install.append(installLabel);
        const checkLabel = el('span');
        let checking = false, checkError = '';
        const check = button(t("updates.checkNow"), 'RefreshCw', async () => {
            checking = true; checkError = ''; paint();
            try {
                const status = await api<Status>('/update', 'POST', undefined, signal);
                if (!signal.aborted) {
                    if (status.error) checkError = t("updates.failureDetail", { detail: errorText(status) });
                    this.publish(status);
                }
            } catch (error) {
                if (!signal.aborted) checkError = errorText(error as Error);
            } finally { checking = false; paint(); }
        });
        check.append(checkLabel);
        message.setAttribute('role', 'status'); detail.setAttribute('role', 'status');
        actions.append(install, check); summary.append(message, checked, actions);
        const scheduleLine = el('div', 'update-schedule');
        const label = el('label', 'settings-switch'), enabled = el('input');
        enabled.type = 'checkbox'; enabled.setAttribute('role', 'switch');
        label.append(enabled, el('span', '', t('updates.automatic')));
        const hour = el('select'), zone = el('select');
        hour.setAttribute('aria-label', t('updates.hour')); zone.setAttribute('aria-label', t('updates.timezone'));
        for (let h = 0; h < 24; h++) hour.add(new Option(String(h).padStart(2, '0') + ':00', String(h)));
        const saveSchedule = async () => {
            const schedule = { enabled: enabled.checked, hour: Number(hour.value), timezone: zone.value };
            this.savingSchedule = true;
            this.request?.abort();
            paint();
            try {
                this.publish(await api<Status>('/update/schedule', 'PUT', schedule, this.events.signal));
            } catch (error) {
                if (!signal.aborted) notify(error, scheduleLine);
            } finally {
                this.savingSchedule = false;
                this.listeners.forEach(listener => listener());
                void this.poll();
            }
        };
        enabled.onchange = hour.onchange = zone.onchange = saveSchedule;
        scheduleLine.append(label, hour, zone);
        cell.append(summary, detail, subtitle, scheduleLine); content.append(cell);
        const dateFormat = new Intl.DateTimeFormat(locale() === 'en' ? 'de-DE' : locale(), { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
        const paint = () => {
            const status = this.status, busy = this.applying || !!status?.installing;
            content.classList.toggle('update-available', !!status?.available);
            content.setAttribute('aria-busy', String(busy || checking));
            message.replaceChildren();
            if (status?.available) {
                const badge = el('span', 'menu-warning'); badge.append(icon('TriangleAlert'));
                message.append(badge, document.createTextNode(t("updates.versionAvailable", { version: status.latest })));
            } else message.textContent = status?.restartNeeded ? t('updates.restartRequired') : checkError ? t("updates.checkFailed") : status?.latest ? t("updates.upToDate") : t("updates.notChecked");
            checked.hidden = !status || status.checkedAt.startsWith('0001-');
            checked.textContent = checked.hidden ? '' : t("updates.checked", { date: dateFormat.format(new Date(status!.checkedAt)).replace(',', '') });
            install.hidden = !status?.available || !status.canApply;
            install.disabled = check.disabled = busy || checking || this.savingSchedule;
            const schedule = status?.schedule;
            scheduleLine.hidden = !schedule || !status.canApply;
            if (schedule && !scheduleLine.hidden) {
                if (!zone.length) {
                    zone.add(new Option(t('updates.systemLocal'), 'Local'));
                    for (const name of ['UTC', ...Intl.supportedValuesOf('timeZone')]) zone.add(new Option(name, name));
                }
                if (!this.savingSchedule) {
                    enabled.checked = schedule.enabled;
                    hour.value = String(schedule.hour);
                    zone.value = schedule.timezone;
                    if (!zone.value) zone.add(new Option(schedule.timezone, schedule.timezone, false, true));
                }
                hour.hidden = zone.hidden = !enabled.checked;
                enabled.disabled = hour.disabled = zone.disabled = busy || checking || this.savingSchedule;
            }
            installLabel.textContent = busy ? t('updates.installing') : t('updates.install');
            checkLabel.hidden = !!status?.available;
            checkLabel.textContent = checking ? t('updates.checking') : t('updates.checkNow');
            check.title = checking ? t('updates.checking') : t('updates.checkNow');
            check.setAttribute('aria-label', check.title);
            detail.textContent = this.applyError || checkError;
            detail.hidden = !detail.textContent;
            subtitle.hidden = !status?.available;
            subtitle.replaceChildren();
            if (status?.canApply) {
                t('updates.manualCommand', { command: '\uFFFC' }).split('\uFFFC').forEach((part, index) => {
                    if (index) { const command = el('code', '', status.command); command.dir = 'ltr'; subtitle.append(command); }
                    subtitle.append(document.createTextNode(part));
                });
            } else subtitle.textContent = t('updates.contactAdministrator');
        };
        this.listeners.add(paint);
        signal.addEventListener('abort', () => this.listeners.delete(paint), { once: true });
        paint();
        return content;
    }
    dispose() {
        this.events.abort(); this.request?.abort(); clearTimeout(this.timer); this.listeners.clear();
    }
}
