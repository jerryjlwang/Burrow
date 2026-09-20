// React only mounts the map; graph-view.ts draws it. The view keeps its room positions across
// graph updates, so a storage change moves rooms a little instead of relaying the whole map.
import { useEffect, useRef } from "react";
import type { GraphSnapshot } from "@shared/graph";
import { mountGraph, type GraphView } from "./graph-view";

export function Graph({ graph, onPick }: { graph: GraphSnapshot; onPick: (id: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<GraphView | null>(null);
  const pick = useRef(onPick);

  useEffect(() => {
    pick.current = onPick;
  }, [onPick]);

  useEffect(() => {
    const v = mountGraph(host.current!, { onPick: (id) => pick.current(id) });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    view.current?.setGraph(graph);
  }, [graph]);

  return <div ref={host} className="graph-wrap px-frame" />;
}
