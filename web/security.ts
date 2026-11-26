import { api, button, confirmAction, el, icon, modal } from './ui';
import { t, errorText } from './i18n';
import './security.css';

type Factor = { enabled: boolean; recoveryRemaining: number; recoveryCodes?: string[] };
type Network = { allowedNetworks: string[]; trustedProxies: string[] };
type Status = { user: Factor; canAdmin: boolean; clientIP: string; network?: Network; networkRecoveryCommand?: string };

const field = (key: string, input: HTMLInputElement | HTMLTextAreaElement) => {
    const label = el('label', 'field'); label.append(el('span', '', t(key)), input); return label;
};
const password = () => { const input = el('input'); input.type = 'password'; input.autocomplete = 'current-password'; input.name = 'password'; input.required = true; return input; };
const code = () => { const input = el('input'); input.name = 'code'; input.autocomplete = 'one-time-code'; input.required = true; input.spellcheck = false; input.autocapitalize = 'off'; return input; };

function authenticateSecurity(): Promise<boolean> {
    return new Promise(resolve => {
        const form = el('form', 'security-settings security-form'), pass = password(), otp = code();
        const notice = el('p', 'error'); notice.setAttribute('role', 'alert');
        const { dialog, close, setFooter } = modal(t('security.title'), form);
        const controller = new AbortController();
        const next = button(t('common.continue'), undefined, undefined, 'primary');
        next.type = 'submit';
        const actions = el('div', 'dialog-actions'); actions.append(button(t('common.cancel'), undefined, close), next);
        setFooter(actions, form);
        let challenge = '';
        dialog.addEventListener('close', () => {
            controller.abort(); form.replaceChildren(); resolve(false);
        }, { once: true });
        form.append(field('login.password', pass), notice);
        pass.focus();
        form.onsubmit = async event => {
            event.preventDefault();
            if (next.disabled) return;
            next.disabled = true;
            notice.textContent = '';
            const input = challenge ? { challenge, code: otp.value } : { password: pass.value };
            pass.value = ''; otp.value = '';
            try {
                const result = await api<{ authorized?: boolean; challenge?: string }>('/security/unlock', 'POST', input, controller.signal);
                if (!dialog.open) return;
                if (result.authorized) { resolve(true); close(); return; }
                if (!result.challenge) throw Error(t('common.failed'));
                challenge = result.challenge;
                otp.inputMode = 'numeric'; otp.pattern = '[0-9]{6}'; otp.maxLength = 6;
                form.replaceChildren(field('security.authenticatorCode', otp), notice);
                otp.focus();
            } catch (error) {
                if (!controller.signal.aborted) notice.textContent = errorText(error);
            } finally { next.disabled = false; }
        };
    });
}

