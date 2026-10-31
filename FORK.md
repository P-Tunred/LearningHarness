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
  - `learnharness-stats.json` (Version 3) fürs Dashboard: Summen, Lernzeit pro
    Tag, `topics` (zuletzt aktiv zuerst), Sessions und die gemessene Zeit des
    Lern-Timers (siehe 5). Version 3 ergänzt nur Felder; wer Version 2 liest,
    findet alles Alte unverändert.
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
- **Klausur-Aufträge (Claude → LearnHarness)**: Ein Klausurplan als
  Markdown in `LearnHarness/Auftraege/` im Brain. Vorne `klausur:` und
  `datum:` (JJJJ-MM-TT) als Frontmatter, dann je Schwerpunkt eine
  `## Überschrift` mit optional `Gewicht: hoch|mittel|niedrig` und freiem Text
  (Ziel, Quellen, Hinweise aus Altklausuren). Text vor dem ersten `##` gilt für
  alle Schwerpunkte. Beim App-Start wird jeder Schwerpunkt eine Session im
  Ordner „<Klausur> Klausur“; ihr Text ist der Start-Auftrag und wird beim
  ersten Öffnen abgeschickt (vorher läuft nichts, nichts kostet). Die Datei
  bleibt liegen: neue Schwerpunkte werden beim nächsten Start ergänzt,
  bestehende Sessions nie doppelt angelegt. Fortschritt (angefangen,
  Lernzeit, offene Fragen) steht im Lernstand unter „Klausuren“ und in
  `learnharness-stats.json` unter `exams`. Stand der Aufträge:
  `klausur-auftraege.json` im Datenordner.
- **Lernzeit** = gemessene Zeit des Lern-Timers (siehe 5). Wo er nicht lief,
  bleibt die Schätzung: Zeit zwischen deinen Aktionen in einer Session, Pausen
  über 10 Minuten zählen nicht. Pro Tag und Session gilt das Größere von
  beidem, nie die Summe.
- **Klausur-Fortschritt (unten in der Seitenleiste)**: Solange ein
  Klausur-Auftrag läuft, zeigt ein schmaler Block je Klausur (englisch):
  Balken = wie viel vom Plan erledigt ist (Fortschritt × Verstehen, nach
  Aufwand gewichtet), Strich = wo du bei gleichmäßigem Tempo heute früh
  stündest (gerade Linie vom Tag, an dem der Auftrag gelesen wurde, bis zur
  Wiederholung). Daneben der Abstand in Stunden (ahead / on track / behind),
  wie viel verstanden ist und heute gelernt / Tagesziel / noch offen. Ein
  Klick zeigt, was als Nächstes dran ist (führt in die Session), die Woche
  und wie das Tagesziel entsteht: Restaufwand im eigenen Tempo ÷ Lerntage
  bis zur Wiederholung, jeden Tag neu — dieselbe Rechnung wie der
  Klausur-Planer in Daily (`lernTempo`, siehe 5). Je Tag geht die Lernzeit
  als `minutesByDay` in den Export, Daily nimmt pro Tag das Größere aus
  seinem Timer und dem Harness.
- Code: `src/core/brain-export.ts` (Lernstand + Statistik, ohne
  Dateizugriff), `src/server/brain.ts` (Export, Eingang, Ablauf),
  `src/server/brain-folder.ts` (Ordner, Prompt-Abschnitt),
  `src/core/exam-plan.ts` + `src/server/exam-plans.ts` (Klausur-Aufträge),
  `src/core/exam-progress.ts` + `app/api/exam-progress/route.ts` +
  `components/exam-progress.tsx` (Klausur-Fortschritt),
  `app/api/brain/route.ts`, `components/settings/brain-section.tsx`. Tests:
  `tests/brain-export.test.ts`, `tests/brain-sync.test.ts`,
  `tests/exam-plan.test.ts`, `tests/exam-plans-sync.test.ts`,
  `tests/exam-progress.test.ts`.

### 4. Startsymbol für den Mac

`integrations/mac/install-launcher.sh root@<server>` legt einmalig das Symbol
„LearnHarness (Hermes)“ an. Ein Klick: Update von GitHub, Tunnel zu Hermes,
LearnHarness starten; Cmd+Q beendet alles. Anleitung:
[integrations/mac/README.md](integrations/mac/README.md).

### 5. Lern-Timer

Ein kleiner Timer unten rechts im Fenster (unter 1100 px Breite oben rechts
unter der Titelleiste, damit er nie über der Eingabe liegt): Fach des Chats,
heute darin gemessene Zeit (mm:ss, ab einer Stunde h:mm), ein Knopf
Start / Pause / Resume und **Save**. **Mod+Shift+T** (Cmd auf dem Mac) startet
und pausiert, siehe
[docs/keyboard.md](docs/keyboard.md). Ein Punkt zeigt den Zustand: grün = läuft,
gelb = Chat ohne Fach. Sonst keine Animation. Beschriftung englisch wie der
Rest der App („No subject“, „Still there?“).

- **Was er misst**: echte Lernzeit — nur solange du ihn gestartet hast. Er
  startet nie von selbst. Die Schätzung aus den Abständen zwischen
  Nachrichten bleibt nur der Ersatz, wo er nicht lief.
