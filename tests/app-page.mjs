// Unrelated browser suites dismiss onboarding through its real close control.
export async function appPage(context) {
    const page = await context.newPage();
    await page.addInitScript(() => {
        // Raw keyboard actions do not trigger Playwright locator handlers.
        new MutationObserver(() => {
            document.querySelector('.howto-modal[open] .modal-head > button')?.click();
        }).observe(document, { childList: true, subtree: true });
    });
    return page;
}
