# Diese Version (Fork von LearnHarness)

Das hier ist eine angepasste Version von
[amosblomqvist/learnharness](https://github.com/amosblomqvist/learnharness)
(AGPL-3.0). Der Originalcode ist unverändert übernommen; die Änderungen
stehen unten. Updates vom Original lassen sich jederzeit nachziehen
(`git fetch upstream && git merge upstream/main`).

## Änderungen

### 1. Durchsichtiges Fenster (Fenster-Transparenz)

- **Settings → Appearance → Window opacity**: 100 = undurchsichtig (wie
  vorher), kleinere Zahl = durchsichtiger (Minimum 30).
- macOS: Milchglas-Effekt (Vibrancy). Windows 11: Acrylic. Linux: bleibt
  undurchsichtig.
- Nur der Grundhintergrund wird durchsichtig. Karten, Menüs, Dialoge und
  Text bleiben deckend, damit alles lesbar bleibt.
- Code: `electron/main.cjs` (`windowMaterial`),
  `components/settings/appearance.tsx` (`withOpacity`, `appearanceVars`),
  Einstellung in `src/core/settings.ts`, Tests in
  `tests/window-opacity.test.ts`.

### 2. Anfragen über Hermes (Z.AI und ChatGPT)

- `integrations/hermes/`: Startskripte für Hermes-Proxys.
  - Z.AI: LearnHarness → Hermes → Z.AI, mit dem Z.AI-Key aus Hermes.
  - ChatGPT-Abo: LearnHarness → Hermes → ChatGPT (Codex-Backend), mit Hermes'
    Codex-Login; der Proxy übersetzt zwischen den Formaten.
  - Beide zusammen (empfohlen): `start-hermes-proxy.sh`, ein Endpoint, Weiterleitung
    nach Modell, mit Hermes' Kontext-/Antwortlängen für LearnHarness.
- Anleitung: [integrations/hermes/README.md](integrations/hermes/README.md).

### 3. Second Brain + Morning Dashboard

**Settings → Second Brain → Brain-Ordner**: Pfad zu deinem Ordner mit
Markdown-Notizen (z. B. Google Drive für Desktop:
`~/Library/CloudStorage/GoogleDrive-…/My Drive/KI/Second Brain`). Leer = aus.

Grundsatz (Paul, 2026-10-31): Der Wissensgraph enthält, was du **lernst** —
nicht dein ganzes Brain. Und das Brain bekommt nur einen **groben** Lernstand,
nicht jede Aussage.

- **Lernstand (LearnHarness → Brain)**, automatisch beim App-Start und nach
  jeder Session/Graph-Änderung, nach `wiki/learnharness/` (Brain ohne `wiki/`:
  `LearnHarness/`). Unter `wiki/` sehen es auch die VM-Spiegelung, Hermes und
  das Morning Dashboard.
  - `lernstand.md`: Themen der letzten 14 Tage (Thema, Rahmen = Ordner in
    LearnHarness, Lernzeit, zuletzt, Anzahl offener Fragen), darunter früher
    Gelerntes. Keine Fragen- oder Aussagentexte.
  - `learnharness-stats.json` (Version 2) fürs Dashboard: Summen, Lernzeit pro
    Tag, `topics` (zuletzt aktiv zuerst) und Sessions.
  - Überschrieben werden nur Dateien, die LearnHarness selbst geschrieben hat
    (Liste in `.learnharness-export.json` daneben). Gelöscht wird eine alte
    eigene Datei nur, wenn du sie nicht bearbeitet hast.
- **Nachschlagen (Brain → LearnHarness)**: Prober und Lehrer bekommen am Ende
  des System-Prompts einen kurzen Abschnitt, wo das Brain liegt
  (`index.md`, `start.md`, `themen/`, `konzepte/`). Sie lesen dort bei Bedarf
  mit ihren nur lesenden Datei-Werkzeugen (`grep`, `read`). Nichts wird
  kopiert oder in den Graphen übernommen.
- **Eingang (Paul, Hermes, Claude → LearnHarness)**: Dokumente (`.md`, `.txt`,
  `.pdf`) in `LearnHarness/Eingang/` im Brain gehen beim App-Start durch
  denselben Import wie der Import-Knopf (kostet KI-Anfragen) und wandern danach
  nach `Eingang/importiert/`. Fehlen Modelle/Keys, stoppt der Import mit einer
  Meldung und versucht es beim nächsten Start erneut. Der Stand liegt in
  `brain-sync.json` im LearnHarness-Datenordner, nicht im Brain.
- **Lernzeit** = Zeit zwischen deinen Aktionen in einer Session; Pausen über
  10 Minuten zählen nicht.
- Code: `src/core/brain-export.ts` (Lernstand + Statistik, ohne
  Dateizugriff), `src/server/brain.ts` (Export, Eingang, Ablauf),
  `src/server/brain-folder.ts` (Ordner, Prompt-Abschnitt),
  `app/api/brain/route.ts`, `components/settings/brain-section.tsx`. Tests:
  `tests/brain-export.test.ts`, `tests/brain-sync.test.ts`.

### 4. Startsymbol für den Mac

`integrations/mac/install-launcher.sh root@<server>` legt einmalig das Symbol
„LearnHarness (Hermes)“ an. Ein Klick: Update von GitHub, Tunnel zu Hermes,
LearnHarness starten; Cmd+Q beendet alles. Anleitung:
[integrations/mac/README.md](integrations/mac/README.md).

## Diese Version starten (zum Ausprobieren)

Voraussetzung: [Node.js](https://nodejs.org) (aktuelle Version) und Git.

```bash
git clone https://github.com/P-Tunred/LearningHarness.git
cd LearningHarness
git checkout claude/ecstatic-ptolemy-s0m7rq
npm install
npm run desktop:dev
```

Der Testmodus (`desktop:dev`) läuft **neben** der installierten App und hat
einen eigenen, getrennten Datenordner (`LearnHarness-dev`). Deine echten
Lernsessions und Keys werden dabei nicht angefasst. API-Key bzw. Provider
musst du im Testmodus einmal neu eintragen.
