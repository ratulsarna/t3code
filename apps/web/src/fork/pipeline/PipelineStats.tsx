import {
  PIPELINE_COLUMN_LABELS,
  type EnvironmentId,
  type PipelineStatsRange,
  type ProjectId,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useState } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { pipelineStatsAtom } from "./api";

function duration(ms: number | null) {
  if (ms === null) return "–";
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function PipelineStatsPanel({
  hub,
  hostId,
  projectId,
}: {
  hub: EnvironmentId;
  hostId: EnvironmentId;
  projectId: ProjectId;
}) {
  const gt = useGT();
  const [range, setRange] = useState<PipelineStatsRange>("30");
  const stats = useEnvironmentQuery(pipelineStatsAtom(hub, hostId, projectId, range));
  const data = stats.data;
  return (
    <div className="max-w-4xl space-y-4">
      <label className="flex items-center gap-2 text-sm">
        <T>Time range</T>
        <select
          aria-label={gt("Stats time range")}
          className="rounded border bg-background px-2 py-1"
          value={range}
          onChange={(event) => setRange(event.target.value as PipelineStatsRange)}
        >
          <option value="7">
            <T>7 days</T>
          </option>
          <option value="30">
            <T>30 days</T>
          </option>
          <option value="90">
            <T>90 days</T>
          </option>
          <option value="all">
            <T>All time</T>
          </option>
        </select>
      </label>
      {stats.error && <p role="alert">{stats.error}</p>}
      {stats.isPending && !data && (
        <p>
          <T>Loading stats…</T>
        </p>
      )}
      {data && (
        <>
          <dl className="grid grid-cols-3 gap-2 rounded border p-3 text-sm">
            <div>
              <dt>
                <T>Finished</T>
              </dt>
              <dd className="text-xl">{data.finished}</dd>
            </div>
            <div>
              <dt>
                <T>In progress</T>
              </dt>
              <dd className="text-xl">{data.inProgress}</dd>
            </div>
            <div>
              <dt>
                <T>Median start to Done</T>
              </dt>
              <dd className="text-xl">{duration(data.startToDoneMs)}</dd>
            </div>
          </dl>
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th>
                  <T>Stage</T>
                </th>
                <th>
                  <T>Working</T>
                </th>
                <th>
                  <T>Waiting on you</T>
                </th>
                <th>
                  <T>External review</T>
                </th>
                <th>
                  <T>Paused</T>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.stages.map((stage) => (
                <tr className="border-b" key={stage.column}>
                  <th className="py-1 font-normal">{PIPELINE_COLUMN_LABELS[stage.column]}</th>
                  <td>{duration(stage.workingMs)}</td>
                  <td>{duration(stage.waitingMs)}</td>
                  <td>{duration(stage.reviewMs)}</td>
                  <td>{duration(stage.pausedMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h2 className="font-medium">
            <T>Review and QA rework</T>
          </h2>
          <p className="text-sm">
            {gt("Review {review} · QA {qa} · External {external}", data.bounces)}
          </p>
          <ul className="space-y-1 text-sm">
            {data.bounces.top.map((card) => (
              <li key={card.cardId}>
                {card.title} · {card.review + card.qa + card.external}
              </li>
            ))}
          </ul>
          {data.reasons.length > 0 && (
            <>
              <h2 className="font-medium">
                <T>Reasons work waited</T>
              </h2>
              <ul className="space-y-1 text-sm">
                {data.reasons.map((reason) => (
                  <li key={reason.reason}>
                    {reason.reason} · {reason.count} · {duration(reason.waitingMs)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}
