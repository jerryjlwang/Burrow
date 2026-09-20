import { mountCompanion } from "./mount";
import { HOST_ID } from "../page-understanding/extract";

function shouldRun(): boolean {
  if (window.top !== window) return false;
  if (document.getElementById(HOST_ID)) return false;
  const ct = document.contentType;
  if (ct && !/html|xhtml|pdf/i.test(ct)) return false;
  if (!document.documentElement) return false;
  return true;
}

if (shouldRun()) {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void mountCompanion(), { once: true });
  else mountCompanion();
}
