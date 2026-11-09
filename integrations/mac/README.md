# Startsymbol für deinen Mac

Ein Klick auf **„LearnHarness (Hermes)“** im Dock:

1. holt den neuesten Stand von GitHub (`git pull`, im Hintergrund)
2. installiert neue Abhängigkeiten, nur wenn sie sich geändert haben
3. öffnet den Tunnel zu Hermes auf deinem Server (verbindet sich bei
   Netzabbrüchen neu)
4. startet LearnHarness

**Beenden mit Cmd+Q**: das schließt auch den Tunnel. Ein zweiter Klick,
während LearnHarness läuft, meldet nur „LearnHarness läuft schon“.

## Einmal einrichten

Im Terminal (einmalig; `root@<server-ip>` = dein SSH-Login zum Hermes-Server):

```bash
~/LearningHarness/integrations/mac/install-launcher.sh root@<server-ip>
```

Das Skript prüft die SSH-Verbindung (muss ohne Passwort gehen), merkt sich
Ordner, Server und den Pfad zu `node`/`npm`
(`~/.config/learnharness/launcher.env`) und legt das Symbol in
`~/Applications` an. Danach das Symbol ins Dock ziehen.

Läuft Hermes auf diesem Mac, das Argument weglassen.

## Gut zu wissen

- Läuft im Entwicklungsmodus (`npm run desktop:dev`): der erste Start nach
  einem Update dauert etwas länger. Daten liegen getrennt von der
  installierten Original-App (Profil `LearnHarness-dev`).
- Ohne Internet startet die vorhandene Version; ohne Server-Verbindung startet
  LearnHarness trotzdem (dann eben ohne Hermes-Modelle).
- Probleme? Log: `~/Library/Logs/LearnHarness-launcher.log`
- Code-Ordner nicht in Google Drive legen (tausende Dateien, Konflikte mit
  Git) – GitHub ist der Weg für Updates, Drive nur für deine Notizen.

## Fach-Unterlagen aus iCloud für Hermes

Hermes läuft auf dem Server und sieht iCloud nicht, aber Google Drive. Das
Startsymbol kopiert deshalb neue oder geänderte Dateien eines Fach-Ordners
aus iCloud nach `<Brain>/LearnHarness/Faecher/<Fach>/Originale/` (Google
Drive) — beim Start und alle 15 Minuten, solange LearnHarness offen ist.
Hermes macht daraus Text in `Folien/` bzw. `Klausuren/`, den die
Fach-Überprüfung liest. Es wird nie etwas gelöscht; ausgelagerte
iCloud-Dateien holt das Skript vorher auf den Mac.

Einmalig pro Fach (Pfad: Ordner im Finder auswählen, ⌥ + Rechtsklick →
„als Pfadname kopieren“):

```bash
~/LearningHarness/integrations/mac/subject-sync.sh add "IntSec" "/Pfad/zum/iCloud/IntSec"
```

Prüfen bzw. sofort kopieren:

```bash
~/LearningHarness/integrations/mac/subject-sync.sh list
```
```bash
~/LearningHarness/integrations/mac/subject-sync.sh once
```