- **Wem er die Zeit gibt** (je Chat, in dieser Reihenfolge):
  1. von Hand gewähltes Fach (Klick auf das Fach → Liste der Fächer,
     „No subject“ oder „New subject…“; die Wahl bleibt für den Chat
     gespeichert);
  2. Chat gehört zu einem Klausur-Auftrag → Fach = Klausurname, und die Zeit
     zählt zusätzlich für diesen Schwerpunkt (`chatId`);
  3. Chat liegt in einem Ordner → Name des obersten Ordners;
  4. sonst „No subject“, bis du eines wählst.
  Wechselst du den Chat, während er läuft, endet das alte Stück und ein neues
  beginnt beim neuen Chat — keine Minute doppelt, keine beim falschen Fach. Er
  läuft über Chatwechsel weiter.
- **Pausen von selbst**: Das Fenster meldet sich alle 30 s. Bleibt das länger
  als 3 Minuten aus (Ruhezustand, App beendet, Absturz), endet das Stück beim
  letzten Lebenszeichen; nach dem Aufwachen bleibt er pausiert, ohne zu
  fragen. Nach 15 Minuten ohne Eingabe oder Scrollen im Fenster fragt er
  leise „Still there?“; ohne Antwort pausiert er nach weiteren 5 Minuten und
  bucht die Leerlaufzeit nicht (das Stück endet bei der letzten Eingabe).
- **Pause und Save** (Paul, 2026-10-31): Pause ist eine Unterbrechung. Save
  beendet die Lernsitzung: der Timer pausiert, und die noch nicht
  gespeicherte Zeit wird zu gespeicherten Sitzungen, je Tag und Fach eine,
  mit fester Kennung. Eine Zeile meldet, was gespeichert wurde. Zeit ohne
  Fach bleibt ungespeichert, bis der Chat ein Fach hat (die Zuordnung gilt
  dann auch für seine ungespeicherte Zeit). Ungespeicherte Zeit von einem
  früheren Tag speichert der Timer beim nächsten Öffnen selbst — ein
  vergessenes Save kostet nichts.
- **Bis Daily**: Die gespeicherten Sitzungen gehen mit dem Export ins Brain
  (`timer.sessions`), kommen mit der stündlichen Spiegelung auf die VM, und
  Daily übernimmt jede genau einmal als eigene Lernsitzung beim passenden
  Fach („FODS Theorie“ → FODS). Score, Lernzeit-Seite und Tagesbericht
  zählen sie dann mit; zu Dailys Timer muss niemand wechseln. Bis sie in
  Daily stehen, kann es bis zu einer Stunde dauern. Findet Daily kein
  passendes Fach, nennt es das Fach auf der Lernzeit-Seite.
- **Speicher**: `study-timer.json` im LearnHarness-Datenordner. Das laufende
  Stück wird bei jedem Lebenszeichen sofort geschrieben, übersteht also
  Absturz und Neustart. Nichts verlässt den Rechner außer den Tagessummen im
  Export.
- **Export** (`learnharness-stats.json`, Version 3, nur neue Felder):
  - `timer.byDay`: `{ "JJJJ-MM-TT": { "<Fach>": Minuten } }` für die letzten
    28 Tage;
  - je Klausur `timerMinutesByDay` (Schwerpunkt-Chats und alles, was aufs
    Klausur-Fach gebucht ist);
  - je Schwerpunkt `timerMinutes`;
  - `timer.sessions`: die gespeicherten Sitzungen der letzten 28 Tage
    (`id`, `subject`, `day`, `minutes`, `start`) — Daily bucht jede `id`
    einmal;
  - `minutesByDay` und `learningMinutes` nehmen pro Tag bzw. Session das
    Größere aus gemessen und geschätzt, nie die Summe.
- **Tempo**: Die Regeln aus Daily (`src/lib/lernTempo.ts`) stecken 1:1 in
  `src/core/exam-progress.ts` (`paceFactor`, `restMinutesFocus`): Wie lange
  du für erledigte Schwerpunkte wirklich gebraucht hast, gegen die
  geschätzten Stunden (Faktor 0,5–3, erst ab zwei Schwerpunkten mit ≥ 25 %
  und ≥ 30 min, sonst über alle Klausuren). Offene Fragen kosten 15 min
  (höchstens 2 h). Daraus kommen Rest-Stunden und Tagesziel — dieselbe Zahl
  in der Seitenleiste und in Daily. Gemessene Timer-Minuten fließen über
  `learningMinutes` ein.
- Code: `src/core/study-timer.ts` (Regeln, ohne Dateizugriff),
  `src/server/study-timer.ts` (Speicher, Fach-Zuordnung),
  `app/api/study-timer/route.ts`, `components/study-timer.tsx`, Taste in
  `src/core/keyboard.ts`, Export in `src/core/brain-export.ts`. Tests:
  `tests/study-timer.test.ts`, `tests/study-timer-sync.test.ts`, Export in
  `tests/brain-export.test.ts`, Tempo in `tests/exam-progress.test.ts`.

## Diese Version starten (zum Ausprobieren)

Voraussetzung: [Node.js](https://nodejs.org) (aktuelle Version) und Git.

```bash
git clone https://github.com/P-Tunred/LearningHarness.git
cd LearningHarness
git checkout claude/ecstatic-ptolemy-s0m7rq
npm install
npm run desktop:dev
```

Achtung: In diesem Modus ist `data/` im Repo der echte Datenordner (auch
beim Mac-Starter). `npm test` läuft deshalb immer mit einem eigenen
Temp-Ordner (`LH_DATA_DIR`), sonst legen mitgelieferte Tests dort Chats an.

Der Testmodus (`desktop:dev`) läuft **neben** der installierten App und hat
einen eigenen, getrennten Datenordner (`LearnHarness-dev`). Deine echten
Lernsessions und Keys werden dabei nicht angefasst. API-Key bzw. Provider
musst du im Testmodus einmal neu eintragen.
