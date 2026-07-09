// Smoke: the app boots and the main shell renders. Proves the Tauri window + webview + React
// mount all work end-to-end. Not a feature test — deliberately asserts one durable element.
describe("Modelius shell", () => {
  it("renders the sidebar once the webview loads", async () => {
    // Under the driver the WebView2 can sit on about:blank (the app's initial navigation
    // races the WebDriver attach on Windows) — steer to the app origin explicitly.
    if ((await browser.getUrl()) === "about:blank") await browser.url("http://tauri.localhost/");
    const sidebar = await $("nav.sidebar");
    await sidebar.waitForExist({ timeout: 30_000 });
    await expect(sidebar).toBeExisting();
  });
});
