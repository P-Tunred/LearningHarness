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

### 2. Anfragen über Hermes (Z.AI)

- `integrations/hermes/`: Startskript für einen Hermes-Proxy mit Z.AI.
  LearnHarness → Hermes → Z.AI, mit dem Z.AI-Key aus Hermes.
- Anleitung: [integrations/hermes/README.md](integrations/hermes/README.md).

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
