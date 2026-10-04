import type { RuntimeLifecycle } from "../../types";

const RESIDENCY = {
  unknown: "Not reported",
  unloaded: "Unloaded",
  loading: "Loading weights",
  resident: "Resident",
  unloading: "Unloading",
};
const WARMUP = {
  unknown: "Not reported",
  "not-started": "Not exercised",
  warming: "Exercising inference",
  complete: "Inference exercised",
};

export function ModelLifecycle({ status }: { status: RuntimeLifecycle }) {
  const deadline =
    typeof status.idleUnloadAt === "number" &&
    Number.isFinite(status.idleUnloadAt)
      ? new Date(status.idleUnloadAt)
      : null;
  const idleCheck =
    deadline && !Number.isNaN(deadline.getTime())
      ? deadline.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "None scheduled";
  const rows = [
    ["Memory", RESIDENCY[status.residency ?? "unknown"]],
    [
      "Device",
      status.device === "cuda"
        ? "CUDA"
        : status.device === "mlx"
          ? "MLX"
          : status.device || "None reported",
    ],
    ["Warmup", WARMUP[status.warmup ?? "unknown"]],
    ["Auto-unload", idleCheck],
  ];
  return (
    <dl className="model-stats" aria-label="Model runtime lifecycle">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
