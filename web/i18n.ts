export type Message = { key: string; vars?: Record<string, unknown> };
export type Translations = { language: string; direction: 'ltr' | 'rtl'; texts: Record<string, string>; languages: { code: string; name: string }[]; cookie: string };
let catalog: Translations = { language: 'en', direction: 'ltr', texts: {}, languages: [], cookie: '' };
const data = typeof document !== 'undefined' && document.querySelector('#tuxee-i18n');
if (data?.textContent) catalog = JSON.parse(data.textContent);

export function translations() { return catalog; }
export function setTranslations(value: Translations) {
    catalog = value;
    if (typeof document !== 'undefined') {
        document.documentElement.lang = value.language;
        document.documentElement.dir = value.direction;
    }
}
export function rememberLanguage() {
    document.cookie = `${catalog.cookie}=${encodeURIComponent(catalog.language)}; Path=/; Max-Age=31536000; SameSite=Strict${location.protocol === 'https:' ? '; Secure' : ''}`;
}
export function t(key: string, vars: Record<string, unknown> = {}): string {
    const template = Object.hasOwn(catalog.texts, key) ? catalog.texts[key] : undefined;
    const missing = () => `[!${key}${Object.keys(vars).sort().map(name => ` ${name}=${JSON.stringify(vars[name])}`).join('')}]`;
    if (template === undefined) return missing();
    let valid = true;
    const text = template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_, name: string) => {
        if (!Object.hasOwn(vars, name)) { valid = false; return ''; }
        const value = vars[name];
        return isMessage(value) ? t(value.key, value.vars) : String(value);
    });
    return valid ? text : missing();
}
function isMessage(value: unknown): value is Message {
    return !!value && typeof value === 'object' && 'key' in value && typeof value.key === 'string';
}
export function errorText(value: { text?: Message; error?: string; message?: string }): string {
    return value.text ? t(value.text.key, value.text.vars) : t('error.detail', { detail: value.error || value.message || '' });
}
export function locale() {
    try { return Intl.getCanonicalLocales(catalog.language)[0] || 'en'; } catch { return 'en'; }
}
