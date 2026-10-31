# LearnHarness über Hermes laufen lassen (Z.AI)

```
LearnHarness  →  Hermes-Proxy (dein Mac, 127.0.0.1:8645)  →  Z.AI (GLM)
```

LearnHarness schickt seine KI-Anfragen an Hermes. Hermes hängt deinen
Z.AI-Key an (den, den du in Hermes eingerichtet hast) und leitet die Anfrage
unverändert weiter – inklusive der Lern-Tools (Quiz, Lernplan, …).

Hermes selbst wird dafür **nicht verändert**: `zai_proxy.py` nutzt Hermes'
eingebauten Proxy-Server und Hermes' gespeicherte Keys.

## Einrichten

1. In Hermes muss ein Z.AI-Key eingerichtet sein (`GLM_API_KEY` bzw.
   `ZAI_API_KEY` in `~/.hermes/.env`, z. B. über `hermes setup`).
2. Proxy starten (Terminal offen lassen):

   ```bash
   ./integrations/hermes/start-zai-proxy.sh
   ```

3. In LearnHarness: **Settings → Providers → + Add a provider → Custom
   endpoint**
   - URL: `http://127.0.0.1:8645/v1`
   - **Keyless**
   - **Connect**, dann für Strong / Cheap / Vision ein GLM-Modell wählen.

Findet das Skript Hermes nicht, gib den Python-Pfad deiner Hermes-Installation an:
`HERMES_PYTHON=/pfad/zu/hermes/venv/bin/python ./integrations/hermes/start-zai-proxy.sh`

## Was geht, was nicht

- **Z.AI: ja.** Getestet mit einer echten LearnHarness-Session gegen ein
  Test-Modell: Hermes ersetzt den Platzhalter-Key durch den Z.AI-Key, alle
  Lern-Tools kommen beim Modell an, die Antwort kommt zurück (auch Streaming).
- **ChatGPT-Abo (OpenAI): nicht über diesen Weg.** Hermes spricht mit dem
  ChatGPT-Abo über ein anderes Protokoll (Responses API) als der
  LearnHarness-Endpoint (Chat Completions). Nutze dafür die eingebaute
  ChatGPT-Verbindung in LearnHarness (Settings → Providers).
- **Nicht der Hermes-API-Server** (`/v1/chat/completions` auf dem Gateway):
  der führt Hermes' eigenen Agenten aus und gibt LearnHarness' Tools nicht ans
  Modell weiter.
- Der Proxy protokolliert nichts – diese Anfragen erscheinen nicht im
  Hermes-Dashboard. Er lauscht nur auf 127.0.0.1 (nicht im Netzwerk).
- Ob ein GLM-Modell die Lern-Tools gut bedient und Bilder versteht (Vision),
  zeigt erst der Alltag.
