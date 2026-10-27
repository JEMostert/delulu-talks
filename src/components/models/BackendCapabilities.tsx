import type { BackendCapabilities as Capabilities } from "../../types";

export function BackendCapabilities({
  capabilities,
}: {
  capabilities?: Capabilities | null;
}) {
  if (!capabilities)
    return (
      <p className="mt-3 text-xs text-muted">Capabilities not reported yet.</p>
    );
  const rows = [
    ["Timestamps", capabilities.timestamps ? "Supported" : "Unsupported"],
    [
      "Language hints",
      capabilities.languageHints.supported
        ? `${capabilities.languageHints.languages.length} accepted languages`
        : "Unsupported",
    ],
    [
      "Vocabulary biasing",
      capabilities.vocabularyBiasing ? "Supported" : "Unsupported",
    ],
  ];
  return (
    <section
      className="mt-4 text-xs"
      aria-label="Negotiated backend capabilities"
    >
      <p className="text-muted">Adapter: {capabilities.backend}</p>
      <dl className="mt-2 grid grid-cols-2 gap-x-5 gap-y-3 min-[700px]:grid-cols-4">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt className="text-muted">{label}</dt>
            <dd className="mt-1 font-medium">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
