import { Icon } from "./icons";
export type CurveState = {
  phase: "bonding" | "complete" | "migrated";
  progressBps: number;
  raisedRaw: string | null;
  targetRaw: string | null;
  remainingRaw: string | null;
  priceNear: string | null;
  address: string;
  slot: number;
  observedAt: string;
};
const near = (raw: string | null) => {
  if (raw === null || !/^\d+$/.test(raw)) return "—";
  const n = (BigInt(raw) + 50000n) / 100000n;
  return `${n / 10000n}.${(n % 10000n).toString().padStart(4, "0")}`.replace(
    /\.?0+$/,
    "",
  );
};
export function CurveProgress({
  curve,
  retry,
}: {
  curve: CurveState | null | undefined;
  retry: () => void;
}) {
  const p = curve ? curve.progressBps / 100 : null;
  return (
    <section className="curve-panel panel" aria-label="NEAR bonding curve">
      <div className="curve-heading">
        <div>
          <span className="eyebrow">NEAR BONDING CURVE</span>
          <h2>
            {curve
              ? curve.phase === "bonding"
                ? "Building toward graduation."
                : curve.phase === "complete"
                  ? "Curve complete."
                  : "Graduated from the curve."
              : "Curve data is refreshing."}
          </h2>
        </div>
        <strong>{p !== null ? `${p.toFixed(2)}%` : "—"}</strong>
      </div>
      {curve ? (
        <>
          <div
            className="curve-track"
            role="progressbar"
            aria-label="NEAR funding progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={p!}
          >
            <span style={{ width: `${p}%` }} />
          </div>
          {curve.phase !== "migrated" ? (
            <div className="curve-values">
              <div>
                <span>NEAR in the curve</span>
                <b title={curve.raisedRaw || undefined}>
                  {near(curve.raisedRaw)} <small>NEAR</small>
                </b>
              </div>
              <div>
                <span>Estimated NEAR to complete</span>
                <b>
                  {near(curve.remainingRaw)} <small>NEAR</small>
                </b>
              </div>
              <div>
                <span>Curve price / coin</span>
                <b>
                  {curve.priceNear || "—"} <small>NEAR</small>
                </b>
              </div>
            </div>
          ) : (
            <p className="curve-note">
              The curve reserves have moved out of the bonding curve. Check the
              trading venue for the migrated pool.
            </p>
          )}
          <div className="curve-footer">
            <span>
              Finalized slot {curve.slot.toLocaleString()} · net reserves,
              excluding trading fees
            </span>
            <a
              href={"https://solscan.io/account/" + curve.address}
              target="_blank"
              rel="noreferrer"
            >
              Verify curve <Icon name="arrow" size={12} />
            </a>
          </div>
          {curve.phase === "bonding" && (
            <p className="curve-note">
              Progress compares net NEAR reserves with the current curve’s
              estimated completion amount ({near(curve.targetRaw)} NEAR). It
              changes with buys and sells; it is not gross trading volume.
            </p>
          )}
        </>
      ) : (
        <div className="curve-unavailable">
          <p>
            The onchain curve could not be verified. No reserve balance or
            graduation percentage is assumed.
          </p>
          <button className="text-link" onClick={retry}>
            Refresh curve <Icon name="refresh" size={14} />
          </button>
        </div>
      )}
    </section>
  );
}
