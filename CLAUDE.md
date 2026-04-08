# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Start dev server (Vite)
npm run build    # Build for production (outputs to build/)
npm run preview  # Preview the production build
```

There are no tests configured in this project.

## Architecture

**Stack:** SvelteKit + Firebase (Firestore + Auth), built as a static SPA via `@sveltejs/adapter-static`.

**Routing:** All routes are under `src/routes/`. SSR is disabled globally (`export const ssr = false` in `+layout.js`). The app is a pure client-side SPA with `fallback: 'index.html'` for hosting on Firebase.

**Auth flow:** Firebase Auth state is tracked in `src/lib/stores/authStore.js` (a writable Svelte store with `{ user, loading }`). The root layout (`src/routes/+layout.svelte`) listens via `onAuthStateChanged` and redirects unauthenticated users to `/`. The landing page `/` doubles as the login page — it shows an auth form when `$authStore.user` is null and the dashboard when authenticated.

**Firestore data model:**
- `teams` — `{ name, ownerId, roster: [{ id, name, number }] }`
- `formations` — `{ name, ownerId, positions: [{ id, name, group, x, y }], groups }` — position coordinates are percentages on a visual soccer field
- `lineups` — `{ name, teamId, formationId, formationName, players: { positionId: playerId }, ownerId }`
- `games` — `{ teamId, opponent, date, location, status, formationId, availablePlayers[], playerStats: { playerId: { activeMs, benchMs } }, score: { mine, theirs }, history[], preNotes, postNotes, gameTimeStats: { totalMs, sessionStart } }`

**Key route structure:**
- `/` — login + coach dashboard (team listing)
- `/formations` — manage reusable formation templates
- `/formations/[formId]` — visual drag-and-drop formation editor
- `/teams/[teamId]` — roster management + saved lineups list
- `/teams/[teamId]/schedule` — game schedule for the team
- `/teams/[teamId]/lineups/new` — create a lineup by picking a formation
- `/teams/[teamId]/lineups/[lineupId]` — assign players to positions in a lineup
- `/games/[gameId]` — game dashboard: pre/post notes, player minutes box score, match timeline, CSV export
- `/games/[gameId]/live` — live match tracker: real-time timer, lineup drag-and-drop, goal/card event logging

**Firebase config** is in `src/lib/firebase/config.js` and exports `app`, `auth`, and `db`. The API key in that file is a Firebase client key (safe to be public per Firebase design).

**Utilities:** `src/lib/utils.js` exports:
- `generateUUID()` — wraps `crypto.randomUUID()` with a fallback
- `computePositionStats(history, formation)` — computes per-player position and group time (in ms) from game history
- `computePlayerTimelines(history, formation, roster)` — computes ordered timeline segments per player from game history

**Styling:** No CSS framework — all styles are scoped per-component using Svelte's `<style>` blocks, with a dark theme (`#0f172a` background). Global styles are defined in `+layout.svelte`.
