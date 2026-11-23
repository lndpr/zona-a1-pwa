/* ZONA A1 PWA install prompt + Service Worker registration.
   This file is the ONLY place that registers the Service Worker: it runs
   on page load, so push/offline/install work even if the user never taps
   the NOTIF HP button. The notification code in index.html reuses the
   registration created here (via getRegistration()). */
(() => {
  "use strict";

  // ── Service Worker: register once, on load ──────────────────────────
  if ("serviceWorker" in navigator) {
    const registerSW = () => {
      navigator.serviceWorker.register("./sw.js").catch((err) => {
        console.warn("ZONA A1: Service Worker registration failed", err);
      });
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", registerSW, { once: true });
    } else {
      registerSW();
    }
  }

  // ── Install prompt (Android/Chrome) ─────────────────────────────────
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

  let installPromptSeen = false;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
    installPromptSeen = true;
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

  // ── iOS hint: Safari has no beforeinstallprompt, push only works from
  // the installed PWA (Add to Home Screen). Show a dismissible hint bar
  // if the install prompt never fires and we are not already standalone. ──
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent || "") ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isStandalone = window.navigator.standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches;
  if (isIOS && !isStandalone) {
    setTimeout(() => {
      if (installPromptSeen || document.getElementById("a1IosHint")) return;
      const bar = document.createElement("div");
      bar.id = "a1IosHint";
      bar.setAttribute("role", "status");
      bar.style.cssText = [
        "position:fixed",
        "left:12px",
        "right:12px",
        "bottom:calc(12px + env(safe-area-inset-bottom,0px))",
        "z-index:9998",
        "display:flex",
        "align-items:center",
        "gap:10px",
        "padding:12px 14px",
        "border:1px solid rgba(66,217,237,.45)",
        "border-radius:12px",
        "background:#0b2633",
        "color:#dffaff",
        "font:600 12px/1.5 Inter,Arial,sans-serif",
        "box-shadow:0 8px 28px rgba(0,0,0,.35)"
      ].join(";");
      bar.textContent = "iPhone: ketuk Share → Add to Home Screen, lalu buka ZONA A1 dari ikon di Home Screen untuk mengaktifkan notifikasi.";
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "×";
      close.setAttribute("aria-label", "Tutup petunjuk");
      close.style.cssText = "margin-left:auto;background:none;border:0;color:#dffaff;font-size:18px;line-height:1;cursor:pointer;padding:2px 6px";
      close.addEventListener("click", () => bar.remove());
      bar.appendChild(close);
      if (document.body) document.body.appendChild(bar);
    }, 2000);
  }
})();
