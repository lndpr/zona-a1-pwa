/* ZONA A1 PWA install prompt.
   Service Worker registration stays in the existing notification code in index.html
   so there is only one registration path to maintain. */
(() => {
  "use strict";

  let installPrompt = null;
  const installButton = document.createElement("button");
  installButton.type = "button";
  installButton.textContent = "INSTALL ZONA A1";
  installButton.setAttribute("aria-label", "Install ZONA A1 app");
  installButton.hidden = true;
  installButton.style.cssText = [
    "position:fixed",
    "right:16px",
    "bottom:calc(18px + env(safe-area-inset-bottom,0px))",
    "z-index:9998",
    "padding:12px 16px",
    "border:1px solid rgba(66,217,237,.55)",
    "border-radius:999px",
    "background:#0b2633",
    "color:#dffaff",
    "font:800 11px Inter,Arial,sans-serif",
    "letter-spacing:1px",
    "box-shadow:0 8px 28px rgba(0,0,0,.35)",
    "cursor:pointer"
  ].join(";");

  const mountButton = () => {
    if (document.body && !installButton.isConnected) {
      document.body.appendChild(installButton);
    }
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountButton, { once: true });
  } else {
    mountButton();
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
    installButton.hidden = false;
  });

  installButton.addEventListener("click", async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    try { await installPrompt.userChoice; } catch (_) { /* User dismissed prompt. */ }
    installPrompt = null;
    installButton.hidden = true;
  });

  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    installButton.hidden = true;
  });
})();
