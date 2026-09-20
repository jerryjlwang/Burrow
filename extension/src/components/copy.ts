/**
 * Copy hygiene for text the rabbit did not write himself (model replies, page snippets): no em or en
 * dashes reach the screen. A dash between words becomes a comma; one at either end is dropped.
 */
export function plainCopy(text: string): string {
  return text
    .replace(/^\s*[\u2014\u2013]\s*/, "")
    .replace(/\s*[\u2014\u2013]\s*$/, "")
    .replace(/\s*[\u2014\u2013]+\s*/g, ", ");
}
