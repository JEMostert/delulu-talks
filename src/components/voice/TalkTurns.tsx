import { toolLabel, type TalkTurn } from "../../talk";

/** The last few turns: your words, what Delulu did, and what it said. */
export function TalkTurns({ turns }: { turns: TalkTurn[] }) {
  const recent = turns.slice(-3);
  if (!recent.length) return null;
  return (
    <ol className="pref-list talk-turns" aria-label="Recent turns">
      {recent.map((turn) => {
        const did = toolLabel(turn.tool);
        return (
          <li key={turn.id}>
            <p className="talk-user">{turn.user}</p>
            {(did || turn.said) && (
              <p className="talk-reply">
                {did && <span className="badge neutral">{did}</span>}
                {turn.said && <span>{turn.said}</span>}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
