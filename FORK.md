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
- Anleitung: [integrations/hermes/README.md](integrations/hermes/README.md).

### 3. Second Brain + Morning Dashboard

**Settings → Second Brain → Brain-Ordner**: Pfad zu deinem Ordner mit
Markdown-Notizen (z. B. Google Drive für Desktop:
`~/Library/CloudStorage/GoogleDrive-…/Meine Ablage/<Brain>`). Leer = aus.

- **Export (LearnHarness → Brain)**, automatisch beim App-Start und nach jeder
  Session/Graph-Änderung, in den Unterordner `LearnHarness/`:
  - `Sessions/<Datum> <Titel>.md`: Datum, Lernzeit, gelernte Aussagen,
    Begründungsketten, „Unsicher oder offen“ (Weiß nicht / falsch / unsicher),
    deine Fragen, Übungsergebnisse
  - `Aussagen/<Name>.md`: Aussage, andere Formulierungen, „Begründet durch“,
    „Führt zu“, Vorkommen (Sessions bzw. deine Original-Notiz)
  - Links sind `[[LearnHarness/Aussagen/…|Name]]`, also mit vollem Pfad. So
    landen sie nie bei einer gleichnamigen eigenen Notiz.
  - Überschrieben werden nur Dateien, die LearnHarness selbst geschrieben hat
    (Liste in `LearnHarness/.learnharness-export.json`). Gelöscht wird eine
    alte eigene Datei nur, wenn du sie nicht bearbeitet hast.
- **Auto-Import (Brain → LearnHarness)** beim App-Start: alle `.md`-Notizen
  außer `LearnHarness/` und versteckten Ordnern (`.obsidian`, `.trash`, …).
  Beim ersten Mal alle, danach nur neue/geänderte. Gleiche Extraktion wie
  der Import-Knopf (kostet KI-Anfragen). Fehlen Modelle/Keys, stoppt der
  Import mit einer Meldung, statt weiterzulaufen. Der Stand liegt in
  `brain-sync.json` im LearnHarness-Datenordner, nicht im Brain.
- **Morning Dashboard**: `LearnHarness/learnharness-stats.json` mit
  Lernzeit pro Tag, Sessions (Titel, Art, Lernzeit, Fragen/richtig,
  Übungsergebnisse, Link zur Notiz) und Summen. **Lernzeit** = Zeit zwischen
  deinen Aktionen in einer Session; Pausen über 10 Minuten zählen nicht.
- Code: `src/core/brain-export.ts` (Notizen + Statistik, ohne Dateizugriff),
  `src/server/brain.ts` (Dateien, Import, Ablauf), `app/api/brain/route.ts`,
  `components/settings/brain-section.tsx`. Tests: `tests/brain-export.test.ts`,
  `tests/brain-sync.test.ts`.

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
