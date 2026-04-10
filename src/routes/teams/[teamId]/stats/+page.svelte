<script>
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { doc, getDoc, getDocs, collection, query, where } from 'firebase/firestore';
  import { db } from '$lib/firebase/config';
  import { authStore } from '$lib/stores/authStore';

  const teamId = $page.params.teamId;

  let team = null;
  let loading = true;
  let sortCol = 'activeMs';
  let sortDir = -1; // -1 = desc, 1 = asc

  // Per-player aggregated stats
  let playerStats = [];

  // Team-level season record
  let record = { played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0 };

  onMount(async () => {
    if ($authStore.user) await loadStats();
  });

  async function loadStats() {
    try {
      const teamSnap = await getDoc(doc(db, 'teams', teamId));
      if (!teamSnap.exists()) return;
      team = { id: teamSnap.id, ...teamSnap.data() };

      const gamesSnap = await getDocs(query(
        collection(db, 'games'),
        where('teamId', '==', teamId),
        where('status', '==', 'completed')
      ));
      const games = gamesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

      // Initialise per-player accumulators
      const acc = {};
      for (const p of (team.roster || [])) {
        acc[p.id] = { activeMs: 0, benchMs: 0, gamesPlayed: 0, goals: 0, assists: 0, yellowCards: 0, redCards: 0 };
      }

      for (const game of games) {
        const score = game.score ?? { mine: 0, theirs: 0 };
        record.played++;
        record.goalsFor += score.mine ?? 0;
        record.goalsAgainst += score.theirs ?? 0;
        if (score.mine > score.theirs) record.wins++;
        else if (score.mine === score.theirs) record.draws++;
        else record.losses++;

        const ps = game.playerStats ?? {};
        for (const p of (team.roster || [])) {
          const s = ps[p.id];
          if (!s) continue;
          if ((s.activeMs ?? 0) > 0) acc[p.id].gamesPlayed++;
          acc[p.id].activeMs += s.activeMs ?? 0;
          acc[p.id].benchMs += s.benchMs ?? 0;
        }

        for (const ev of (game.history || [])) {
          if (ev.event === 'Goal (Us)') {
            if (ev.playerId && acc[ev.playerId]) acc[ev.playerId].goals++;
            if (ev.assistId && acc[ev.assistId]) acc[ev.assistId].assists++;
          } else if (ev.event === 'Yellow Card') {
            if (ev.playerId && acc[ev.playerId]) acc[ev.playerId].yellowCards++;
          } else if (ev.event === 'Red Card') {
            if (ev.playerId && acc[ev.playerId]) acc[ev.playerId].redCards++;
          }
        }
      }

      playerStats = (team.roster || []).map(p => ({ ...p, ...acc[p.id] }));
    } catch (err) {
      console.error(err);
    } finally {
      loading = false;
    }
  }

  function setSort(col) {
    if (sortCol === col) sortDir *= -1;
    else { sortCol = col; sortDir = -1; }
  }

  $: sorted = [...playerStats].sort((a, b) => {
    const av = a[sortCol], bv = b[sortCol];
    if (typeof av === 'string') return av.localeCompare(bv) * sortDir;
    return ((bv - av) * sortDir < 0 ? -1 : 1);
  });

  function fmt(ms) {
    if (!ms) return '0:00';
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function arrow(col) {
    if (sortCol !== col) return '';
    return sortDir === -1 ? ' ↓' : ' ↑';
  }
</script>

<svelte:head>
  <title>{team?.name ?? 'Team'} – Season Stats | Lineup Pro</title>
</svelte:head>

{#if loading}
  <div class="loading">Loading stats…</div>
{:else}
  <div class="stats-page">
    <header class="page-header">
      <div>
        <a href="/teams/{teamId}" class="back-link">← Back to {team?.name ?? 'Team'}</a>
        <h1>{team?.name} — Season Stats</h1>
      </div>
    </header>

    <!-- Season record -->
    <div class="panel record-panel">
      <div class="record-grid">
        <div class="record-cell">
          <span class="record-val">{record.played}</span>
          <span class="record-lbl">Games</span>
        </div>
        <div class="record-cell">
          <span class="record-val win">{record.wins}</span>
          <span class="record-lbl">Wins</span>
        </div>
        <div class="record-cell">
          <span class="record-val loss">{record.losses}</span>
          <span class="record-lbl">Losses</span>
        </div>
        <div class="record-cell">
          <span class="record-val draw">{record.draws}</span>
          <span class="record-lbl">Draws</span>
        </div>
        <div class="record-cell">
          <span class="record-val">{record.goalsFor}</span>
          <span class="record-lbl">Goals For</span>
        </div>
        <div class="record-cell">
          <span class="record-val">{record.goalsAgainst}</span>
          <span class="record-lbl">Goals Against</span>
        </div>
      </div>
    </div>

    <!-- Player stats table -->
    <div class="panel">
      {#if record.played === 0}
        <p class="text-muted">No completed games yet.</p>
      {:else}
        <div class="table-wrap">
          <table class="stats-table">
            <thead>
              <tr>
                <th class="col-player" on:click={() => setSort('name')}>Player{arrow('name')}</th>
                <th class="col-num sortable" on:click={() => setSort('gamesPlayed')}>GP{arrow('gamesPlayed')}</th>
                <th class="col-time sortable" on:click={() => setSort('activeMs')}>Time{arrow('activeMs')}</th>
                <th class="col-num sortable" on:click={() => setSort('goals')}>G{arrow('goals')}</th>
                <th class="col-num sortable" on:click={() => setSort('assists')}>A{arrow('assists')}</th>
                <th class="col-num sortable" on:click={() => setSort('yellowCards')}><span class="card-badge yellow-card">Y</span>{arrow('yellowCards')}</th>
                <th class="col-num sortable" on:click={() => setSort('redCards')}><span class="card-badge red-card">R</span>{arrow('redCards')}</th>
              </tr>
            </thead>
            <tbody>
              {#each sorted as p}
                <tr class:row-inactive={p.gamesPlayed === 0}>
                  <td><span class="player-num">#{p.number}</span> {p.name}</td>
                  <td class="col-num">{p.gamesPlayed}</td>
                  <td class="col-time">{fmt(p.activeMs)}</td>
                  <td class="col-num">{p.goals || '–'}</td>
                  <td class="col-num">{p.assists || '–'}</td>
                  <td class="col-num">{p.yellowCards || '–'}</td>
                  <td class="col-num">{p.redCards || '–'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .loading { color: #94a3b8; padding: 2rem; }
  .stats-page { max-width: 860px; margin: 0 auto; padding: 1.5rem; display: flex; flex-direction: column; gap: 1.5rem; }

  .page-header { display: flex; flex-direction: column; gap: 0.25rem; }
  .back-link { color: #3b82f6; text-decoration: none; font-size: 0.9rem; }
  h1 { margin: 0.25rem 0 0; color: #f8fafc; }

  .panel { background: #111827; border: 1px solid #334155; border-radius: 1rem; padding: 1.5rem; }

  /* Record summary */
  .record-panel { padding: 1.25rem 1.5rem; }
  .record-grid { display: flex; gap: 0; flex-wrap: wrap; }
  .record-cell { display: flex; flex-direction: column; align-items: center; flex: 1; min-width: 4rem; padding: 0.5rem; border-right: 1px solid #1e293b; }
  .record-cell:last-child { border-right: none; }
  .record-val { font-size: 1.75rem; font-weight: 700; color: #f8fafc; line-height: 1; }
  .record-val.win { color: #34d399; }
  .record-val.draw { color: #94a3b8; }
  .record-val.loss { color: #f87171; }
  .record-lbl { font-size: 0.72rem; color: #64748b; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 0.3rem; }

  /* Table */
  .table-wrap { overflow-x: auto; }
  .stats-table { width: 100%; border-collapse: collapse; font-size: 0.92rem; color: #e2e8f0; }
  .stats-table thead th {
    text-align: left; color: #64748b; font-weight: 600; font-size: 0.8rem;
    padding: 0.5rem 0.6rem; border-bottom: 2px solid #334155;
    white-space: nowrap; user-select: none;
  }
  .stats-table thead th.sortable { cursor: pointer; }
  .stats-table thead th.sortable:hover { color: #94a3b8; }
  .stats-table thead th.col-num, .stats-table td.col-num { text-align: center; }
  .stats-table thead th.col-time, .stats-table td.col-time { text-align: right; font-variant-numeric: tabular-nums; }
  .stats-table td { padding: 0.45rem 0.6rem; border-bottom: 1px solid #1e293b; }
  .stats-table tbody tr:last-child td { border-bottom: none; }
  .stats-table tbody tr:hover td { background: #1a2332; }
  .row-inactive td { opacity: 0.4; }
  .player-num { color: #475569; font-size: 0.82rem; }

  .col-player { cursor: pointer; }
  .col-player:hover { color: #94a3b8; }

  .card-badge { display: inline-block; width: 1rem; height: 1.3rem; border-radius: 0.15rem; vertical-align: middle; }
  .yellow-card { background: #facc15; }
  .red-card { background: #ef4444; }

  .text-muted { color: #64748b; }
</style>
