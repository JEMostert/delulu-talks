import { RefreshCw } from "lucide-react";
import {
  serviceNames,
  type RecoveryService,
  type useServiceRecovery,
} from "../hooks/useServiceRecovery";
import { Alert } from "./ui";

export function ServiceRecovery({
  recovery,
}: {
  recovery: ReturnType<typeof useServiceRecovery>;
}) {
  const services = Object.keys(recovery.errors) as RecoveryService[];
  if (!services.length) return null;
  return (
    <>
      {services.map((service) => (
        <Alert
          key={service}
          action={
            <button
              className="secondary-button compact"
              disabled={recovery.retrying[service]}
              onClick={() => void recovery.retry(service)}
            >
              <RefreshCw className={recovery.retrying[service] ? "spin" : ""} />
              {recovery.retrying[service]
                ? "Retrying…"
                : `Retry ${serviceNames[service].toLowerCase()} status`}
            </button>
          }
        >
          <strong>{serviceNames[service]} status unavailable.</strong>{" "}
          {recovery.errors[service]}
        </Alert>
      ))}
    </>
  );
}
