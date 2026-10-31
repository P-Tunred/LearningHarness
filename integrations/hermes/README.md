# LearnHarness über Hermes laufen lassen

Die Proxys laufen dort, wo Hermes läuft (Mac oder Server), und nutzen den
Login bzw. Key, den du **in Hermes** eingerichtet hast. Hermes selbst wird dafür nicht
verändert; die Skripte nutzen nur Hermes' eigene Bausteine (Keys, Login,
Token-Erneuerung, Header).

| Abo | Startbefehl | URL für LearnHarness |
|---|---|---|
| **ChatGPT + Z.AI zusammen (empfohlen)** | `./integrations/hermes/start-hermes-proxy.sh` | `http://127.0.0.1:8646/v1` |
| nur Z.AI (GLM) | `./integrations/hermes/start-zai-proxy.sh` | `http://127.0.0.1:8645/v1` |
| nur ChatGPT / OpenAI | `./integrations/hermes/start-codex-proxy.sh` | `http://127.0.0.1:8646/v1` |

Der gemeinsame Proxy (`hermes_proxy.py`) bietet die Modelle beider Abos unter
einer URL an und leitet jede Anfrage nach Modell weiter: GPT-Modelle über den
ChatGPT-Login, GLM-Modelle über den Z.AI-Key. So kannst du in LearnHarness pro
Slot mischen, z. B. **Strong = GPT** (Lehrer) und **Cheap = GLM**
(Hintergrundarbeit wie das Einlesen von Notizen). Ist ein Abo in Hermes nicht
eingerichtet, fehlen nur dessen Modelle in der Liste.

Die Modellliste enthält Hermes' Werte für **Kontextgröße**, **maximale
Antwortlänge** und **Bild-Eingabe** (soweit Hermes sie kennt). Ohne diese
Angaben nimmt LearnHarness Notwerte (8.192 Kontext, 4.096 Antwort), was
Sessions stark bremst und GLM-Antworten abschneidet. Nach einem Proxy-Update
in LearnHarness einmal **Connect** drücken, damit die Werte neu geladen werden.
Fehlt ein Wert, kann man ihn im Custom-Endpoint-Editor pro Modell selbst setzen.

Welche GPT-Modelle erscheinen, entscheidet OpenAI live je nach Abo (Hermes
fragt das Codex-Backend nach den Modellen deines Kontos).

## Hermes auf einem Server

Läuft Hermes auf einem Server, läuft der Proxy dort (neben Hermes' Login) und
dein Mac verbindet sich per SSH-Tunnel, die URL in LearnHarness bleibt gleich:

```bash
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8646:127.0.0.1:8646 root@<server>
```

Den Hermes-Login nie auf den Mac kopieren: der ChatGPT-Login erneuert sich
laufend, zwei Kopien machen sich gegenseitig ungültig.

## Einrichten

1. In Hermes eingerichtet sein muss:
   - Z.AI: ein Key (`GLM_API_KEY` bzw. `ZAI_API_KEY` in `~/.hermes/.env`, z. B. über `hermes setup`)
   - ChatGPT: der Codex-Login (`hermes auth add openai-codex` bzw. `hermes setup`)
2. Startbefehl aus der Tabelle ausführen (Terminal offen lassen). Beide
   gleichzeitig geht auch (verschiedene Ports).
3. In LearnHarness: **Settings → Providers → + Add a provider → Custom
   endpoint** → URL aus der Tabelle, **Keyless**, **Connect**, dann Modelle
   für Strong / Cheap / Vision wählen.

LearnHarness kennt nur **einen** Custom Endpoint. Für beide Abos gleichzeitig
deshalb den gemeinsamen Proxy nehmen.

Findet ein Skript Hermes nicht, den Python-Pfad deiner Hermes-Installation angeben:
`HERMES_PYTHON=/pfad/zu/hermes/venv/bin/python ./integrations/hermes/start-codex-proxy.sh`

## Wie es funktioniert

```
Z.AI:     LearnHarness → zai_proxy.py   → Z.AI          (unverändert durchgereicht, Hermes' Key)
ChatGPT:  LearnHarness → codex_proxy.py → chatgpt.com   (übersetzt, Hermes' Codex-Login)
```

- **Z.AI** spricht dasselbe Format wie LearnHarness; der Proxy hängt nur den
  Key an (Hermes' eingebauter Proxy-Server).
- **ChatGPT** läuft in Hermes über das Codex-Backend
  (`chatgpt.com/backend-api/codex`, „Responses“-Format). `codex_proxy.py`
  übersetzt Nachrichten, Bilder, Lern-Tools und Tool-Ergebnisse hin und zurück
  (auch Streaming), nutzt Hermes' Login inkl. Token-Erneuerung und Konto-Header
  und kürzt Hermes' `-900k`-Modellnamen wie Hermes selbst.

## Getestet

Beide Wege mit einer echten LearnHarness-Session gegen Test-Server (kein echter
Z.AI-/ChatGPT-Zugang in der Entwicklungsumgebung): die Lern-Tools kommen beim
Modell an, Tool-Aufrufe und -Ergebnisse laufen hin und zurück, die Antwort
landet in der Session. Gemeinsamer Proxy: Strong = GPT (Lehrer-Session über ChatGPT) und Cheap = GLM
(Notiz-Extraktion über Z.AI) in derselben App getestet. Tests für Übersetzer
und Weiterleitung: `./run-with-hermes.sh test_codex_proxy.py`.

## Grenzen

- **ChatGPT-Weg ist inoffiziell:** Das Codex-Backend ist OpenAIs Zugang für
  Codex-Programme, keine öffentliche API. Ändert OpenAI es, kann der Proxy
  brechen, bis er angepasst ist. Der offizielle Weg ohne Hermes ist die
  eingebaute ChatGPT-Anmeldung in LearnHarness (Settings → Providers).
- Nicht der Hermes-API-Server (`/v1/chat/completions` auf dem Gateway): der
  führt Hermes' eigenen Agenten aus und gibt LearnHarness' Tools nicht weiter.
- Die Proxys protokollieren nichts; diese Anfragen erscheinen nicht im
  Hermes-Dashboard. Sie lauschen nur auf 127.0.0.1 und lehnen Browser-Anfragen ab.
- LearnHarness zeigt für den Custom Endpoint keine Kosten an (Abo-Nutzung).
