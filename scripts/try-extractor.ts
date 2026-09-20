/**
 * Exercise the concept extractor against sample pages/queries without a browser.
 *   npx tsx scripts/try-extractor.ts
 * Uses .env: with an OpenAI key it runs OpenAIConceptExtractor, otherwise the heuristic floor.
 * Add --both to print the heuristic alongside the LLM for comparison.
 */
import { loadConfig } from "../server/src/config";
import { HeuristicConceptExtractor, type ConceptExtractor, type ConceptExtraction, type ExtractionInput } from "../shared/src/concepts";
import { OpenAIConceptExtractor } from "../server/src/agent/openai-extract";

const cfg = loadConfig();
const both = process.argv.includes("--both");
const useOpenAI = cfg.llmProvider === "openai" && !!cfg.llmApiKey;
const primary: ConceptExtractor = useOpenAI
  ? new OpenAIConceptExtractor({ apiKey: cfg.llmApiKey, model: cfg.llmModel, effort: cfg.llmEffort })
  : new HeuristicConceptExtractor();
const heuristic = new HeuristicConceptExtractor();

console.log(`extractor: ${useOpenAI ? `openai:${cfg.llmModel}` : "heuristic (no OpenAI key in .env)"}\n`);

const scenarios: Array<{ label: string; input: ExtractionInput }> = [
  {
    label: "search query with a misconception",
    input: {
      url: "https://www.google.com/search?q=why+is+summer+hot",
      title: "why is summer hot - Google Search",
      query: "why is summer hot is the sun closer to the earth in summer",
      text: "Summer is the hottest season... People often think summer happens because Earth is closer to the Sun.",
    },
  },
  {
    label: "Khan Academy: linear equations",
    input: {
      url: "https://www.khanacademy.org/math/algebra/two-step-equations",
      title: "Two-step equations · Khan Academy",
      headings: ["Two-step equations", "Intro to two-step equations", "Checking your solution"],
      text: "Solve equations like 3x + 5 = 20 by undoing addition, then undoing multiplication. Check by substituting back.",
    },
  },
  {
    label: "Wikipedia: axial tilt",
    input: {
      url: "https://en.wikipedia.org/wiki/Axial_tilt",
      title: "Axial tilt - Wikipedia",
      headings: ["Axial tilt", "Obliquity of the ecliptic", "Effect on seasons", "Precession"],
      text: "Axial tilt is the angle between an object's rotational axis and its orbital axis. Earth's ~23.4° tilt causes the seasons.",
    },
  },
];

function show(label: string, extraction: ConceptExtraction, ms?: number): void {
  console.log(`▶ ${label}${ms != null ? `  [${ms}ms]` : ""}`);
  console.log(`   concepts: ${extraction.concepts.map((c) => `${c.label}(${c.salience.toFixed(2)})`).join(", ") || "—"}`);
  console.log(`   edges: ${extraction.edges.map((e) => `${e.from} —${e.type}→ ${e.to}`).join(", ") || "—"}`);
  console.log(`   misconceptions: ${extraction.misconceptions.map((m) => `[${m.concept}] ${m.belief}`).join("; ") || "—"}\n`);
}

for (const s of scenarios) {
  const t0 = Date.now();
  try {
    const out = await primary.extract(s.input);
    show(useOpenAI ? `${s.label} (openai)` : s.label, out, Date.now() - t0);
    if (both && useOpenAI) show(`${s.label} (heuristic)`, heuristic.extract(s.input));
  } catch (e) {
    console.log(`▶ ${s.label}\n   ERROR ${e instanceof Error ? e.message : String(e)}\n`);
  }
}
