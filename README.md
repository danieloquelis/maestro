# MAESTRO MAYHEM

A 2.5D fighting game where classical composers duel as living ink figurines on a
giant sheet of manuscript paper. Every attack is a musical motif. Built with
Three.js and the Web Audio API — no assets, all procedural.

## Architecture (CDN / OTA delivery)

The game code is **not** inlined in the HTML. Instead:

```
src/game.js   ← all game logic (imports three)
      │  esbuild bundle + minify (three inlined)
      ▼
dist/maestro.js   ← the CDN artifact, committed to the repo
      │  served by jsDelivr from GitHub
      ▼
index.html    ← thin shell: markup + one <script src="…jsdelivr…/dist/maestro.js">
```

Because `index.html` only references the bundle by URL, you ship gameplay updates
**without redeploying the HTML** — push a new `dist/maestro.js` and every player
gets it (OTA-style).

The hosted `index.html` loads:

```
https://cdn.jsdelivr.net/gh/danieloquelis/maestro@main/dist/maestro.js
```

## Develop

```bash
npm install          # esbuild + three (dev only)
npm run serve        # http://localhost:8000 — live rebuild on save
```

`npm run serve` serves the repo root and rebuilds `dist/maestro.js` on every save,
so open `http://localhost:8000/index.html` and edit `src/game.js`.

> During local dev the page still points at the jsDelivr URL. To test local
> changes, temporarily change the `<script src>` in `index.html` to
> `dist/maestro.js`, or use the `dev.html` shell (see below) — then revert before
> committing.

## Ship an update (OTA)

```bash
# 1. edit src/game.js
npm run build        # regenerates dist/maestro.js
git commit -am "feat: …" && git push
```

Or the one-liner: `npm run release`.

jsDelivr caches `@main` at the CDN edge. To force every player onto the new
bundle immediately, hit the purge endpoint once after pushing:

```
https://purge.jsdelivr.net/gh/danieloquelis/maestro@main/dist/maestro.js
```

## Pin a frozen version

For a release you don't want silently changing, tag it and point the HTML at the
tag instead of `@main`:

```bash
git tag v1.0.0 && git push --tags
# in index.html: …/gh/danieloquelis/maestro@v1.0.0/dist/maestro.js
```

## How to play

- **C D E F G A B** — sound a note / attack (low→high pitch hits low→high)
- **3–5 note sequence in 2s** — special motif · **triad** (C+E+G…) — block · **perfect fifth** vs a special — parry
- **← →** move · **↑** jump · **↓** crouch · **Space** ink-dash · **Shift** sidestep · **M** mute · **P/Esc** pause
- On-beat hits (±90ms of the metronome) deal 1.5× — watch the pendulum
- Fill the crescendo `<` meter, then enter your masterwork motif for the **FINALE**
