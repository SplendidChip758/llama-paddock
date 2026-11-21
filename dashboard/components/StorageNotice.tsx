"use client";

import { usePaddock } from "@/components/PaddockProvider";
import { fmtDur } from "@/lib/format";

/** On every page while the dashboard can't save to its database: what is being lost, and since when. */
export function StorageNotice() {
  const { storageFailures } = usePaddock();
  if (!storageFailures.length) return null;
  const now = Date.now() / 1000;
  return (
    <div className="notice bad" role="alert">
      <strong>The dashboard can&apos;t save to its database.</strong> It keeps monitoring, but what it can&apos;t save is lost:
      <ul>
        {storageFailures.map((f) => (
          <li key={f.area}>
            {f.label[0].toUpperCase() + f.label.slice(1)}, failing since {fmtDur(now - f.since)} ago: {f.loss}. <span className="sub">({f.error})</span>
          </li>
        ))}
      </ul>
      Check the free disk space and the data directory&apos;s permissions; the dashboard&apos;s log has the details.
    </div>
  );
}
