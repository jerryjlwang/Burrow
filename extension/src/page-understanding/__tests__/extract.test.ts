// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { extractPage } from "../extract";
import { ElementRegistry } from "../registry";

function render(html: string) {
  document.body.innerHTML = html;
  const registry = new ElementRegistry();
  const page = extractPage(document, { registry, skipLayout: true });
  return { page, registry };
}

describe("extractPage", () => {
  it("captures semantic interactive elements with roles, names and states", () => {
    const { page, registry } = render(`
      <main>
        <h1>Assignment 4</h1>
        <a href="/home">Home</a>
        <button>Start Quiz</button>
        <label for="ans">Answer</label><input id="ans" value="12" />
        <button disabled>Submit Answer</button>
        <input type="checkbox" id="c" checked /><label for="c">I agree</label>
        <select id="s"><option>One</option><option selected>Two</option></select>
        <div role="tab" aria-selected="true">Overview</div>
      </main>`);
    const byName = Object.fromEntries(page.elements.map((e) => [e.name, e]));
    expect(byName["Home"].role).toBe("link");
    expect(byName["Start Quiz"].role).toBe("button");
    expect(byName["Answer"].role).toBe("textbox");
    expect(byName["Answer"].value).toBe("12");
    expect(byName["Submit Answer"].disabled).toBe(true);
    expect(byName["I agree"].checked).toBe(true);
    expect(byName["Answer"].context).toBe("Assignment 4");
    expect(byName["Overview"].selected).toBe(true);
    expect(page.headings).toEqual(["Assignment 4"]);
    expect(page.landmarks).toContain("main");
    for (const e of page.elements) expect(registry.get(e.id)).toBeTruthy();
  });
  it("filters hidden elements", () => {
    const { page } = render(`
      <button style="display:none">Hidden A</button>
      <div hidden><button>Hidden B</button></div>
      <button aria-hidden="true">Hidden C</button>
      <input type="hidden" value="x" />
      <button>Visible</button>`);
    expect(page.elements.map((e) => e.name)).toEqual(["Visible"]);
  });
  it("redacts password and sensitive field values", () => {
    const { page } = render(`
      <label for="p">Password</label><input id="p" type="password" value="hunter2" />
      <input aria-label="Card number" value="4111111111111111" />
      <input aria-label="First name" value="Sam" />`);
    const pw = page.elements.find((e) => e.name === "Password")!;
    const card = page.elements.find((e) => e.name === "Card number")!;
    const name = page.elements.find((e) => e.name === "First name")!;
    expect(pw.sensitive).toBe(true);
    expect(pw.value).toBeUndefined();
    expect(card.sensitive).toBe(true);
    expect(card.value).toBeUndefined();
    expect(name.value).toBe("Sam");
    expect(JSON.stringify(page)).not.toContain("hunter2");
  });
  it("detects error/success messages, dialogs and quiz UI", () => {
    const { page } = render(`
      <h1>Question 1</h1><p>Solve for x: 3x + 5 = 20</p>
      <input aria-label="Your answer" /><button>Check answer</button>
      <div role="alert">Not quite — try again.</div>
      <div class="feedback success">Correct! x = 5</div>
      <div role="dialog" aria-label="Time's up"><button>OK</button></div>`);
    expect(page.errors).toContain("Not quite — try again.");
    expect(page.successes).toContain("Correct! x = 5");
    expect(page.dialogs).toContain("Time's up");
    expect(page.hasQuizUi).toBe(true);
  });
  it("derives names from aria-labelledby, placeholders and nested images", () => {
    const { page } = render(`
      <span id="lbl">Search courses</span><input aria-labelledby="lbl" />
      <input placeholder="Type here" />
      <a href="/x"><img alt="Profile" /></a>
      <button aria-label="Close dialog">×</button>`);
    const names = page.elements.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["Search courses", "Type here", "Profile", "Close dialog"]));
  });
  it("keeps ids stable across rescans", () => {
    document.body.innerHTML = `<button>One</button><button>Two</button>`;
    const registry = new ElementRegistry();
    const a = extractPage(document, { registry, skipLayout: true });
    document.body.insertAdjacentHTML("afterbegin", "<p>new text</p>");
    const b = extractPage(document, { registry, skipLayout: true });
    expect(b.elements.map((e) => e.id)).toEqual(a.elements.map((e) => e.id));
  });
});
