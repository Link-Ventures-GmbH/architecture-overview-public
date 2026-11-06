# Architecture Overview

*A [Link Labs](https://l6s.app) project by Link Ventures GmbH*

A live map of the repo you are coding in, made for your second screen. It shows the
layers and modules of your code and how they depend on each other, and it keeps track of
where you are working right now, down to the function you just saved.

## Run it

```bash
git clone <this repository> && cd architecture-overview
node bin/cli.js ../path/to/your/repo
```

This opens `http://localhost:8360` in your browser. Drag that window to your second screen and press `F` for fullscreen.

No dependencies. You need Node 20 or newer, and git if you want commit history.

## Projects

The tool knows every git project in its workspace (by default the folder above the repo you
start it in, or `--workspace dir`). The grid button in the header, a click on the repo name or `O`
opens the overview: one card per project touched in the last 14 days (or all), sorted by the
latest activity, with a 14-day activity strip and live badges for active Claude chats, agents at
work, open files and incoming telemetry. A click switches every view to that project; the choice
lives in the URL, so a project can be bookmarked. The last three projects stay warm.

Chats are counted for every project they recently worked in (working folders and file paths at
the end of their log), so a session started in a parent folder still lands in the right project.
In the Agents view the session picker shows the chats of the open project, or all chats on this Mac.

## Control room

Above the projects sits the control room: one tile per **product** (a running system with its
environments), from a product registry outside this repo, e.g. `link-labs/leitstand` with one JSON
file per product. The grid button or `O` opens it (tab **Products**; **Projects** is the old grid).

- Each environment is health-checked on its own interval (`every`, at least 30 s). Fly apps that stop
  when idle get `"cold": true` and a long interval, so the checks do not keep them awake. Results feed
  a 24-hour strip and survive restarts (`~/.linklabs/architecture-overview/control-history.json`).
- A product with a usage feed shows the day in numbers (active today, calls, accounts, strangers, new
  accounts, visitors without an account) and keeps its feed running while nobody watches it.
- A click opens the product's first repo, straight in the Usage view when it has a feed.

Where the registry is and which hosts its feeds may reach lives only in
`~/.linklabs/architecture-overview/control.json`:

```json
{ "products": "/path/to/leitstand", "hosts": ["root@1.2.3.4"] }
```

Adapter types: `ssh-docker-sqlite` (a container on a server) and `fly-sqlite`
(a Fly app via the local `fly` login; host entry `fly:<app>`). The adapter script lives in
`adapters/<name>/usage-feed.cjs` or `.py` (or in your own folder: `"adapters": "/path"` in `control.json`,
so your feeds stay out of this repo) and runs with the interpreter its file type names.
`adapters/example` is a working feed to start from. Its
`hello` line may carry `labels` so the view speaks the system's words (a golf app: actions, rounds,
voice inputs instead of calls, questions, receipts). Systems without roles name their owner by
mail domain in `usage.owners.domains`.

A product names an adapter type and its parameters, never a command; the command is built from
templates here (`src/products.js`), parameters that reach a remote shell are checked, and hosts not
in the list are refused. The registry wins over the older per-project `*.usage.json`.

## Views

Switch with the toggle in the header or press `L`.

- **Layers** shows folders as modules, stacked from Interface down to Data and Tests.
- **Logic** shows the product instead: sections like *Investor Room*, *Provider Portal* or
  *Data Sources*, each with its parts (one tile per provider, *NDA Signing*, *Call Booking* …).
  A feature that spans pages, routes and domain code is one tile, so a save in
  `web/investor-routes.ts` and one in `core/investors.ts` light up the same place.

Where the logic map comes from, first match wins:

1. `"logic"` in the repo's `.archoverview.json`
2. A saved map in `~/.linklabs/architecture-overview/` (nothing is written into your repo).
   Two ways to get one:
   - **Map with Claude** runs `claude -p` on your subscription. The `claude` CLI must be logged in.
   - **Copy agent prompt** copies a ready prompt. Paste it into Claude Code or any coding
     agent; the map shows up as soon as the agent saves the file.
