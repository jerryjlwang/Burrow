import { createRoot } from "react-dom/client";
import { createElement } from "react";
import styles from "../components/styles.css";
import { CompanionRoot } from "../components/CompanionRoot";
import { CompanionController } from "./controller";
import { HOST_ID } from "../page-understanding/extract";
import { log } from "../shared/logger";

const logger = log("ui");

/** Mounts the companion (shadow DOM host + controller) into the current document. Idempotent. */
export function mountCompanion(): CompanionController | null {
  if (document.getElementById(HOST_ID)) return null;
  const host = document.createElement("div");
  host.id = HOST_ID;
  host.setAttribute("data-pip", "companion");
  // Attached to <html>, not <body>, so body transforms / overflow rules cannot move or clip us.
  host.style.cssText = "position:fixed;inset:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2147483646;margin:0;padding:0;border:0;";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = styles;
  shadow.appendChild(style);
  const container = document.createElement("div");
  shadow.appendChild(container);
  (document.documentElement ?? document.body).appendChild(host);

  const controller = new CompanionController();
  const root = createRoot(container);
  root.render(createElement(CompanionRoot, { controller }));
  void controller.init().catch((e) => logger.error("init failed", { error: String(e) }));

  // If the host page removes our node (aggressive SPAs do), put it back.
  const guard = new MutationObserver(() => {
    if (!document.getElementById(HOST_ID) && document.documentElement) document.documentElement.appendChild(host);
  });
  guard.observe(document.documentElement, { childList: true });

  window.addEventListener("pagehide", () => {
    controller.destroy();
  });
  return controller;
}