export async function openSecurity() {
    if (!await authenticateSecurity()) return;
    const status = await api<Status>('/security');
    const content = el('div', 'security-settings'), tabs = el('div', 'monitor-tabs'), panel = el('div');
    const controller = new AbortController();
    tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', t('security.title'));
    panel.id = 'security-panel'; panel.setAttribute('role', 'tabpanel');
    content.append(tabs, panel);
    const dialog = modal(t('security.title'), content);
    let busy = false, current = 'user';
    const tabButtons: HTMLButtonElement[] = [];
    for (const name of status.canAdmin ? ['global', 'user'] : ['user']) {
        const tab = button(t(name === 'global' ? 'security.global' : 'security.user'), undefined, () => select(name));
        tab.id = `security-tab-${name}`; tab.dataset.tab = name;
        tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', panel.id);
        tabButtons.push(tab); tabs.append(tab);
    }
    tabs.onkeydown = event => {
        if (!busy && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const next = event.key === 'Home' ? tabButtons[0] : event.key === 'End' ? tabButtons.at(-1)! : tabButtons.find(tab => tab.dataset.tab !== current) || tabButtons[0];
            select(next.dataset.tab!); next.focus();
        }
    };
    function select(name: string) {
        if (busy) return;
        current = name;
        for (const tab of tabButtons) {
            const selected = tab.dataset.tab === name;
            tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
            tab.classList.toggle('active', selected);
        }
        panel.setAttribute('aria-labelledby', `security-tab-${name}`);
        name === 'global' ? globalSettings() : userSettings();
    }
    function form(action: string, submit: () => Promise<void>, target = panel, modalView = dialog, signal = controller.signal) {
        const form = el('form', 'security-form'), notice = el('p', 'error');
        notice.setAttribute('role', 'alert');
        const save = button(action, undefined, undefined, 'primary'); save.type = 'submit';
        const actions = el('div', 'dialog-actions'); actions.append(button(t('common.cancel'), undefined, modalView.close), save);
        modalView.setFooter(actions, form);
        const main = target === panel;
        let submitting = false;
        form.onsubmit = async event => {
            event.preventDefault(); if (submitting) return;
            submitting = true; notice.textContent = ''; save.disabled = true;
            if (main) { busy = true; for (const tab of tabButtons) tab.disabled = true; }
            try { await submit(); }
            catch (error) { if (!signal.aborted) notice.textContent = errorText(error); }
            finally {
                submitting = false; save.disabled = false;
                if (main) { busy = false; for (const tab of tabButtons) tab.disabled = false; }
            }
        };
        form.append(notice); target.replaceChildren(form);
        return form;
    }
    function userSettings() {
        const enabled = status.user.enabled;
        const section = el('section', 'security-form');
        const row = el('div', 'security-status-row');
        const state = el('p', 'security-factor-state');
        state.append(icon(enabled ? 'CircleCheck' : 'CircleAlert'), t(enabled ? 'security.enabled' : 'security.disabled'));
        section.append(el('h3', '', t('security.twoFactor')), row);
        const action = button(t(enabled ? 'security.disable' : 'security.enable'), undefined, () => changeFactor(enabled), 'primary');
        row.append(state, action);
        if (enabled) section.append(el('p', 'muted', t('security.recoveryRemaining', { count: status.user.recoveryRemaining })));
        panel.replaceChildren(section);
        dialog.setFooter();
    }
    async function changeFactor(enabled: boolean) {
        if (busy) return;
        busy = true;
        let enrollment: { secret: string; qr: string } | undefined;
        try {
            if (!enabled) enrollment = await api('/security/setup', 'POST', {}, controller.signal);
        } finally { busy = false; }
        if (!dialog.dialog.open) return;
        const step = el('div', 'security-settings');
        const action = t(enabled ? 'security.disable' : 'security.enable');
        const flow = modal(action, step);
        const flowController = new AbortController(), signal = flowController.signal;
        let changed = false;
        flow.dialog.addEventListener('close', () => {
            flowController.abort();
            step.replaceChildren();
            if (changed) dialog.close();
        }, { once: true });
        if (enrollment) enroll(enrollment);
        else {
            const body = form(action, async () => {
                status.user = await api<Factor>('/security/disable', 'POST', {}, signal);
                changed = true;
                flow.close();
            }, step, flow, signal);
            body.prepend(el('p', '', t('security.enabled')));
        }

        function enroll(enrollment: { secret: string; qr: string }) {
            const otp = code(); otp.inputMode = 'numeric'; otp.pattern = '[0-9]{6}'; otp.maxLength = 6;
            const body = form(action, async () => {
                status.user = await api<Factor>('/security/enable', 'POST', { code: otp.value }, signal);
                changed = true;
                if (!signal.aborted) showRecovery(status.user.recoveryCodes!);
                delete status.user.recoveryCodes;
            }, step, flow, signal);
            const google = el('a', '', 'Google Authenticator');
            google.href = 'https://support.google.com/accounts/answer/1066447';
            const microsoft = el('a', '', 'Microsoft Authenticator');
            microsoft.href = 'https://www.microsoft.com/en-us/security/mobile-authenticator-app';
            for (const link of [google, microsoft]) {
                link.target = '_blank'; link.rel = 'noopener noreferrer';
            }
            const instructions = el('p', 'security-instructions');
            for (const part of t('security.scanAuthenticator', { google: '\uFFF0', microsoft: '\uFFF1' }).split(/([\uFFF0\uFFF1])/)) {
                instructions.append(part === '\uFFF0' ? google.cloneNode(true) : part === '\uFFF1' ? microsoft.cloneNode(true) : part);
            }
            const qr = el('img', 'security-qr'); qr.src = enrollment.qr; qr.alt = t('security.setupKey'); qr.width = qr.height = 256;
            const secret = el('input'); secret.readOnly = true; secret.value = enrollment.secret; secret.dir = 'ltr';
            body.prepend(instructions, qr, field('security.setupKey', secret), field('security.authenticatorCode', otp));
            instructions.tabIndex = -1;
            instructions.focus();
        }

        function showRecovery(codes: string[]) {
            const block = el('pre', 'security-recovery', codes.join('\n'));
            const download = button(t('security.saveRecovery'), 'Download', () => {
                const url = URL.createObjectURL(new Blob([codes.join('\n') + '\n'], { type: 'text/plain' }));
                const link = el('a'); link.href = url; link.download = 'tuxee-recovery-codes.txt'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
            });
            const recovery = el('div', 'security-form');
            recovery.append(el('h3', '', t('security.recoveryCodes')), el('p', '', t('security.recoveryHelp')), block, download);
            step.replaceChildren(recovery);
            flow.setFooter(button(t('common.close'), undefined, flow.close));
            download.focus();
        }
    }
    function globalSettings() {
        const network = status.network!, allowed = el('textarea'), proxies = el('textarea');
        allowed.name = 'allowedNetworks'; proxies.name = 'trustedProxies';
        for (const input of [allowed, proxies]) { input.rows = 4; input.dir = 'ltr'; input.spellcheck = false; input.maxLength = 8192; }
        allowed.value = network.allowedNetworks.join('\n'); proxies.value = network.trustedProxies.join('\n');
        allowed.placeholder = '10.8.0.0/24\n203.0.113.42\n2001:db8::/64';
        const lines = (input: HTMLTextAreaElement) => input.value.split('\n').map(line => line.trim()).filter(Boolean);
        const draft = () => ({ allowedNetworks: lines(allowed), trustedProxies: lines(proxies) });
        const body = form(t('common.save'), async () => {
            const value = draft();
            let result = await api<{ saved: boolean }>('/security/network', 'PUT', value, controller.signal);
            if (!result.saved) {
                if (!await confirmAction(t('security.networkFilter'), t('security.confirmNetworkDisconnect'), t('common.save'))) return;
                result = await api<{ saved: boolean }>('/security/network', 'PUT', { ...value, confirmDisconnect: true }, controller.signal);
            }
            if (!result.saved) throw Error(t('common.failed'));
            status.network = value; dialog.close();
        });
        const testIP = el('input');
        testIP.id = 'security-test-ip'; testIP.name = 'testIP'; testIP.dir = 'ltr'; testIP.maxLength = 64;
        testIP.autocomplete = 'off'; testIP.spellcheck = false;
        testIP.placeholder = status.clientIP;
        const result = el('p', 'muted security-network-result');
        result.setAttribute('role', 'status');
        let revision = 0;
        const testLabel = t('security.testNetwork');
        const test = button(testLabel, 'Search', async () => {
            const tested = ++revision;
            result.textContent = '';
            test.disabled = true;
            try {
                const { allowed } = await api<{ allowed: boolean }>('/security/network', 'POST', { ...draft(), ip: testIP.value }, controller.signal);
                if (tested === revision) {
                    const indicator = icon(allowed ? 'CircleCheck' : 'CircleAlert');
                    indicator.classList.add(allowed ? 'allowed' : 'blocked');
                    result.replaceChildren(indicator, t(allowed ? 'security.testAllowed' : 'security.testBlocked'));
                }
            } catch (error) {
                if (tested === revision && !controller.signal.aborted) result.textContent = errorText(error);
            } finally { test.disabled = false; }
        });
        test.append(testLabel);
        for (const input of [allowed, proxies, testIP]) input.addEventListener('input', () => {
            revision++;
            result.textContent = '';
        });
        testIP.addEventListener('keydown', event => {
            if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); test.click(); }
        });
        const tester = el('div', 'security-network-test');
        const label = el('label', 'field', t('security.testIP'));
        label.htmlFor = testIP.id;
        const testRow = el('div', 'security-network-test-row');
        testRow.append(testIP, test);
        tester.append(label, testRow, result);
        const recovery = el('p', 'muted');
        t('security.networkWarning', { command: '\uFFFC' }).split('\uFFFC').forEach((part, index) => {
            if (index) { const command = el('code', 'update-command', status.networkRecoveryCommand || ''); command.dir = 'ltr'; recovery.append(command); }
            recovery.append(document.createTextNode(part));
        });
        body.prepend(el('h3', '', t('security.networkFilter')), el('p', '', t('security.currentIP', { address: status.clientIP })),
            field('security.allowedNetworks', allowed), el('p', 'muted', t('security.networkHelp')),
            field('security.trustedProxies', proxies), el('p', 'muted', t('security.proxyHelp')),
            tester, recovery);
    }
    dialog.dialog.addEventListener('close', () => { controller.abort(); content.replaceChildren(); }, { once: true });
    select('user');
}