3. A guess from file names: folders full of variants (adapters, providers …) and names
   shared across folders (`investor-pages`, `investor-routes`, `investors`).

New files the map does not know yet join the section their folder belongs to.

- **Runtime** shows the running system, from OpenTelemetry. It uses the logic layout, but
  lines are only the calls that really happened (caller → callee). Each request runs across
  the map as it happened; tiles show calls per minute, p95 latency and errors; parts without
  traffic fade. Click a trace on the right for its waterfall.

### Connecting your app

The tool takes OTLP over HTTP (protobuf or JSON, gzip is fine) on the standard port **4318**
and also on `:8360/v1/traces`. For a Node app:

```bash
npm i @opentelemetry/auto-instrumentations-node
```

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 OTEL_SERVICE_NAME=my-app NODE_OPTIONS="--import @opentelemetry/auto-instrumentations-node/register" npm run dev
```

Any other OpenTelemetry SDK works the same way (Go, Python, Java …).

How a span finds its place on the map, first match wins:

| Signal | Example | Lands on |
|---|---|---|
| `code.file.path` / `code.filepath` | `/repo/src/core/search.ts` | that file |
| `code.function.name` / `code.function` | `buildCatalog` | the file that declares it |
| `http.route`, `url.path`, span name | `GET /provider/gleif` | the file that registers the matching route (`app.get('/provider/:slug', …)`, SvelteKit/Next file routes) |
| `server.address`, `url.full` on client spans | `api.worldbank.org` | the file that holds that URL, e.g. the World Bank adapter |
| `db.system` | `sqlite` | the file that imports the database driver |
| span name as a string literal | `data_find` | the file that registers it (app code before scripts) |

Requests for static files (styles, scripts, fonts, images) and `HEAD` requests (health
checks) are dropped, together with their child spans. Spans that match nothing take their parent's place. Requests that still have no home are
listed under the traces as "Not on the map".

- **Agents** shows Claude at work on this machine. It reads the Claude Code session logs in
  `~/.claude/projects` (nothing to install, nothing leaves your machine except DNS lookups):
  - **Agent tree.** The session in the middle, every subagent it spawns splits off and moves out.
    Colour is the model (Opus, Sonnet, Haiku, Fable), active agents carry their task and the tool
    they are using right now.
  - **World map.** Every page an agent opens flies from you to where it is. Pages found in
    searches but not opened show as small grey dots. Arcs stay, so a finished run reads like a
    long exposure.
  - **Side panel.** Agents at work and the peak, models, agent types, tools, countries, tokens.
    When the session goes quiet it turns into the summary of the run.

  - **Team.** When several chats work on one project, the Agents view opens as an org chart.
    A team file (`docs/TEAM.md`, `TEAM.md`) with a role table (rank, role, task) and a staffing table
    (session, role, topic) sets the rows: owner on top, then the roles by rank, chats without a role
    below. Sessions match their role by name, ignoring case, `_`/`-` and the project prefix
    (`DH_Researcher1` → `Researcher n`). Each card shows status (from `~/.claude/sessions`), model,
    topic, current action and its subagents; arcs between cards count the `SendMessage` calls between
    the chats, and a spark runs along when a new one is sent. The right panel shows the conversation.
    A click on a card opens that chat.

  Where a host is, best first: a known organisation (World Bank, OECD …), the country of the
  domain (`.de`, `.jp`), then the server's IP via [DB-IP Lite](https://db-ip.com) (CC BY 4.0,
  downloaded once to `~/.linklabs/architecture-overview/geo`). An IP location is where the server
  stands and may be a network node of a hosting provider, so it is drawn as a ring. Hosts behind
  known CDN ranges (Cloudflare, Fastly) have no real place and are counted apart instead of being
  drawn. The session log format is internal to Claude Code and may change with updates.
  Local Cowork sessions (`~/Library/Application Support/Claude/local-agent-mode-sessions`) are read
  the same way and marked "Cowork"; sessions that run in the cloud do not write logs to this machine.

- **Evals** (only for projects whose config names an evals source). Models answer test
  questions through the project's tools while a judge grades them. Three bands: the agents at
  work (persona, field, model, state, current step, "+N" for the rest), the project's tools
  with calls, p95 and errors, and the source hosts behind them with country, errors and
  "limit hit". Every tool call sends a light point agent → tool → source. The side panel shows
  the run (progress, budget spent against the limit, p50/p95, errors, rate limits) and the
  outcome matrix field × model (answered, partial, honest gap, wrong, platform error). A click
  on an agent or a question opens the waterfall of its trace with the verdict; for past runs,
  whose spans are gone, it falls back to the stored transcript.

  Two inputs, both optional. Files the runner writes, named in `.archoverview.json`:

  ```json
  { "evals": { "live": "data/fachtest/live.json", "runs": "data/fachtest/runs" } }
  ```

  `live.json` (`schema: "evals-live/1"`, replaced atomically every few seconds) carries
  `run_id, label, state, progress, budget, latency, counts, agents, tools, sources, matrix`;
  `runs/<id>/` holds `summary.json` (same fields, final), `verdicts.jsonl` and optionally
  `traces/*.json` and `report.md`. And OpenTelemetry spans after the GenAI conventions:
  `gen_ai.operation.name` `chat` / `execute_tool`, `gen_ai.tool.name`, `gen_ai.request.model`,
  `gen_ai.usage.*`, with `fachtest.run_id` / `fachtest.question_id` (or `eval.*`). Put
  `project.dir` (absolute path of the repo) into the span resource so the tool files the runner's
  spans under the right project; a `"services": ["my-runner"]` list in the config does the same.
  If the server under test continues the trace (`traceparent`), its outgoing calls become the
  source hosts; otherwise `fachtest.tool.hosts` on the tool span names them.
  `node tools/evals-demo.mjs` plays a pretend run into `examples/evals-demo`.

- **Usage** (only for projects with a usage feed). Who uses the running system and what their
  requests do inside it, live. Three bands: the people (owner, team, known, stranger, test, with
  calls in 7 days and when they were last seen; a card lights up while that account is active),
  the system's tools (calls in 7 days, p50 of the requests in view, failures, own services
  marked) and every logical source behind them, own ones apart, lit when used, with calls and
  p50 of the outgoing requests. Each step sends a light point person → tool → source. Below, the
  requests as they come in: who, tool, question, a bar of the phases (search, check, price,
  fetch, source, cut, receipt, deliver), time and outcome; a click opens every step with its
  offset and the source calls. The side panel shows the last hour, 24 hours, active accounts,
  strangers, p50 and errors, the 24 hours by kind of account, the power users of the week and
  where the time goes per phase.

  **Outside** (switch top right) shows the requests without an account, once the system keeps an
  access log: visitors in the last 24 hours split into people, Claude, ChatGPT, bots and others,
  requests per hour by caller, the OAuth steps of connecting an AI, the most visited pages, where
  visitors came from, refused calls (401, 403) and a live list of every outside request. No address
  is ever shown; a visitor is a hash that the system renews daily.

  The feed is a command that prints one JSON object per line (`usage-live/1`): `hello`,
  `sources` (id, name, operator), `users` (accounts with totals, calls per hour, tools of the
  week), `ev` (trace, at, stage, status, text, data, user) and `ready` after the backlog. Since it
  runs a command on this machine, it is set only in
  `~/.linklabs/architecture-overview/<repo>-<hash>.usage.json`, never in the repo:

  ```json
  { "command": ["ssh", "-o", "BatchMode=yes", "host", "docker exec -i app node - /data/app.db"],
    "stdin": "/path/to/usage-feed.cjs",
    "known": { "names": ["Jane Doe"], "domains": ["partner.com"] },
    "own_tools": ["company_lookup"], "own_sources": ["org_private"] }
  ```

  Optional lines for the outside: `users` may carry `outside.web` (24-hour totals: `hours`,
  `classes`, `pages`, `refs`, `refused`, `oauth`, `daily`) and `web` lines stream single requests
  (`at, method, route, status, ms, kind, auth, visitor, ua, ref, user`).

  `stdin` is piped into the command, so a feed script can run on a server without being stored
  there. A dropped feed is restarted at most once a minute. `adapters/example/usage-feed.cjs`
  shows the protocol with made-up data.

## What you see

| Area | Meaning |
|---|---|
| **Bands** | Layers, top to bottom: Interface, API & Entry, Domain & Logic, Data, Infrastructure, Tests |
| **Tiles** | Modules (folders), grouped by area. Each one shows files, lines and a 60-minute activity sparkline |
| **Lines** | Imports between modules. Hover a tile to see what it uses (orange) and what uses it (blue) |
| **Orange glow** | Heat from recent saves, fading over about 15 minutes |
| **Rotating ring** | The module you touched last |
| **Orange dot** | Uncommitted changes in this module |
| **Blue dot** | Changed in the last commit |
| **Working on now** | File, line and the functions or classes you just changed |
| **Sparks** | When you save, sparks run to every module that depends on the one you changed |
| **Timeline** | The last 40 commits. Hover a dot to see where it landed, or press **Replay** to watch them one after another |

Keys: `O` projects · `L` layers → logic → runtime → agents · `F` fullscreen · `R` side panel · `P` replay · `Esc` close details

## How it works

- **Scan.** Lists files with `git ls-files` (so `.gitignore` applies) and reads imports for
  TS/JS (including Svelte/Vue and `tsconfig`/`svelte.config` aliases), Go (via `go.mod`)
  and Python. Symbols are extracted for these languages plus Rust, Java/Kotlin/C#/Swift, Ruby and PHP.
- **Modules.** Starts from the top-level folders, opens containers like `src` or `internal`,
  then splits off big subfolders until the map holds about 32 modules.
- **Layers.** Worked out from folder and file names (`components` means Interface, `handlers`
  means API, `migrations` means Data, and so on). Each module takes the layer most of its code belongs to.
- **Live.** `fs.watch` sees every save. The tool compares the new text with the old one to find the
  changed lines and the symbols around them, and uses `git diff` for work that was already
  uncommitted at startup. Changes are pushed to the browser over Server-Sent Events.

## Tuning

Put an `.archoverview.json` in the repo root when the guesses are off:

```json
{
  "layers": { "src/register/**": "data", "src/mcp/**": "api" },
  "ignore": ["src/generated/**"],
  "modules": ["src/core/ledger"],
  "maxModules": 40
}
```

Layer ids: `ui`, `api`, `domain`, `data`, `infra`, `test`.

A hand-made logic map goes in the same file:

```json
{
  "logic": {
    "sections": [
      { "id": "investors", "label": "Investor Room", "description": "Deal room and NDAs",
        "files": ["src/core/investors.ts"],
        "children": [
          { "id": "nda", "label": "NDA Signing", "files": ["src/core/nda.ts", "src/web/nda-*"] }
        ] }
    ]
  }
}
```

## Data

- World map: land from [Natural Earth](https://www.naturalearthdata.com) via `world-atlas` (public domain),
  country centres from [`world-countries`](https://github.com/mledoze/countries) (ODbL). Rebuild with
  `node tools/build-world.mjs <countries.json> <land-110m.json>`.
- IP geolocation by [DB-IP](https://db-ip.com), CC BY 4.0.

## Before you run it for others

- **No login.** It binds to `127.0.0.1` and has no accounts. Anyone who reaches the port sees everything: your code map, chats, usage data. Do not expose it to a network without your own access control.
- **It reads local data.** Agent views come from `~/.claude`, code from the workspace folder, settings and history live in `~/.linklabs`. Other agents show up only through OpenTelemetry.
- **It talks to the outside in three places.** Fonts come from Google Fonts, the IP database from DB-IP (once a month), and the usage feeds and health checks go wherever you configure them.
- **macOS.** `tools/install-service.sh` is for macOS only. The tool itself needs just Node 20 or newer.

## Develop

```bash
npm test
node bin/cli.js . --port 8360 --otlp-port 4318
```

## License and origin

The public edition of this project is under the Apache License 2.0, see `LICENSE` and `NOTICE`: use it,
change it and build on it, also commercially. Keep the notice and please keep the link to the original
project: [Link Labs](https://l6s.app). How to contribute: `CONTRIBUTING.md`.
