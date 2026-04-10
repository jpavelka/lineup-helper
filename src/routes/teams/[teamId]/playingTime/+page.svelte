<script>
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { doc, getDoc, getDocs, collection, query, where } from 'firebase/firestore';
  import { db } from '$lib/firebase/config';
  import { authStore } from '$lib/stores/authStore';
  import { getGroupColor } from '$lib/groupColors.js';
  import { computePositionStats } from '$lib/utils.js';

  const teamId = $page.params.teamId;

  let team = null;
  let games = [];
  let formations = {};   // { formationId: formation }
  let loading = true;
  let sortDir = -1;

  // Per-game selection: { [gameId]: { included: bool, planId: string|null } }
  let selections = {};

  onMount(async () => {
    if ($authStore.user) await loadData();
  });

  async function loadData() {
    try {
      const [teamSnap, gamesSnap, formsSnap] = await Promise.all([
        getDoc(doc(db, 'teams', teamId)),
        getDocs(query(collection(db, 'games'), where('teamId', '==', teamId))),
        getDocs(query(collection(db, 'formations'), where('ownerId', '==', $authStore.user.uid))),
      ]);

      if (!teamSnap.exists()) return;
      team = { id: teamSnap.id, ...teamSnap.data() };

      formations = Object.fromEntries(formsSnap.docs.map(d => [d.id, { id: d.id, ...d.data() }]));

      games = gamesSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => new Date(a.date) - new Date(b.date));

      const init = {};
      for (const g of games) {
        const plans = gamePlans(g);
        init[g.id] = { included: g.status === 'completed', planId: plans[0]?.id ?? null };
      }
      selections = init;
    } catch (err) {
      console.error(err);
    } finally {
      loading = false;
    }
  }

  function gamePlans(game) {
    if (game.gamePlans?.length) return game.gamePlans;
    if (game.gamePlan?.length) return [{ id: '__legacy__', name: 'Game Plan', steps: game.gamePlan }];
    return [];
  }

  // Returns { [playerId]: { activeMs, groupMs: { [group]: ms } } }
  function gameContribution(game, planId) {
    if (game.status === 'completed') {
      const formation = formations[game.formationId] ?? null;
      const posStats = computePositionStats(game.history ?? [], formation);
      const result = {};
      for (const p of (team?.roster ?? [])) {
        const ps = game.playerStats?.[p.id];
        if (!ps?.activeMs) continue;
        result[p.id] = { activeMs: ps.activeMs, groupMs: posStats[p.id]?.groupMs ?? {} };
      }
      return result;
    }

    // Upcoming: derive from plan steps
    const plans = gamePlans(game);
    const plan = planId ? plans.find(p => p.id === planId) : plans[0];
    if (!plan) return {};
    const result = {};
    for (const step of (plan.steps ?? [])) {
      if (step.included === false) continue;
      const ms = (Number(step.durationMins) || 0) * 60000;
      if (ms <= 0) continue;
      const formation = formations[step.formationId] ?? null;
      const posGroupMap = {};
      (formation?.positions ?? []).forEach(pos => { posGroupMap[pos.id] = pos.group ?? null; });
      for (const [posId, playerId] of Object.entries(step.players ?? {})) {
        if (!playerId) continue;
        if (!result[playerId]) result[playerId] = { activeMs: 0, groupMs: {} };
        result[playerId].activeMs += ms;
        const grp = posGroupMap[posId];
        if (grp) result[playerId].groupMs[grp] = (result[playerId].groupMs[grp] ?? 0) + ms;
      }
    }
    return result;
  }

  $: totals = (() => {
    const acc = {};
    for (const p of (team?.roster ?? [])) {
      acc[p.id] = { activeMs: 0, completedGroupMs: {}, plannedGroupMs: {} };
    }
    for (const g of games) {
      const sel = selections[g.id];
      if (!sel?.included) continue;
      const contrib = gameContribution(g, sel.planId);
      for (const [pid, data] of Object.entries(contrib)) {
        if (!acc[pid]) continue;
        acc[pid].activeMs += data.activeMs;
        const target = g.status === 'completed' ? acc[pid].completedGroupMs : acc[pid].plannedGroupMs;
        for (const [grp, ms] of Object.entries(data.groupMs)) {
          target[grp] = (target[grp] ?? 0) + ms;
        }
        // Track ungrouped active time (bench time is excluded; ungrouped = time w/o a known group)
        const groupedMs = Object.values(data.groupMs).reduce((s, v) => s + v, 0);
        const ungrouped = data.activeMs - groupedMs;
        if (ungrouped > 0) {
          target[''] = (target[''] ?? 0) + ungrouped;
        }
      }
    }
    return acc;
  })();

  $: maxMs = Math.max(1, ...Object.values(totals).map(t => t.activeMs));

  $: sortedRoster = [...(team?.roster ?? [])]
    .map(p => ({ ...p, ...totals[p.id] }))
    .sort((a, b) => (b.activeMs - a.activeMs) * sortDir || a.name.localeCompare(b.name));

  // Collect all groups that appear (for legend)
  $: allGroups = [...new Set(
    Object.values(totals).flatMap(t => [
      ...Object.keys(t.completedGroupMs),
      ...Object.keys(t.plannedGroupMs),
    ])
  )].filter(g => g !== '');

  $: selectedCount = games.filter(g => selections[g.id]?.included).length;

  // Build bar segments for a player: actual group segs (full) then planned group segs (faded)
  function barSegments(playerTotal) {
    const segs = [];
    for (const [grp, ms] of Object.entries(playerTotal.completedGroupMs)) {
      if (ms > 0) segs.push({ grp, ms, planned: false });
    }
    for (const [grp, ms] of Object.entries(playerTotal.plannedGroupMs)) {
      if (ms > 0) segs.push({ grp, ms, planned: true });
    }
    return segs;
  }

  function fmt(ms) {
    if (!ms) return '0:00';
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function gameLabel(game) {
    const d = new Date(game.date);
    return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} vs. ${game.opponent || 'TBD'}`;
  }

  function toggleAll(included) {
    const next = {};
    for (const g of games) next[g.id] = { ...selections[g.id], included };
    selections = next;
  }
</script>

<svelte:head>
  <title>{team?.name ?? 'Team'} – Playing Time | Lineup Pro</title>
</svelte:head>

{#if loading}
  <div class="loading">Loading…</div>
{:else}
  <div class="pt-page">
    <header class="page-header">
      <a href="/teams/{teamId}" class="back-link">← Back to {team?.name ?? 'Team'}</a>
      <h1>{team?.name} — Playing Time</h1>
    </header>

    <div class="layout">

      <!-- Left: game selector -->
      <div class="panel game-list-panel">
        <div class="game-list-header">
          <h2>Games</h2>
          <div class="sel-all-btns">
            <button class="btn-tiny" on:click={() => toggleAll(true)}>All</button>
            <button class="btn-tiny" on:click={() => toggleAll(false)}>None</button>
          </div>
        </div>

        {#if games.length === 0}
          <p class="text-muted small">No games yet.</p>
        {:else}
          <div class="game-list">
            {#each games as game}
              {@const isCompleted = game.status === 'completed'}
              {@const plans = gamePlans(game)}
              {@const sel = selections[game.id]}
              <label class="game-row" class:game-row-off={!sel?.included}>
                <input type="checkbox" bind:checked={selections[game.id].included} />
                <div class="game-row-body">
                  <div class="game-row-top">
                    <span class="game-row-label">{gameLabel(game)}</span>
                    {#if isCompleted}
                      <span class="badge badge-done">Actual</span>
                    {:else if plans.length}
                      <span class="badge badge-plan">Planned</span>
                    {:else}
                      <span class="badge badge-none">No plan</span>
                    {/if}
                  </div>
                  {#if !isCompleted && sel?.included && plans.length > 0}
                    <div class="plan-sel-row">
                      <!-- svelte-ignore a11y-no-onchange -->
                      <select class="plan-sel"
                        value={sel.planId}
                        on:change={(e) => selections[game.id] = { ...sel, planId: e.target.value }}>
                        {#each plans as plan}
                          <option value={plan.id}>{plan.name}</option>
                        {/each}
                      </select>
                    </div>
                  {/if}
                </div>
              </label>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Right: player totals -->
      <div class="panel totals-panel">
        <div class="totals-header">
          <h2>Player Totals</h2>
          <span class="totals-summary">{selectedCount} game{selectedCount === 1 ? '' : 's'} selected</span>
          <button class="btn-tiny sort-btn" on:click={() => sortDir *= -1}>
            {sortDir === -1 ? 'Most → Least' : 'Least → Most'}
          </button>
        </div>

        {#if sortedRoster.length === 0}
          <p class="text-muted small">No players in roster.</p>
        {:else}
          <div class="player-list">
            {#each sortedRoster as p}
              {@const segs = barSegments(totals[p.id])}
              <div class="player-row">
                <div class="player-info">
                  <span class="player-num">#{p.number}</span>
                  <span class="player-name">{p.name}</span>
                  <span class="player-time">{fmt(p.activeMs)}</span>
                </div>
                <div class="time-bar-wrap">
                  {#each segs as seg}
                    {@const color = getGroupColor(seg.grp || null)}
                    <div class="time-bar-seg"
                      style="width:{(seg.ms / maxMs * 100).toFixed(2)}%;background:{color.bg};{seg.planned ? 'opacity:0.45;' : ''}"
                      title="{seg.grp || 'Unknown'} ({seg.planned ? 'planned' : 'actual'}): {fmt(seg.ms)}">
                    </div>
                  {/each}
                </div>
              </div>
            {/each}
          </div>

          {#if allGroups.length > 0}
            <div class="bar-legend">
              {#each allGroups as grp}
                {@const color = getGroupColor(grp)}
                <span class="legend-item">
                  <span class="legend-swatch" style="background:{color.bg};"></span>
                  {grp}
                </span>
              {/each}
              <span class="legend-item legend-opacity">
                <span class="legend-swatch-pair">
                  <span class="legend-swatch swatch-full" style="background:#94a3b8;"></span>
                  <span class="legend-swatch swatch-faded" style="background:#94a3b8;opacity:0.45;"></span>
                </span>
                Actual / Planned
              </span>
            </div>
          {/if}
        {/if}
      </div>

    </div>
  </div>
{/if}

<style>
  .loading { color: #94a3b8; padding: 2rem; }
  .pt-page { max-width: 1000px; margin: 0 auto; padding: 1.5rem; display: flex; flex-direction: column; gap: 1.5rem; }

  .page-header { display: flex; flex-direction: column; gap: 0.25rem; }
  .back-link { color: #3b82f6; text-decoration: none; font-size: 0.9rem; }
  h1 { margin: 0.25rem 0 0; color: #f8fafc; }

  .panel { background: #111827; border: 1px solid #334155; border-radius: 1rem; padding: 1.25rem 1.5rem; }
  h2 { margin: 0; color: #e2e8f0; font-size: 1rem; }

  .layout { display: grid; grid-template-columns: 1fr; gap: 1.5rem; }
  @media (min-width: 700px) { .layout { grid-template-columns: 300px 1fr; align-items: start; } }

  /* Game list */
  .game-list-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem; }
  .sel-all-btns { display: flex; gap: 0.3rem; margin-left: auto; }
  .btn-tiny {
    background: #1e293b; border: 1px solid #334155; color: #94a3b8;
    font-size: 0.75rem; font-weight: 600; padding: 0.15rem 0.5rem;
    border-radius: 0.3rem; cursor: pointer;
  }
  .btn-tiny:hover { background: #334155; color: #e2e8f0; }

  .game-list { display: flex; flex-direction: column; gap: 0.3rem; max-height: 70vh; overflow-y: auto; }
  .game-row {
    display: flex; align-items: flex-start; gap: 0.6rem;
    padding: 0.55rem 0.6rem; border-radius: 0.4rem; cursor: pointer;
    border: 1px solid transparent; transition: background 0.1s;
  }
  .game-row:hover { background: #1e293b; }
  .game-row input[type="checkbox"] { margin-top: 0.2rem; flex-shrink: 0; accent-color: #3b82f6; width: 1rem; height: 1rem; }
  .game-row-off { opacity: 0.45; }
  .game-row-body { flex: 1; display: flex; flex-direction: column; gap: 0.3rem; }
  .game-row-top { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .game-row-label { color: #e2e8f0; font-size: 0.88rem; flex: 1; }

  .badge { font-size: 0.68rem; font-weight: 700; padding: 0.1rem 0.4rem; border-radius: 0.25rem; white-space: nowrap; }
  .badge-done { background: #064e3b; color: #34d399; }
  .badge-plan { background: #1e3a5f; color: #60a5fa; }
  .badge-none { background: #1e293b; color: #475569; }

  .plan-sel-row { display: flex; }
  .plan-sel {
    background: #0f172a; border: 1px solid #334155; color: #94a3b8;
    font-size: 0.78rem; padding: 0.2rem 0.4rem; border-radius: 0.3rem; outline: none; width: 100%;
  }
  .plan-sel:focus { border-color: #3b82f6; }

  /* Totals */
  .totals-header { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 1rem; flex-wrap: wrap; }
  .totals-summary { color: #64748b; font-size: 0.82rem; }
  .sort-btn { margin-left: auto; }

  .player-list { display: flex; flex-direction: column; gap: 0.55rem; }
  .player-row { display: flex; flex-direction: column; gap: 0.2rem; }
  .player-info { display: flex; align-items: baseline; gap: 0.4rem; }
  .player-num { color: #475569; font-size: 0.8rem; min-width: 2.2rem; }
  .player-name { color: #e2e8f0; font-size: 0.92rem; font-weight: 500; flex: 1; }
  .player-time { color: #34d399; font-size: 0.85rem; font-variant-numeric: tabular-nums; }

  .time-bar-wrap { display: flex; height: 6px; background: #0f172a; border-radius: 3px; overflow: hidden; }
  .time-bar-seg { height: 100%; flex-shrink: 0; }

  /* Legend */
  .bar-legend { display: flex; align-items: center; flex-wrap: wrap; gap: 0.6rem; margin-top: 1rem; font-size: 0.75rem; color: #64748b; }
  .legend-item { display: flex; align-items: center; gap: 0.3rem; }
  .legend-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; flex-shrink: 0; }
  .legend-swatch-pair { display: flex; gap: 1px; }
  .swatch-full { opacity: 1; }
  .swatch-faded { opacity: 0.45; }

  .text-muted { color: #64748b; }
  .small { font-size: 0.85rem; }
</style>
