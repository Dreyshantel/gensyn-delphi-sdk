interface TallyProps {
  judged: number;
  judgedNeeded: number;
  markets: number;
  marketsNeeded: number;
  qualified: boolean;
}

/** One group of five tally strokes: four upright, one diagonal. */
function TallyGroup({ filled }: { filled: number }) {
  const uprights = [8, 20, 32, 44];

  return (
    <svg className="tally-group" viewBox="0 0 52 56" aria-hidden="true">
      {uprights.map((x, i) => (
        <line key={x} x1={x} y1={6} x2={x} y2={50} className={i < filled ? "stroke on" : "stroke"} />
      ))}
      <line x1={2} y1={40} x2={50} y2={14} className={filled >= 5 ? "stroke on" : "stroke"} />
    </svg>
  );
}

export function Tally({ judged, judgedNeeded, markets, marketsNeeded, qualified }: TallyProps) {
  const groups = Math.ceil(judgedNeeded / 5);
  const shown = Math.min(judged, judgedNeeded);

  return (
    <section className="tally" aria-label="Prize eligibility">
      <h2 className="side-heading">Prize eligibility</h2>
      <div className="tally-row" role="img" aria-label={`${judged} of ${judgedNeeded} judged submissions`}>
        {Array.from({ length: groups }, (_, g) => (
          <TallyGroup key={g} filled={Math.max(0, Math.min(5, shown - g * 5))} />
        ))}
      </div>
      <p className="tally-caption">
        <strong>{judged}</strong> of {judgedNeeded} judged submissions
      </p>

      <div className="market-marks" role="img" aria-label={`${markets} of ${marketsNeeded} markets`}>
        {Array.from({ length: marketsNeeded }, (_, i) => (
          <span key={i} className={i < markets ? "market-mark on" : "market-mark"} />
        ))}
      </div>
      <p className="tally-caption">
        <strong>{markets}</strong> of {marketsNeeded} markets
      </p>

      <p className={qualified ? "qualified yes" : "qualified"}>
        {qualified ? "You meet the prize activity minimum." : "Both counts must be met to qualify for prizes."}
      </p>
    </section>
  );
}
