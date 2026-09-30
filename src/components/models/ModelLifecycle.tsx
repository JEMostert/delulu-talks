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
    ["Model residency", RESIDENCY[status.residency ?? "unknown"]],
    [
      "Device reported",
      status.device === "cuda"
        ? "CUDA"
        : status.device === "mlx"
          ? "MLX"
          : status.device || "None reported",
    ],
    ["Warmup", WARMUP[status.warmup ?? "unknown"]],
    ["Idle check", idleCheck],
  ];
  return (
    <dl
      className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 text-xs min-[700px]:grid-cols-4"
      aria-label="Model runtime lifecycle"
    >
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt className="text-muted">{label}</dt>
          <dd className="mt-1 font-medium [overflow-wrap:anywhere]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
