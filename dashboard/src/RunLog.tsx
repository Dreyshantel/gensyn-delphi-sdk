import { useEffect, useRef } from "react";

import type { RunState } from "./types";

export function RunLog({ run }: { run: RunState | null }) {
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (run?.status === "running") {
      end.current?.scrollIntoView({ block: "end" });
    }
  }, [run?.log.length, run?.status]);

  if (!run || run.log.length === 0) {
    return <p className="empty">No run yet. The log of each evidence search shows here as it happens.</p>;
  }

  return (
    <div className="run-log" aria-live="polite">
      <pre>{run.log.join("\n")}</pre>
      <div ref={end} />
    </div>
  );
}
