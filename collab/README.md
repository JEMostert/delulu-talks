# Samenwerking tussen agents

Gedeelde werkruimte voor named agents die GitHub-issues oplossen en PR's reviewen en mergen. De gecombineerde prompt staat in `prompts/adaptive-agent.md`: dezelfde agent kan op verzoek wisselen tussen implementatie, review en merge. De afzonderlijke rolprompts blijven beschikbaar in `prompts/issue-worker.md` en `prompts/pr-reviewer.md`. Runtimebestanden blijven lokaal en horen niet in product-PR's.

Repository: `JEMostert/delulu-talks`. Default branch: `master`. [Roadmap en taakissues](https://github.com/JEMostert/delulu-talks/issues/14).

## Identiteit en gedeelde locatie

Kies een unieke, stabiele naam, bijvoorbeeld `builder-nova` of `reviewer-orion`. Reserveer je profielnaam door het profiel exclusief aan te maken; kies bij een bestaande naam een andere naam. Gebruik die naam in je profiel, claims, berichten, handoffs en GitHub-comments. Een agentnaam is geen GitHub-account en bewijst geen afzonderlijke reviewbevoegdheid.

Alle agents gebruiken **dezelfde absolute map**. Voor deze workspace:

```sh
export DELULU_COLLAB_DIR=/home/boran/Projects/apps/delulu-talks/collab
```

Bij een aparte clone op een andere machine spreken de agents eerst een werkelijk gedeelde locatie af. Een eigen kopie van `collab` vormt geen gedeeld kanaal. Gebruik in een worktree het bovenstaande centrale pad, niet een nieuwe lokale runtime-map.

## Lokale bestanden

| Pad                                             | Gebruik                                                                                        |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `agents/<naam>.json`                            | Eigen profiel: naam, rol, status, UTC-heartbeat, issue/PR, branch en worktreepad.              |
| `claims/issue-<nummer>/owner.json`              | Exclusieve issueclaim met agentnaam, UTC-starttijd, status en worktree.                        |
| `claims/pr-<nummer>/owner.json`                 | Exclusieve claim voor review/merge; aanvullend op de issueclaim.                               |
| `claims/baseline-local-refactor/owner.json`     | Exclusieve claim voor de afzonderlijke PR van de bestaande lokale basiswijzigingen.            |
| `messages/<UTC-tijd>-<naam>-<unieke-id>.md`     | Nieuw bericht met afzender, ontvanger, onderwerp, issue/PR en concrete vraag of beslissing.    |
| `handoffs/issue-<nummer>-<naam>-<unieke-id>.md` | Overdracht met PR-URL, commit-SHA, wijzigingen, verificatie, beperkingen en resterende vragen. |

Schrijf alleen je eigen profiel en claims. Werk bestanden bij via een tijdelijk bestand gevolgd door een rename. Maak berichten en handoffs als nieuwe bestanden met een unieke naam; overschrijf geen gedeelde chatlog. Noteer tijden in UTC, bijvoorbeeld `2026-09-29T21:00:00Z`.

Een profiel gebruikt bijvoorbeeld deze velden:

```json
{
  "name": "builder-nova",
  "role": "issue-worker",
  "status": "working",
  "heartbeat_utc": "2026-09-29T21:00:00Z",
  "issue": 27,
  "pr": null,
  "branch": "agent/builder-nova/issue-27",
  "worktree": "/absolute/path/to/worktree"
}
```

## Claims, berichten en overdracht

1. Lees profielen, claims, nieuwe berichten en het issue voordat je werk kiest. Controleer afhankelijkheden en bestaande PR's. Het overzichtsissue #14 is geen implementatietaak.
2. Claim atomair door `mkdir "$DELULU_COLLAB_DIR/claims/issue-<nummer>"` uit te voeren. Bij een bestaande directory kies je ander werk of stuur je de eigenaar een bericht. Schrijf na succesvolle creatie onmiddellijk `owner.json`.
3. Gebruik voor review dezelfde procedure met `pr-<nummer>`. Een reviewer claimt de PR, niet opnieuw het issue van de bouwer.
4. Houd je profiel en eigen claim actueel bij elke statuswisseling en minstens elke tien minuten tijdens actief werk. Lees berichten voor edits, pushes en merges en na een langdurige toolcall. Vermeld bestandsgebieden die je gaat wijzigen; coördineer overlappende wijzigingen.
5. Een oude heartbeat is reden om contact te zoeken, geen toestemming om een claim te verwijderen. Overname vereist bevestiging van de eigenaar of coordinator, met een vastgelegd bericht.
6. De bouwer schrijft een handoff en zet zijn status op `awaiting-review`. De issueclaim blijft actief om dubbel werk te voorkomen. Na feedback werkt de bouwer dezelfde PR bij en meldt de nieuwe SHA.
7. De reviewer koppelt bevindingen aan de onderzochte SHA, controleert iedere nieuwe versie en meldt de uiteindelijke merge-SHA. De bouwer sluit zijn lokale claim na die bevestiging; de reviewer ruimt alleen zijn eigen PR-claim op. Archiveer je claiminformatie eerst in een bericht of handoff.
8. Een agent mag van rol wisselen met behoud van dezelfde naam. Leg eerst voortgang, claimstatus en de vervolgstap vast en wijzig je profielrol. Review van je eigen implementatie blijft self-review; een rolwissel creëert geen onafhankelijke revieweridentiteit.

Gebruik lokale berichten voor onderlinge afstemming. Zet relevante technische bevindingen en besluiten ook bij het GitHub-issue of de PR, met je agentnaam. Publiceer geen gesprekken, credentials of persoonlijke transcriptinhoud in GitHub-comments.

## Branches en huidige basis

Werk per issue of samenhangende taak in een eigen branch/worktree. Bewerk niet dezelfde checkout als een andere agent. Fetch upstream en controleer Git-status voordat je begint; gebruik geen reset, stash, force-push of cleanup om andermans wijzigingen weg te werken.

**Er staan momenteel aanzienlijke ongecommitteerde wijzigingen in de centrale checkout.** Die bevatten onder andere R2T2 MLX/Windows CUDA, rewriting-integratie en de nieuwe branding. De twaalf gesloten roadmapitems beschrijven lokale implementatie. Dit betekent niet dat die code al op `origin/master` staat. Lees de overdracht van `codex-coordinator` in `handoffs`.

De eerste implementatieagent mag `baseline-local-refactor` atomair claimen en de bestaande bedoelde wijzigingen als afzonderlijke basis-PR overdragen aan de reviewer. Controleer de diff en leg de exacte overgenomen bestanden vast. Maak een eigen branch/worktree met een snapshot, behoud de centrale working tree en sluit runtimebestanden uit. Voeg geen nieuw issuewerk aan die PR toe. Pak afhankelijke taken na integratie van deze basis; andere, onafhankelijke taken kunnen vanuit een schone worktree doorlopen. Dit is toestemming voor de overdracht zodra de implementatieprompt wordt gegeven, geen opdracht om tijdens het aanmaken van deze collab-map al te pushen.

## Projectafspraken en verificatie

- R2T2 blijft het enige speechmodel. Apple Silicon gebruikt MLX; Windows/Linux gebruiken CUDA. Optionele Qwen 3.5 rewriting blijft apart.
- Het project blijft een ambitieus persoonlijk technisch hulpmiddel. Klantonboarding en publieke supportprocessen vallen buiten scope.
- Bewaar originele transcripties, instellingen en werkende runtimes. Wijzig geen dagelijks gebruikte modelomgevingen of persoonlijke geschiedenis voor een test.
- Kies controles op basis van de wijziging. Beschikbaar: `bun test`, `bun run typecheck`, `bun run format:check`, `bun run build`, `bun run test:e2e`, `bun run test:desktop` en `python3 -m unittest discover -s electron/python -p '*_test.py'`.
- Documenteer welke controles mocks, browserpreview, echte Electron-integratie of native inferentie gebruiken. Een Mac/Windows-inferentieclaim vereist bewijs op die hardware. Start geen download of GPU-inferentie als bijwerking van een gewone unittest.

## Review en merge

Review de volledige diff, het issue, afhankelijkheden en het uiteindelijke gedrag. Koppel resultaten aan de exacte PR-head-SHA. Na een nieuwe push of een relevante wijziging van de basis vervallen eerdere bevindingen totdat de gewijzigde situatie opnieuw is bekeken. Merge pas bij groene vereiste checks, opgeloste inhoudelijke blockers en een passende verificatie van de integratie met de huidige basis. Gebruik de repositoryregels en een SHA-gebonden merge, bijvoorbeeld `gh pr merge <nummer> --match-head-commit <gecontroleerde-SHA>` met de passende merge-methode; schakel branch protection niet uit.

Wanneer bouwer en reviewer hetzelfde GitHub-account gebruiken, kan dat account zijn eigen PR niet formeel approven. Publiceer dan de onafhankelijke agentreview als een benoemde comment. Als de repository een approval van een ander account vereist, blijft dat een echte blocker; omzeil die eis niet.

Er is toestemming voor issuewerk, PR's en het mergen van gereviewde PR's wanneer de betreffende prompt wordt gegeven. Releases, publicatie van packages en deployments vallen daar niet automatisch onder.
