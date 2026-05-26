# bib-schreibshop (separate Web-App)

Diese App ist bewusst getrennt von der bestehenden gute-reise24 Anwendung.

## Lokal starten

1. cd bib-schreibshop
2. npm install
3. npm run dev
4. Browser: http://localhost:8787

## Deploy Option 1: Render

Datei: render.yaml

1. Repository bei Render verbinden
2. Blueprint Deploy ausfuehren (render.yaml wird erkannt)
3. Environment Variable GOOGLE_BOOKS_API_KEY optional in Render setzen
4. In Render unter Settings -> Custom Domains bib.schreibshop.de hinzufuegen

DNS bei deinem Domain-Provider:

1. CNAME anlegen
2. Host/Name: bib
3. Target: der von Render angezeigte Hostname (z. B. bib-schreibshop.onrender.com)

## Deploy Option 2: Fly.io

Dateien: fly.toml und Dockerfile

1. In fly.toml den App-Namen pruefen/anpassen
2. flyctl launch --no-deploy (falls App noch nicht existiert)
3. flyctl deploy
4. Optional: flyctl secrets set GOOGLE_BOOKS_API_KEY=dein_key
5. Domain anbinden: flyctl certs add bib.schreibshop.de

DNS bei deinem Domain-Provider:

1. CNAME anlegen
2. Host/Name: bib
3. Target: den von flyctl certs add ausgegebenen Ziel-Host eintragen

## SSL/HTTPS

Render und Fly.io stellen Zertifikate automatisch aus, sobald der DNS-Eintrag korrekt ist.

## Deploy Option 3: Vercel (Serverless + statisches Frontend)

Diese Option benoetigt keinen dauerhaft laufenden Node-Prozess auf deinem eigenen Server.

1. Projekt bei Vercel importieren
2. Keine Build-Command erforderlich
3. Output-Directory leer lassen
4. Environment Variables in Vercel setzen:
	1. EXPORT_PASSCODE=phorms
	2. GOOGLE_BOOKS_API_KEY optional
	3. RATE_LIMIT_WINDOW_MS optional
	4. RATE_LIMIT_MAX optional
	5. LOOKUP_RATE_LIMIT_MAX optional
	6. LOC_SRU_BASE_URL optional (Standard: https://lx2.loc.gov:210/LCDB)
	7. BNB_BASE_URL optional (Standard: https://bnb.data.bl.uk)
5. Deploy starten
6. Eigene Domain (z. B. bib.schreibshop.de) in Vercel hinterlegen

Serverless Endpunkte:

1. POST /api/lookup
2. POST /api/export
3. GET /api/health

## API Endpoints

1. GET /health
2. POST /api/export
3. GET /api/admin/stats
4. GET /api/admin/logs

Payload fuer /api/export:

{
	"isbns": "9780140328721\n9783833936340",
	"prefer": "auto",
	"format": "zip"
}

Prefer Werte:

1. auto
2. google
3. dnb
4. loc
5. bnb
6. openlibrary

Format Werte:

1. zip (Standard: ZIP mit MARC21/XML, CSV, XLSX, Misses, Meta)
2. marc21 (direkter Download einer MARC21 XML Datei ohne Entpacken)

## Optional: Google API Key

GOOGLE_BOOKS_API_KEY=...

Ohne Key funktioniert die App ebenfalls, nur mit moeglicher Rate-Limitierung.

Optionale Feinsteuerung fuer Google-Books-Stabilitaet:

1. GOOGLE_CACHE_TTL_MS=3600000
2. GOOGLE_MISS_CACHE_TTL_MS=600000
3. GOOGLE_RATE_LIMIT_COOLDOWN_MS=120000

Deployment-Hinweis:

1. Render: in render.yaml ist GOOGLE_BOOKS_API_KEY bereits als Secret vorgesehen; den Wert im Render-Dashboard setzen.
2. Fly.io: `flyctl secrets set GOOGLE_BOOKS_API_KEY=...`
3. Vercel: im Project unter Environment Variables `GOOGLE_BOOKS_API_KEY` setzen und neu deployen.

## Hinweis zu British Library / BNB

1. Der fruehere Host sru.bl.uk ist nicht mehr verlaesslich verfuegbar.
2. Die App nutzt deshalb BNB Linked Data unter bnb.data.bl.uk.
3. Optional kann der Host ueber BNB_BASE_URL angepasst werden.

## Sicherheit (neu)

Optionale Umgebungsvariablen:

1. EXPORT_PASSCODE=dein_passwort
2. RATE_LIMIT_WINDOW_MS=60000
3. RATE_LIMIT_MAX=12

Wenn EXPORT_PASSCODE gesetzt ist, muss der Passcode im Webformular mitgesendet werden.

Admin-Seite:

1. /admin.html
2. Verwendet denselben Passcode

Audit-Log:

1. Datei: logs/export-audit.log
2. Enthalten: Zeitstempel, IP, Event, Anzahl Eingaben/Exporte/Fehler, ISBN-Liste pro erfolgreichem Export
