import type { SetupSpaceSnapshot } from "../types";

function gb(bytes: number): string {
  return `${(bytes / 1e9).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
}

export function SetupSpace({ space }: { space: SetupSpaceSnapshot }) {
  const modelDisk = space.disk.find((disk) => disk.label === "Model cache");
  const sharesFilesystem = new Set(space.disk.map((disk) => disk.filesystem).filter((value) => value !== null)).size < space.disk.filter((disk) => disk.status === "observed").length;
  return (
    <div className="mt-4 rounded-panel border border-line p-4 [overflow-wrap:anywhere]">
      <h4>Download, installed and repair space</h4>
      <p className="mt-2 text-xs text-muted">Planning estimates, not measured downloads or installed sizes. Available capacity was observed {new Date(space.checkedAt).toLocaleString()}.</p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Selected model and runtime disk estimates</caption>
          <thead><tr><th className="p-2">Selected component</th><th className="p-2">Download estimate</th><th className="p-2">Installed estimate</th><th className="p-2">Additional staging during repair</th></tr></thead>
          <tbody>
            {space.plans.map((plan) => (
              <tr key={plan.kind}>
                <th scope="row" className="p-2">{plan.kind === "speech" ? "Speech" : "Optional rewriting"}: {plan.modelName} cache</th>
                <td className="p-2">~{gb(plan.modelDownloadBytes)}{plan.kind === "magic" && " weights only"}</td>
                <td className="p-2">~{gb(plan.modelInstalledBytes)}{plan.kind === "magic" && " weights only"}</td>
                <td className="p-2">~{gb(plan.modelTemporaryBytes)} extra copy</td>
              </tr>
            ))}
            <tr><th scope="row" className="p-2">Each isolated runtime</th><td className="p-2">Unknown</td><td className="p-2">Unknown</td><td className="p-2">One additional complete runtime; size unknown</td></tr>
          </tbody>
        </table>
      </div>
      {space.plans.map((plan) => (
        <p className="mt-2 text-xs text-muted" key={plan.kind}><strong>{plan.modelName} basis:</strong> {plan.basis}</p>
      ))}
      <details className="mt-3">
        <summary>Runtime and repair estimate limits</summary>
        <p className="mt-2 text-xs">Download: {space.runtimeDownload}</p>
        <p className="mt-2 text-xs">Installed: {space.runtimeInstalled}</p>
        <p className="mt-2 text-xs">Temporary repair space: {space.runtimeTemporary}</p>
      </details>
      <h5 className="mt-4">Currently available disk capacity</h5>
      <dl className="mt-2 grid grid-cols-[minmax(120px,200px)_1fr] gap-3 text-sm max-[700px]:grid-cols-1">
        {space.disk.map((disk) => (
          <div key={disk.label} className="contents">
            <dt>{disk.label}</dt>
            <dd>{disk.availableBytes === null ? "Unknown" : gb(disk.availableBytes)} available
              <span className="block text-xs text-muted">Destination: {disk.requestedPath}</span>
              {disk.queriedPath !== disk.requestedPath && disk.queriedPath && <span className="block text-xs text-muted">Queried ancestor: {disk.queriedPath}</span>}
              <span className="block text-xs text-muted">{disk.detail}</span>
            </dd>
          </div>
        ))}
      </dl>
      {sharesFilesystem && <p className="mt-3 text-xs text-muted">Some destinations share a filesystem. Their available capacity is the same pool; do not add it together.</p>}
      <p className="mt-3 text-xs text-muted">System temp and pip cache paths are expected defaults/environment selections; Python or pip configuration may redirect them.</p>
      {space.plans.filter((plan) => modelDisk?.availableBytes != null && modelDisk.availableBytes < plan.modelInstalledBytes + plan.modelTemporaryBytes).map((plan) => (
        <p className="field-error" role="status" key={plan.kind}>Model-cache capacity is below the partial {plan.modelName} cache plus staging estimate (~{gb(plan.modelInstalledBytes + plan.modelTemporaryBytes)}). Runtime and other overhead are additional and unknown.</p>
      ))}
      <p className="mt-3 text-xs text-muted">{space.caveat}</p>
    </div>
  );
}
