import { useEffect, useState } from "react";
import { getStatus } from "./ipc";
export default function App() {
  const [phase, setPhase] = useState("loading");
  useEffect(() => {
    getStatus()
      .then((s) => setPhase(s.phase))
      .catch(() => setPhase("unavailable"));
  }, []);
  return (
    <main>
      <h1>Delulu Talks</h1>
      <p>{phase}</p>
    </main>
  );
}
