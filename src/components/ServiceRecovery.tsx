import { RefreshCw } from "lucide-react";
import { serviceNames, type RecoveryService, type useServiceRecovery } from "../hooks/useServiceRecovery";
import { Alert } from "./ui";

export function ServiceRecovery({ recovery }: { recovery: ReturnType<typeof useServiceRecovery> }) {
  const services = Object.keys(recovery.errors) as RecoveryService[];
  if (!services.length) return null;
  return <div className="px-6 pt-3 max-[900px]:px-4 space-y-2">
    {services.map((service) => <Alert key={service} action={
      <button className="secondary-button" disabled={recovery.retrying[service]} onClick={() => void recovery.retry(service)}>
        <RefreshCw className={recovery.retrying[service] ? "spin" : ""} />
        {recovery.retrying[service] ? "Retrying…" : `Retry ${serviceNames[service].toLowerCase()} status`}
      </button>
    }><strong>{serviceNames[service]} status unavailable.</strong> {recovery.errors[service]}</Alert>)}
  </div>;
}
