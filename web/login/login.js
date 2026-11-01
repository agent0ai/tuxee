// Kept independent of application code and build tools to preserve the public response.
let catalog = JSON.parse(document.querySelector('#tuxee-i18n').textContent);
function t(key, vars = {}) {
    const value = catalog.texts[key];
    if (typeof value !== 'string') return `[!${key}]`;
    return value.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (token, name) => Object.hasOwn(vars, name) ? String(vars[name]) : token);
}
function el(tag, cls = '', text = '') {
    const node = document.createElement(tag);
    node.className = cls;
    node.textContent = text;
    return node;
}
async function api(path, body) {
    let response;
    try {
        response = await fetch('/api' + path, {
            method: body === undefined ? 'GET' : 'POST', cache: 'no-store',
            headers: { 'Content-Type': 'application/json', 'X-Tuxee-Client': 'web' },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        if (!response.headers.get('Content-Type')?.startsWith('application/json')) throw Error();
    } catch { throw Error(t('ui.connectionLostTryAgainWhenReconnected')); }
    const data = await response.json();
    if (!response.ok) throw Error(Object.hasOwn(catalog.texts, data.text?.key) ? t(data.text.key, data.text.vars) : t('app.signInFailed'));
    return data;
}
const page = el('div', 'login-page'), content = el('div', 'login-content'), form = el('form', 'login-form');
const logo = el('img', 'login-logo');
logo.src = '/login-logo.webp'; logo.width = logo.height = 512; logo.draggable = false;
const language = el('select', 'login-language');
language.name = 'language'; language.dir = 'ltr';
for (const item of catalog.languages) {
    const option = el('option', '', `${item.code.toUpperCase()} ${item.name}`);
    option.value = item.code; language.append(option);
}
language.value = catalog.language;
// Match native application selects without importing its changing bundle.
language.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'mouse' || event.button !== 0 || language.disabled || typeof language.showPicker !== 'function') return;
    event.preventDefault(); language.focus();
    const press = new AbortController(), signal = press.signal;
    window.addEventListener('pointerup', release => {
        press.abort();
        if (release.pointerId === event.pointerId && release.target === language && language.isConnected && !language.disabled) language.showPicker();
    }, { capture: true, once: true, signal });
    for (const type of ['pointerdown', 'pointercancel', 'blur', 'keydown']) window.addEventListener(type, () => press.abort(), { capture: true, once: true, signal });
});
form.append(logo, language);
const username = el('input'), password = el('input');
username.name = 'username'; username.autocomplete = 'username'; username.autofocus = matchMedia('(pointer: fine)').matches;
password.name = 'password'; password.type = 'password'; password.autocomplete = 'current-password';
const labels = [];
for (const [key, input] of [['login.username', username], ['login.password', password]]) {
    input.required = true; input.dir = 'auto';
    input.addEventListener('input', () => input.setCustomValidity(''));
    input.addEventListener('invalid', () => {
        input.setCustomValidity('');
        input.setCustomValidity(t(input.validity.valueMissing ? 'validation.required' : 'validation.invalid'));
    });
    const label = el('label', 'field'), text = el('span');
    labels.push({ key, text }); label.append(text, input); form.append(label);
}
const status = el('p', 'login-error'), submit = el('button', 'primary login-submit');
status.setAttribute('role', 'alert'); submit.type = 'submit'; form.append(status, submit);
function translate() {
    document.documentElement.lang = catalog.language; document.documentElement.dir = catalog.direction;
    language.setAttribute('aria-label', t('login.language')); logo.alt = t('app.tuxee');
    for (const { key, text } of labels) text.textContent = t(key);
    submit.textContent = submit.title = t('login.signIn'); submit.setAttribute('aria-label', submit.title);
    username.setCustomValidity(''); password.setCustomValidity('');
}
translate();
language.onchange = async () => {
    const previous = catalog.language;
    language.disabled = submit.disabled = true;
    try {
        catalog = await api('/language?language=' + encodeURIComponent(language.value));
        document.cookie = `${catalog.cookie}=${encodeURIComponent(catalog.language)}; Path=/; Max-Age=31536000; SameSite=Strict${location.protocol === 'https:' ? '; Secure' : ''}`;
        language.value = catalog.language; status.textContent = ''; translate();
    } catch { language.value = previous; status.textContent = t('login.languageFailed'); }
    finally { language.disabled = submit.disabled = false; }
};
form.onsubmit = async event => {
    event.preventDefault(); language.disabled = submit.disabled = true; status.textContent = '';
    const value = password.value; password.value = '';
    try {
        await api('/login', { username: username.value, password: value, language: catalog.language });
        location.replace('/');
    } catch (error) { status.textContent = error.message; language.disabled = submit.disabled = false; }
};
content.append(form); page.append(content); document.querySelector('#app').append(page);
function viewport() {
    const height = visualViewport ? visualViewport.height * visualViewport.scale : innerHeight;
    document.documentElement.style.setProperty('--viewport-height', `${height}px`);
}
window.addEventListener('resize', viewport); visualViewport?.addEventListener('resize', viewport); viewport();
if (username.autofocus) username.focus();
// A login in another tab becomes visible on return, without idle polling.
window.addEventListener('focus', () => {
    if (!submit.disabled) void api('/connection').then(state => { if (state.authenticated) location.replace('/'); }).catch(() => {});
});
