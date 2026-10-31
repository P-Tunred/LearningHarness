# LearnHarness über Hermes laufen lassen

Zwei Wege, je nach Abo. Beide laufen auf deinem Mac und nutzen den Login bzw.
Key, den du **in Hermes** eingerichtet hast. Hermes selbst wird dafür nicht
verändert; die Skripte nutzen nur Hermes' eigene Bausteine (Keys, Login,
Token-Erneuerung, Header).

| Abo | Startbefehl | URL für LearnHarness |
|---|---|---|
| **Z.AI (GLM)** | `./integrations/hermes/start-zai-proxy.sh` | `http://127.0.0.1:8645/v1` |
| **ChatGPT / OpenAI** | `./integrations/hermes/start-codex-proxy.sh` | `http://127.0.0.1:8646/v1` |

## Einrichten

1. In Hermes eingerichtet sein muss:
   - Z.AI: ein Key (`GLM_API_KEY` bzw. `ZAI_API_KEY` in `~/.hermes/.env`, z. B. über `hermes setup`)
   - ChatGPT: der Codex-Login (`hermes auth add openai-codex` bzw. `hermes setup`)
2. Startbefehl aus der Tabelle ausführen (Terminal offen lassen). Beide
   gleichzeitig geht auch (verschiedene Ports).
3. In LearnHarness: **Settings → Providers → + Add a provider → Custom
   endpoint** → URL aus der Tabelle, **Keyless**, **Connect**, dann Modelle
   für Strong / Cheap / Vision wählen.

LearnHarness kennt nur **einen** Custom Endpoint. Zum Wechseln zwischen Z.AI
und ChatGPT die URL im Custom-Endpoint-Editor ändern.

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
landet in der Session. Übersetzer-Tests: `./run-with-hermes.sh test_codex_proxy.py`.

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
