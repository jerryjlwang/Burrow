import { useStore, type PlanRoute } from "../content/store";
import type { CompanionController } from "../content/controller";

/**
 * The plan map: the learner's step-by-step plans as something to look at and tap, not a paragraph
 * of chat. Shows the route through the problem on screen (where their working has got to) and
 * every learning plan in long-term memory (what's done, what's next). Opened by the agent's
 * `show_plan` action and right after `make_plan`; stays live while open. Tapping an open step of a
 * learning plan runs that step's playbook — the map is a control, not a readout.
 * Step titles are leak-safe by construction (they name moves, never results), so showing them is fine.
 */
const wrap: React.CSSProperties = {
  position: "fixed",
  left: 16,
  bottom: 16,
  width: 380,
  maxWidth: "calc(100vw - 32px)",
  maxHeight: "70vh",
  overflowY: "auto",
  padding: "14px 40px 14px 18px",
  background: "#1d2430",
  color: "#eaf3e6",
  border: "3px solid #3c4a5c",
  borderRadius: 10,
  boxShadow: "0 6px 24px rgba(0,0,0,0.45)",
  fontFamily: "inherit",
  fontSize: 16,
  lineHeight: 1.4,
  zIndex: 2147483000,
  // The companion host ignores pointer events so pages stay clickable; interactive surfaces opt back in.
  pointerEvents: "auto",
};

const marker = (state: "done" | "current" | "todo"): React.CSSProperties => ({
  flex: "0 0 22px",
  height: 22,
  borderRadius: 11,
  border: `2px solid ${state === "todo" ? "#5b6b80" : "#f2c14e"}`,
  background: state === "done" ? "#f2c14e" : "transparent",
  color: "#1d2430",
  fontSize: 13,
  fontWeight: 700,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
});

function Route({ route, onStart }: { route: PlanRoute; onStart: (index: number) => void }) {
  const done = route.steps.filter((s) => s.state === "done").length;
  return (
    <section className="pip-plan-route" data-kind={route.kind} style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontWeight: 700, marginBottom: 6 }}>
        <span className="pip-plan-goal">{route.kind === "problem" ? "This problem" : route.goal}</span>
        <span style={{ opacity: 0.7, fontWeight: 400, whiteSpace: "nowrap" }}>
          {done}/{route.steps.length}
        </span>
      </div>
      <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {route.steps.map((step, i) => (
          <li key={i} className={`pip-plan-step ${step.state}`} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "4px 0", opacity: step.state === "todo" ? 0.7 : 1 }}>
            <span aria-hidden="true" style={marker(step.state)}>
              {step.state === "done" ? "✓" : i + 1}
            </span>
            <span style={{ flex: 1, textDecoration: step.state === "done" ? "line-through" : "none", textDecorationColor: "#5b6b80" }}>
              {step.title}
              {step.state === "current" && route.kind === "problem" && <em style={{ display: "block", fontSize: 13, opacity: 0.75 }}>you are here</em>}
            </span>
            {route.kind === "topic" && step.state !== "done" && (
              <button
                type="button"
                className="pip-plan-start"
                onClick={() => onStart(i)}
                style={{ background: step.state === "current" ? "#f2c14e" : "transparent", color: step.state === "current" ? "#1d2430" : "#eaf3e6", border: "2px solid #f2c14e", borderRadius: 6, padding: "1px 8px", cursor: "pointer", fontFamily: "inherit", fontSize: 14 }}
              >
                {step.state === "current" ? "Go" : "Jump here"}
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

export function PlanMap({ controller }: { controller: CompanionController }) {
  const view = useStore((s) => s.planView);
  if (!view) return null;
  return (
    <div className="pip-plan" role="region" aria-label="your plans" style={wrap}>
      {view.routes.map((route) => (
        <Route key={route.key} route={route} onStart={(index) => controller.startPlanStep(route.key, index)} />
      ))}
      <button
        type="button"
        aria-label="Close the plan"
        onClick={() => controller.closePlan()}
        style={{ position: "absolute", top: 6, right: 8, background: "none", border: "none", color: "#eaf3e6", cursor: "pointer", fontSize: 16, opacity: 0.7 }}
      >
        ✕
      </button>
    </div>
  );
}
