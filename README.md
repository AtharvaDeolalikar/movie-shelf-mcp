# movie-shelf-mcp

A personal "what should I watch?" [MCP](https://modelcontextprotocol.io) server. It gives an AI assistant
(Claude, ChatGPT, or any MCP client) a local database of IMDb-rated movies and TV series, plus your own
watched list and watchlist, so it can recommend things you haven't seen yet, filtered by language, genre,
mood, keywords, year and rating.

- Backed by the free [IMDb non-commercial datasets](https://developer.imdb.com/non-commercial-datasets/) in a local SQLite file.
- Runs locally over **stdio**, or remotely over **Streamable HTTP** with bearer-token auth.
- Optional [TMDB](https://www.themoviedb.org/) enrichment for original language, keywords and moods.

> **Licence note:** the IMDb datasets are for personal, non-commercial use only. Respect
> [IMDb's terms](https://developer.imdb.com/non-commercial-datasets/) if you run or fork this project.
> See [Spec.md](Spec.md) for the full design.

## Features

- **Recommendations that skip what you've seen.** `recommend` only returns titles rated above 7.0 (can be
  raised, never lowered) that you haven't marked watched.
- **Movies and TV series.** Covers IMDb `movie`, `tvSeries` and `tvMiniSeries` titles (rated, non-adult,
  100+ votes). Pass `type: "movie"` (default), `"series"` or `"any"`.
- **Rich filters:** original language, genre (with aliases) and excluded genres, TMDB keyword, curated
  mood, minimum rating / votes, year range, and `top` or `shuffle` ordering.
- **Moods.** `feel-good`, `funny`, `romantic`, `emotional`, `tense`, `dark`, `mind-bending`,
  `thought-provoking`, `epic`, `cozy`. Each is a bundle of keyword fragments plus contradicting genres,
  editable in [src/shelf/moods.ts](src/shelf/moods.ts) with no re-import.
- **Watched list.** Mark and unmark titles with optional rating and notes; bulk-import your IMDb
  "Your Ratings" export or a plain list of titles.
- **Watchlist.** Save titles for later; recommendations and searches flag them with `on_watchlist: true`.
  Marking a title watched removes it from the watchlist.
- **Forgiving title matching.** Ignores case, accents, punctuation and a leading "The/A/An"; Roman numerals
  match digits. A title is written only when it is unambiguous, otherwise candidates are returned to pick from.
- **Safe imports.** Streamed, staged, validated and atomically swapped; a failed import never damages the
  existing catalogue, and your watched list and enrichment data survive every refresh.

### MCP tools

| Tool | Purpose |
| --- | --- |
| `recommend` | Unwatched, highly rated titles with filters |
| `search_title` | Look up a title (or IMDb ID / URL) |
| `mark_watched` / `unmark_watched` | Maintain the watched list |
| `list_watched` | Browse what you've watched |
| `add_to_watchlist` / `remove_from_watchlist` | Maintain the watchlist |
| `list_watchlist` | Browse the watchlist (newest first, or `sort: "rating"`) |

## Requirements

- Node.js 20 or newer
- A C/C++ toolchain if no prebuilt binary exists for your platform (needed to compile `better-sqlite3`)
- About 1 GB of free disk for the database
- Optional: a free [TMDB API key](https://www.themoviedb.org/settings/api) for languages, keywords and moods

## Quick start (local, stdio)

```sh
git clone https://github.com/AtharvaDeolalikar/movie-shelf-mcp.git
cd movie-shelf-mcp
npm install
cp .env.example .env        # optional; set TMDB_API_KEY here to enable keywords/moods
npm run import:imdb         # download + import the IMDb catalogue (first run takes a few minutes)
npm run import:languages    # original languages (Wikidata, then TMDB fallback)
npm run import:keywords     # TMDB keywords for the keyword / mood filters (needs TMDB_API_KEY)
npm run build
```

Only `import:imdb` is required; the language and keyword steps improve filtering. Titles without a known
language appear only when no language filter is given, and `keyword` / `mood` only match titles with imported keywords.

### Import what you've already watched

```sh
npm run import:watched -- --csv ratings.csv                       # IMDb "Your Ratings" export
npm run import:watched -- --text titles.txt                       # one title per line
npm run import:watched -- --csv watchlist.csv --list watchlist    # fill the watchlist instead
```

Ambiguous and unmatched lines are printed so you can fix them by hand.

### Connect an MCP client

**Claude Code:**

```sh
claude mcp add movie-shelf --scope user -- node /ABSOLUTE/PATH/movie-shelf-mcp/dist/cli/mcp-stdio.js
```

**Claude Desktop**, in `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "movie-shelf": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/movie-shelf-mcp/dist/cli/mcp-stdio.js"]
    }
  }
}
```

Use the full path to `node` (`which node`) if Claude Desktop can't find it (nvm installs aren't on its PATH).
The database defaults to `data/movie-shelf.db` inside the project regardless of the working directory; set
`MOVIE_SHELF_DB` (via `"env"`) to use another file.

**MCP Inspector:** `npx @modelcontextprotocol/inspector node dist/cli/mcp-stdio.js`

## Deploying as a remote server

Deploy over HTTP when you want to use the server from claude.ai, ChatGPT connectors, or several devices.
Any always-on Linux host works (a small VPS or cloud VM). The steps below use pm2 and nginx; adapt them to
systemd, Docker, Caddy, etc. as you prefer.

### 1. Install on the server

```sh
git clone https://github.com/AtharvaDeolalikar/movie-shelf-mcp.git ~/movie-shelf-mcp
cd ~/movie-shelf-mcp
sudo apt install -y build-essential     # only if better-sqlite3 must compile (e.g. aarch64)
npm ci && npm run build
```

### 2. Configure `.env`

```sh
cat > .env <<EOF
MCP_AUTH_TOKEN=$(openssl rand -hex 32)
TMDB_API_KEY=your-tmdb-key
HOST=127.0.0.1
PORT=8787
EOF
chmod 600 .env
```

| Variable | Description |
| --- | --- |
| `MCP_AUTH_TOKEN` | **Required** for the HTTP server. Shared secret clients must present. |
| `HOST` / `PORT` | Bind address (default `127.0.0.1:8787`). Keep it on loopback behind a TLS reverse proxy. |
| `MOVIE_SHELF_DB` | SQLite path (default `./data/movie-shelf.db`). |
| `TMDB_API_KEY` | TMDB v3 key or v4 token; enables the language fallback and keyword import. |
| `HTTP_USER_AGENT` | Sent to Wikidata / TMDB; include contact info, as Wikimedia recommends. |
| `IMDB_DATASETS_URL` | Override the dataset mirror (testing only). |

### 3. Load the data

```sh
npm run import:imdb && npm run import:languages && npm run import:keywords
```

### 4. Run it

```sh
npm install -g pm2
pm2 start "node --env-file=.env dist/cli/mcp-http.js" --name movie-shelf
pm2 save && pm2 startup        # restart automatically on reboot
```

Check it: `curl http://127.0.0.1:8787/health`

### 5. Put HTTPS in front

Never expose the bearer token over plain HTTP. With nginx and a certificate (e.g. from Let's Encrypt):

```nginx
location /movie-shelf/ {
    proxy_pass http://127.0.0.1:8787/;    # trailing slash strips the prefix
    proxy_http_version 1.1;
    proxy_buffering off;                   # required for streaming (SSE)
    proxy_set_header Host $host;
}
```

The MCP endpoint is then `https://your-domain/movie-shelf/mcp` (health: `/movie-shelf/health`).

### 6. Connect clients

- Header-capable clients: send `Authorization: Bearer <MCP_AUTH_TOKEN>`.
- URL-only clients (claude.ai, ChatGPT connectors): use `https://your-domain/movie-shelf/mcp?token=<MCP_AUTH_TOKEN>`.
  The query form can end up in proxy access logs, so use a dedicated token and rotate it if logs are shared.

### 7. Keep the catalogue fresh (optional)

IMDb refreshes its datasets daily. A cron entry (here 03:30 UTC) keeps yours current, with `flock` to
prevent overlapping runs:

```cron
30 3 * * * cd ~/movie-shelf-mcp && flock -n /tmp/movie-shelf-import.lock sh -c 'npm run import:imdb && npm run import:languages && npm run import:keywords' >> logs/import.log 2>&1
```

### Updating

```sh
git pull && npm ci && npm run build && pm2 restart movie-shelf
```

Schema migrations run automatically on start. After upgrading across a release that adds title types or
columns, re-run the import commands to populate them.

### Backups and inspection

Everything you care about (watched list, watchlist, language and keyword enrichment) is in the single SQLite
file at `MOVIE_SHELF_DB`; copy it while the server is idle, or use `sqlite3 data/movie-shelf.db ".backup out.db"`.
To browse or edit it, [sqlite-web](https://github.com/coleifer/sqlite-web) bound to `127.0.0.1` and reached
through an SSH tunnel works well. It can edit data, so never expose it publicly.

## Commands

| Command | What it does |
| --- | --- |
| `npm run import:imdb` | Download + import the IMDb catalogue (streamed, staged, atomically swapped) |
| `npm run import:imdb -- --dir <path>` | Same, from already-downloaded `title.basics.tsv.gz` / `title.ratings.tsv.gz` |
| `npm run import:imdb -- --force` | Allow the swap even if the catalogue shrinks by >50% |
| `npm run import:languages` | Wikidata bulk languages (if last run >= 6 days old) + TMDB fallback |
| `npm run import:languages -- --wikidata always` | Force the Wikidata job (`never` to skip it) |
| `npm run import:languages -- --skip-tmdb` / `--tmdb-limit <n>` | Skip / cap TMDB lookups |
| `npm run import:keywords` (`-- --limit <n>`, `--retry-days <n>`) | TMDB keywords for the `keyword` / `mood` filters (needs `TMDB_API_KEY`) |
| `npm run import:watched -- --csv <ratings.csv>` | Import an IMDb "Your Ratings" export |
| `npm run import:watched -- --text <titles.txt>` | Import a title list; prints ambiguous / unmatched lines |
| `npm run build` | Compile to `dist/` (needed by MCP clients) |
| `npm run mcp` | Run the MCP stdio server from source |
| `npm run start:http` | Run the built HTTP server (`POST /mcp`, `GET /health`); needs `MCP_AUTH_TOKEN` |
| `npm test` | Run tests (`node:test` via tsx) |
| `npm run typecheck` | Strict TypeScript check |

## How it works

### Import guarantees

- Files are stream-decompressed and parsed line by line; nothing raw is written to disk or the DB. Runs fine
  with `--max-old-space-size=96`.
- Rows go to `movies_staging`; `movies` is replaced in a single transaction only after all checks pass.
- Any error (network, truncated gzip, changed header, empty result, catalogue shrinking by >50%) discards
  staging and leaves the old catalogue untouched.
- Ctrl-C / SIGTERM mark the run `interrupted`; a hard kill is detected on the next run.
- `watched`, `watchlist` and the language / keyword tables have no FK to `movies`, so they survive every swap.

### Language enrichment

Priority: `manual` > `wikidata` > `tmdb`.

1. **Wikidata:** one SPARQL query (10 shards on timeout). Only IMDb IDs with exactly one original language are
   stored; multi-language entries are left for TMDB rather than guessed.
2. **TMDB:** for titles passing the default recommend filter (rating > 7.0, votes >= 1000) that still have no
   language. Lookups are logged and misses retried after 30 days. About 20 req/s, retries 429/5xx, aborts on a bad key.

Cantonese is stored as `cn` (TMDB's code; it has no ISO 639-1 code).

### Keywords and moods

`import:keywords` fetches TMDB keywords for titles passing the default recommend filter (2 requests per title).
Re-runs fetch only new titles and retry misses after 30 days. `keyword` is a case-insensitive substring (a
list means ALL); `mood` expands to keyword fragments (match any) plus genres to exclude.

### Layout

```
src/config.ts               env config, catalogue vote floor (100)
src/db/schema.ts            schema + migrations (PRAGMA user_version)
src/db/repository.ts        storage interfaces (swap SQLite for Postgres here)
src/db/sqlite-repository.ts SQLite implementation
src/imdb/                   streaming gunzip + TSV parsing, import pipeline
src/languages/              language normalisation, Wikidata + TMDB clients
src/keywords/import.ts      TMDB keyword import (resumable)
src/shelf/                  tool logic: filters, title resolution, genres, moods
src/mcp/server.ts           MCP tool definitions
src/mcp/http.ts             Streamable HTTP handler (stateless, bearer / ?token= auth, /health)
src/watched/parse.ts        IMDb ratings CSV + title-list parsing
src/cli/                    entry points for imports and the stdio / HTTP servers
scripts/smoke-stdio.ts      end-to-end check of the built server (writes; use a DB copy)
test/                       node:test suites
```

## Development

```sh
npm test            # unit + integration tests
npm run typecheck
npm run mcp         # stdio server from source
```

## Contributing

Issues and pull requests are welcome. Please run `npm test` and `npm run typecheck` before submitting.

## Acknowledgements

Ratings and titles from the [IMDb non-commercial datasets](https://developer.imdb.com/non-commercial-datasets/);
languages from [Wikidata](https://www.wikidata.org/); keywords and language fallback from
[TMDB](https://www.themoviedb.org/). This product uses the TMDB API but is not endorsed or certified by TMDB.
This project is not affiliated with IMDb.

## License

The source code is released under the [MIT License](LICENSE). This covers the code only: the IMDb datasets
and the TMDB / Wikidata data it fetches remain subject to their own terms (IMDb and TMDB are restricted to
personal, non-commercial use).
