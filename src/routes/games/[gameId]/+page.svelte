<script>
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { doc, getDoc, updateDoc, collection, getDocs, query, where } from 'firebase/firestore';
  import { db } from '$lib/firebase/config';
  import { authStore } from '$lib/stores/authStore';
  import MatchTimeline from '$lib/components/MatchTimeline.svelte';
  import PlayerStatsModal from '$lib/components/PlayerStatsModal.svelte';
  import { computePositionStats, computePlayerTimelines } from '$lib/utils.js';
  import { getGroupColor } from '$lib/groupColors.js';

  const gameId = $page.params.gameId;
  
  let game = null;
  let team = null;
  let formations = [];
  let loading = true;
  let saveStatus = '';
  let editingAvailability = false;
  let showEditModal = false;
  let editingGame = null;
  let showPlayerStatsModal = false;
  let statsModalPlayer = null;
  let statsBarMode = 'grouped'; // 'grouped' | 'timeline'
  let planBarMode = 'grouped'; // 'grouped' | 'timeline'
  let showPlanStatsModal = false;
  let planStatsModalPlayer = null;
  let savedLineups = [];

  const HA_LABELS = { home: '🏠 Home', away: '✈️ Away', neutral: '⚖️ Neutral', 'n/a': 'N/A' };

  onMount(async () => {
    // Wait for auth to be ready if needed, or just proceed if we assume it's there
    if ($authStore.user) {
      await loadGameData();
    }
  });

  async function loadGameData() {
    try {
      const gameSnap = await getDoc(doc(db, 'games', gameId));
      if (!gameSnap.exists()) return;
      game = { id: gameSnap.id, ...gameSnap.data() };
      
      // Ensure defaults
      if (!game.preNotes) game.preNotes = '';
      if (!game.postNotes) game.postNotes = '';
      if (!game.history) game.history = [];
      if (!game.playerStats) game.playerStats = {};
      if (!game.score) game.score = { mine: 0, theirs: 0 };
      if (!game.gameTimeStats) game.gameTimeStats = { totalMs: 0 };
      if (!game.availablePlayers) game.availablePlayers = [];
      if (!game.gamePlan) game.gamePlan = [];

      const teamSnap = await getDoc(doc(db, 'teams', game.teamId));
      if (teamSnap.exists()) team = { id: teamSnap.id, ...teamSnap.data() };

      // Filter by ownerId and ensure name exists
      const q = query(
        collection(db, 'formations'), 
        where('ownerId', '==', $authStore.user.uid)
      );
      const formSnap = await getDocs(q);
      formations = formSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(f => f.name)
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));

      const lineupsSnap = await getDocs(query(collection(db, 'lineups'), where('teamId', '==', game.teamId)));
      savedLineups = lineupsSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.name.localeCompare(b.name));

      // Pre-populate formation from team default if not already set on this game
      if (!game.formationId && team?.defaultFormationId) {
        game.formationId = team.defaultFormationId;
        await updateDoc(doc(db, 'games', gameId), { formationId: game.formationId });
      }

    } catch (error) {
      console.error(error);
    } finally {
      loading = false;
    }
  }

  function openEditModal() {
    editingGame = {
      opponent: game.opponent || '',
      date: game.date || '',
      location: game.location || '',
      homeAway: game.homeAway || 'home'
    };
    showEditModal = true;
  }

  async function saveEditModal() {
    try {
      await updateDoc(doc(db, 'games', gameId), editingGame);
      game = { ...game, ...editingGame };
      showEditModal = false;
      editingGame = null;
    } catch (err) {
      console.error('Error saving game details:', err);
    }
  }

  async function togglePlayerAvailability(playerId) {
    if (game.availablePlayers.includes(playerId)) {
      game.availablePlayers = game.availablePlayers.filter(id => id !== playerId);
    } else {
      game.availablePlayers = [...game.availablePlayers, playerId];
    }
    try {
      await updateDoc(doc(db, 'games', gameId), { availablePlayers: game.availablePlayers });
    } catch (err) {
      console.error('Error updating availability:', err);
    }
  }

  async function saveGameNotes() {
    saveStatus = 'Saving...';
    try {
      await updateDoc(doc(db, 'games', gameId), {
        preNotes: game.preNotes,
        postNotes: game.postNotes,
        formationId: game.formationId || null
      });
      saveStatus = 'Saved.';
      setTimeout(() => saveStatus = '', 2000);
    } catch (err) {
      saveStatus = 'Error saving.';
    }
  }

  // --- Game Plan ---
  async function saveGamePlan() {
    try {
      await updateDoc(doc(db, 'games', gameId), { gamePlan: game.gamePlan });
    } catch (err) {
      console.error('Error saving game plan:', err);
    }
  }

  function addPlanStep() {
    game.gamePlan = [...game.gamePlan, { lineupId: savedLineups[0]?.id ?? null, durationMins: 20 }];
    saveGamePlan();
  }

  function removePlanStep(i) {
    game.gamePlan = game.gamePlan.filter((_, idx) => idx !== i);
    saveGamePlan();
  }

  function movePlanStep(i, dir) {
    const arr = [...game.gamePlan];
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    game.gamePlan = arr;
    saveGamePlan();
  }

  $: totalPlanMins = (game?.gamePlan || []).reduce((sum, s) => sum + (Number(s.durationMins) || 0), 0);
  $: isPreGame = game?.status !== 'live' && game?.status !== 'completed';

  // Planned per-player stats derived from game plan steps
  $: playerPlan = (() => {
    if (!availableRoster.length) return [];
    const posMap = {};
    (gameFormation?.positions || []).forEach(p => { posMap[p.id] = p; });
    const stats = {};
    availableRoster.forEach(p => { stats[p.id] = { activeMs: 0, benchMs: 0, positionMs: {}, groupMs: {} }; });
    for (const step of (game?.gamePlan || [])) {
      const lu = savedLineups.find(l => l.id === step.lineupId);
      if (!lu) continue;
      const ms = (Number(step.durationMins) || 0) * 60 * 1000;
      if (ms <= 0) continue;
      availableRoster.forEach(player => {
        const s = stats[player.id];
        const posId = Object.keys(lu.players || {}).find(k => lu.players[k] === player.id);
        if (posId) {
          s.activeMs += ms;
          s.positionMs[posId] = (s.positionMs[posId] || 0) + ms;
          const group = posMap[posId]?.group;
          if (group) s.groupMs[group] = (s.groupMs[group] || 0) + ms;
        } else {
          s.benchMs += ms;
        }
      });
    }
    return availableRoster.map(p => ({ ...p, ...stats[p.id] })).sort((a, b) => b.activeMs - a.activeMs);
  })();

  $: totalPlanMs = totalPlanMins * 60 * 1000;

  $: playerPlanTimelines = (() => {
    if (!availableRoster.length) return {};
    const posMap = {};
    (gameFormation?.positions || []).forEach(p => { posMap[p.id] = p; });
    const timelines = {};
    availableRoster.forEach(p => { timelines[p.id] = []; });
    let curMs = 0;
    for (const step of (game?.gamePlan || [])) {
      const lu = savedLineups.find(l => l.id === step.lineupId);
      if (!lu) continue;
      const ms = (Number(step.durationMins) || 0) * 60 * 1000;
      if (ms <= 0) continue;
      const segEnd = curMs + ms;
      availableRoster.forEach(player => {
        const posId = Object.keys(lu.players || {}).find(k => lu.players[k] === player.id);
        const group = posId ? (posMap[posId]?.group ?? null) : null;
        timelines[player.id].push({ startMs: curMs, endMs: segEnd, group: posId ? group : null });
      });
      curMs = segEnd;
    }
    return timelines;
  })();

  // --- Helpers ---
  function getPlayerName(playerId) {
    if (!playerId) return '';
    const player = team?.roster.find(p => p.id === playerId);
    return player ? player.name : 'Unknown';
  }

  function formatDuration(ms) {
    if (!ms) return '0:00';
    const totalSecs = Math.floor(ms / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  // Sort history chronologically (used by CSV export)
  $: sortedHistory = [...(game?.history || [])].sort((a, b) => a.timestamp - b.timestamp);

  $: gameFormation = formations.find(f => f.id === game?.formationId) ?? null;
  $: availableRoster = (team?.roster || []).filter(p => game?.availablePlayers?.includes(p.id));
  $: positionStats = computePositionStats(game?.history || [], gameFormation);
  $: playerTimelines = computePlayerTimelines(game?.history || [], gameFormation, availableRoster);

  // Generate Player Stats Array
  $: goalScoredEvents = (game?.history || []).filter(e => e.event === 'Goal (Us)');
  $: boxScore = (team?.roster || [])
    .filter(p => game?.availablePlayers?.includes(p.id))
    .map(p => {
      const stats = game.playerStats[p.id] || { activeMs: 0, benchMs: 0 };
      const goals = goalScoredEvents.filter(e => e.playerId === p.id).length;
      const assists = goalScoredEvents.filter(e => e.assistId === p.id).length;
      return {
        ...p,
        activeMs: stats.activeMs,
        benchMs: stats.benchMs,
        totalMs: stats.activeMs + stats.benchMs,
        goals,
        assists
      };
    })
    .sort((a, b) => b.activeMs - a.activeMs); // Sort by most minutes played

  // --- CSV Export Logic ---
  function exportCSV() {
    let rows = [];

    // 1. Match Header
    rows.push(["MATCH REPORT"]);
    rows.push(["Opponent", game.opponent]);
    rows.push(["Date", new Date(game.date).toLocaleString()]);
    rows.push(["Final Score", `Us: ${game.score.mine} - Them: ${game.score.theirs}`]);
    rows.push(["Total Match Time", formatDuration(game.gameTimeStats.totalMs)]);
    rows.push([]);

    // 2. Player Minutes
    rows.push(["PLAYER MINUTES"]);
    rows.push(["Number", "Player Name", "Field Time (Mins)", "Bench Time (Mins)"]);
    boxScore.forEach(p => {
      rows.push([
        p.number, 
        p.name, 
        formatDuration(p.activeMs), 
        formatDuration(p.benchMs)
      ]);
    });
    rows.push([]);

    // 3. Match Events
    rows.push(["MATCH TIMELINE"]);
    rows.push(["Game Clock", "Event", "Primary Player", "Secondary Details"]);
    sortedHistory.forEach(ev => {
      const time = formatDuration(ev.gameTimeMs);
      const player = getPlayerName(ev.playerId);
      let details = '';
      
      if (ev.assistId) details = `Assist: ${getPlayerName(ev.assistId)}`;
      else if (ev.lineupSnapshot) details = `Substitutions/Tactics Applied`;

      rows.push([time, ev.event, player, details]);
    });

    // Escape and construct CSV string
    const csvContent = rows.map(e => e.map(val => `"${String(val).replace(/"/g, '""')}"`).join(",")).join("\n");
    
    // Download Blob
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `LineupPro_${game.opponent.replace(/\s+/g, '')}_Report.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
</script>

<svelte:head>
  <title>Game Dashboard | Lineup Pro</title>
</svelte:head>

{#if loading}
  <div class="loading">Loading Game Data...</div>
{:else}
  <div class="game-dashboard">
    <header class="dashboard-header">
      <div class="header-info">
        <a href="/teams/{game.teamId}/schedule" class="back-link">← Back to Schedule</a>
        <h1>Game vs. {game.opponent || 'TBD'}</h1>
        <p class="muted">
          {new Date(game.date).toLocaleString(undefined, {dateStyle: 'long', timeStyle: 'short'})} • {game.location || 'Location TBD'}
          {#if game.homeAway && game.homeAway !== 'n/a'}
            <span class="ha-badge ha-{game.homeAway}">{HA_LABELS[game.homeAway]}</span>
          {/if}
          {#if game.status === 'completed' || game.score.mine > 0 || game.score.theirs > 0}
            <span class="score-badge">Score: {game.score.mine} - {game.score.theirs}</span>
          {/if}
        </p>
      </div>

      <div class="header-actions">
        <button class="btn-secondary" on:click={openEditModal}>✎ Edit Details</button>
        <button class="btn-secondary" on:click={exportCSV}>⬇ Export CSV</button>
        <a href="/games/{gameId}/live" class="btn-live" class:btn-live-inactive={game.status !== 'live'}>
          <span class="pulse-dot" class:no-pulse={game.status !== 'live'}></span> Live Match Tracker
        </a>
      </div>
    </header>

    <div class="grid-layout">
      <!-- Top Left: Setup & Notes -->
      <div class="panel">
        <h2>Pre-Game Setup</h2>
        <div class="form-group">
          <label>Starting Formation</label>
          <select bind:value={game.formationId} on:change={saveGameNotes}>
            <option value="">-- Select a Formation --</option>
            {#each formations as form}
              <option value={form.id}>{form.name} ({form.positions?.length || 0} pos)</option>
            {/each}
          </select>
        </div>
        <div class="form-group">
          <label>Pre-Game Notes</label>
          <textarea bind:value={game.preNotes} on:blur={saveGameNotes} rows="3"></textarea>
        </div>
        <span class="save-status">{saveStatus}</span>
      </div>

      <!-- Top Right: Post-Game Notes -->
      <div class="panel">
        <h2>Post-Game Review</h2>
        <div class="form-group">
          <label>Post-Game Notes</label>
          <textarea bind:value={game.postNotes} on:blur={saveGameNotes} rows="6" placeholder="What went well? What needs work?"></textarea>
        </div>
      </div>
    </div>

    <!-- Game Plan -->
    <div class="panel game-plan-panel">
      <div class="panel-title-row">
        <h2>Game Plan</h2>
        {#if game.status !== 'completed' && savedLineups.length > 0}
          <button class="btn-toggle" on:click={addPlanStep}>+ Add Step</button>
        {/if}
      </div>

      {#if savedLineups.length === 0}
        <p class="text-muted small">No saved lineups for this team yet.</p>
      {:else if !game.gamePlan?.length}
        <p class="text-muted small">No game plan yet. Add steps to schedule your lineup rotations.</p>
      {:else}
        <div class="plan-list">
          {#each game.gamePlan as step, i}
            {@const lineupName = savedLineups.find(l => l.id === step.lineupId)?.name ?? 'Unknown Lineup'}
            <div class="plan-step">
              <span class="step-num">{i + 1}</span>
              {#if game.status !== 'completed'}
                <select class="plan-select" bind:value={step.lineupId} on:change={saveGamePlan}>
                  {#each savedLineups as l}
                    <option value={l.id}>{l.name}</option>
                  {/each}
                </select>
                <input class="plan-duration" type="number" min="1" max="120" bind:value={step.durationMins} on:blur={saveGamePlan} />
                <span class="plan-mins-label">min</span>
                <div class="plan-reorder">
                  <button on:click={() => movePlanStep(i, -1)} disabled={i === 0}>↑</button>
                  <button on:click={() => movePlanStep(i, 1)} disabled={i === game.gamePlan.length - 1}>↓</button>
                </div>
                <button class="plan-remove" on:click={() => removePlanStep(i)}>×</button>
              {:else}
                <span class="plan-name-readonly">{lineupName}</span>
                <span class="plan-duration-readonly">{step.durationMins} min</span>
              {/if}
            </div>
          {/each}
        </div>
        <div class="plan-total">Total: <strong>{totalPlanMins} min</strong></div>
      {/if}
    </div>

    <!-- Bottom Section: Stats & Timeline -->
    <div class="stats-grid" class:stats-grid-single={isPreGame}>

      <!-- Pre-game: Player Plan | In/post-game: Player Stats -->
      <div class="panel">
        {#if isPreGame}
          <!-- Player Plan -->
          <div class="panel-title-row">
            <h2>Player Plan</h2>
            <div class="panel-title-right">
              <div class="bar-mode-toggle">
                <button class:active={planBarMode === 'grouped'} on:click={() => planBarMode = 'grouped'}>Grouped</button>
                <button class:active={planBarMode === 'timeline'} on:click={() => planBarMode = 'timeline'}>Timeline</button>
              </div>
              {#if game.status !== 'completed'}
                <button class="btn-toggle" on:click={() => editingAvailability = !editingAvailability}>
                  {editingAvailability ? 'Done' : 'Edit Availability'}
                </button>
              {/if}
            </div>
          </div>

          {#if editingAvailability}
            <p class="small text-muted" style="margin: 0 0 0.75rem 0;">Check players available for this game.</p>
            <div class="roster-checklist">
              {#each (team?.roster || []).sort((a, b) => a.name.localeCompare(b.name)) as player}
                <label class="check-item">
                  <input
                    type="checkbox"
                    checked={game.availablePlayers?.includes(player.id)}
                    on:change={() => togglePlayerAvailability(player.id)}
                  />
                  <span class="check-name">{player.name}</span>
                  <span class="check-number">#{player.number}</span>
                </label>
              {/each}
              {#if !team?.roster?.length}
                <p class="text-muted small">No players in roster.</p>
              {/if}
            </div>
          {:else if !game.gamePlan?.length}
            <p class="text-muted small">Add steps to the Game Plan above to see planned minutes here.</p>
          {:else}
            <div class="table-container stats-panel-scroll">
              <table class="stats-table">
                <thead>
                  <tr>
                    <th>Player</th>
                    <th class="text-right">Planned Time</th>
                  </tr>
                </thead>
                <tbody>
                  {#each playerPlan as p}
                    {@const barTotal = p.activeMs + p.benchMs}
                    {@const groupEntries = Object.entries(p.groupMs || {}).sort((a, b) => b[1] - a[1])}
                    {@const planSegs = playerPlanTimelines[p.id] ?? []}
                    <tr>
                      <td>
                        <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
                        <span class="btn-player-info" title="View planned position time" on:click={() => { planStatsModalPlayer = p; showPlanStatsModal = true; }}>i</span>
                        <span class="muted small mr-1">#{p.number}</span>
                        <strong>{p.name}</strong>
                      </td>
                      <td class="text-right text-green">{formatDuration(p.activeMs)}</td>
                    </tr>
                    {#if barTotal > 0}
                      <tr class="bar-row">
                        <td colspan="2" class="bar-cell">
                          <div class="player-color-bar">
                            {#if planBarMode === 'timeline' && totalPlanMs > 0 && planSegs.length > 0}
                              {#each planSegs as seg}
                                {@const color = getGroupColor(seg.group)}
                                <div class="bar-seg" style="width:{((seg.endMs - seg.startMs) / totalPlanMs * 100).toFixed(2)}%;background:{color.bg};" title="{seg.group ?? 'Bench'}: {formatDuration(seg.endMs - seg.startMs)}"></div>
                              {/each}
                            {:else}
                              {#each groupEntries as [group, ms]}
                                {@const color = getGroupColor(group)}
                                <div class="bar-seg" style="width:{(ms / barTotal * 100).toFixed(2)}%;background:{color.bg};" title="{group}: {formatDuration(ms)}"></div>
                              {/each}
                              {#if p.benchMs > 0}
                                {@const color = getGroupColor(null)}
                                <div class="bar-seg" style="width:{(p.benchMs / barTotal * 100).toFixed(2)}%;background:{color.bg};" title="Bench: {formatDuration(p.benchMs)}"></div>
                              {/if}
                            {/if}
                          </div>
                        </td>
                      </tr>
                    {/if}
                  {/each}
                  {#if playerPlan.length === 0}
                    <tr><td colspan="2" class="text-center text-muted">No players assigned to this game.</td></tr>
                  {/if}
                </tbody>
              </table>
            </div>
          {/if}

        {:else}
          <!-- Player Stats (live / completed) -->
          <div class="panel-title-row">
            <h2>Player Stats</h2>
            <div class="panel-title-right">
              <div class="bar-mode-toggle">
                <button class:active={statsBarMode === 'grouped'} on:click={() => statsBarMode = 'grouped'}>Grouped</button>
                <button class:active={statsBarMode === 'timeline'} on:click={() => statsBarMode = 'timeline'}>Timeline</button>
              </div>
              {#if game.status !== 'completed'}
                <button class="btn-toggle" on:click={() => editingAvailability = !editingAvailability}>
                  {editingAvailability ? 'Done' : 'Edit Availability'}
                </button>
              {/if}
            </div>
          </div>

          {#if editingAvailability}
            <p class="small text-muted" style="margin: 0 0 0.75rem 0;">Check players available for this game.</p>
            <div class="roster-checklist">
              {#each (team?.roster || []).sort((a, b) => a.name.localeCompare(b.name)) as player}
                <label class="check-item">
                  <input
                    type="checkbox"
                    checked={game.availablePlayers?.includes(player.id)}
                    on:change={() => togglePlayerAvailability(player.id)}
                  />
                  <span class="check-name">{player.name}</span>
                  <span class="check-number">#{player.number}</span>
                </label>
              {/each}
              {#if !team?.roster?.length}
                <p class="text-muted small">No players in roster.</p>
              {/if}
            </div>
          {:else}
            <div class="table-container stats-panel-scroll">
              <table class="stats-table">
                <thead>
                  <tr>
                    <th>Player</th>
                    <th class="text-right">Field Time</th>
                    <th class="text-right">G</th>
                    <th class="text-right">A</th>
                  </tr>
                </thead>
                <tbody>
                  {#each boxScore as p}
                    {@const pStats = positionStats[p.id] || { positionMs: {}, groupMs: {} }}
                    {@const groupEntries = Object.entries(pStats.groupMs || {}).sort((a, b) => b[1] - a[1])}
                    {@const barTotal = p.activeMs + p.benchMs}
                    {@const totalGameMs = game?.gameTimeStats?.totalMs ?? 0}
                    {@const timelineSegs = playerTimelines[p.id] ?? []}
                    <tr>
                      <td>
                        <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
                        <span class="btn-player-info" title="View position stats" on:click={() => { statsModalPlayer = p; showPlayerStatsModal = true; }}>i</span>
                        <span class="muted small mr-1">#{p.number}</span>
                        <strong>{p.name}</strong>
                      </td>
                      <td class="text-right text-green">{formatDuration(p.activeMs)}</td>
                      <td class="text-right">{p.goals || '–'}</td>
                      <td class="text-right text-muted">{p.assists || '–'}</td>
                    </tr>
                    {#if barTotal > 0}
                      <tr class="bar-row">
                        <td colspan="4" class="bar-cell">
                          <div class="player-color-bar">
                            {#if statsBarMode === 'timeline' && totalGameMs > 0 && timelineSegs.length > 0}
                              {#each timelineSegs as seg}
                                {@const color = getGroupColor(seg.group)}
                                <div class="bar-seg" style="width:{((seg.endMs - seg.startMs) / totalGameMs * 100).toFixed(2)}%;background:{color.bg};" title="{seg.group ?? 'Bench'}: {formatDuration(seg.endMs - seg.startMs)}"></div>
                              {/each}
                            {:else}
                              {#each groupEntries as [group, ms]}
                                {@const color = getGroupColor(group)}
                                <div class="bar-seg" style="width:{(ms / barTotal * 100).toFixed(2)}%;background:{color.bg};" title="{group}: {formatDuration(ms)}"></div>
                              {/each}
                              {#if p.benchMs > 0}
                                {@const color = getGroupColor(null)}
                                <div class="bar-seg" style="width:{(p.benchMs / barTotal * 100).toFixed(2)}%;background:{color.bg};" title="Bench: {formatDuration(p.benchMs)}"></div>
                              {/if}
                            {/if}
                          </div>
                        </td>
                      </tr>
                    {/if}
                  {/each}
                  {#if boxScore.length === 0}
                    <tr><td colspan="4" class="text-center text-muted">No players assigned to this game.</td></tr>
                  {/if}
                </tbody>
              </table>
            </div>
          {/if}
        {/if}
      </div>

      <!-- Match Timeline (hidden pre-game) -->
      {#if !isPreGame}
        <div class="panel">
          <h2>Match Timeline</h2>
          <div class="stats-panel-scroll">
            <MatchTimeline
              history={game.history}
              roster={team?.roster || []}
              {gameId}
              formation={gameFormation}
              allowEditing={true}
              on:updated={(e) => { game.history = e.detail; }}
            />
          </div>
        </div>
      {/if}

    </div>
  </div>
{/if}

<!-- PLAYER STATS MODAL -->
{#if showPlayerStatsModal && statsModalPlayer}
  <PlayerStatsModal
    player={statsModalPlayer}
    activeMs={statsModalPlayer.activeMs}
    benchMs={statsModalPlayer.benchMs}
    positionStats={positionStats[statsModalPlayer.id] || { positionMs: {}, groupMs: {} }}
    timelineSegments={playerTimelines[statsModalPlayer.id] ?? []}
    totalGameMs={game?.gameTimeStats?.totalMs ?? 0}
    formation={gameFormation}
    on:close={() => showPlayerStatsModal = false}
  />
{/if}

<!-- PLAYER PLAN STATS MODAL -->
{#if showPlanStatsModal && planStatsModalPlayer}
  {@const pp = playerPlan.find(p => p.id === planStatsModalPlayer.id) ?? planStatsModalPlayer}
  <PlayerStatsModal
    player={planStatsModalPlayer}
    activeMs={pp.activeMs ?? 0}
    benchMs={pp.benchMs ?? 0}
    positionStats={{ positionMs: pp.positionMs ?? {}, groupMs: pp.groupMs ?? {} }}
    timelineSegments={playerPlanTimelines[planStatsModalPlayer.id] ?? []}
    totalGameMs={totalPlanMs}
    formation={gameFormation}
    on:close={() => showPlanStatsModal = false}
  />
{/if}

<!-- EDIT GAME DETAILS MODAL -->
{#if showEditModal && editingGame}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="modal-backdrop" on:click={() => showEditModal = false}>
    <div class="modal-panel" on:click|stopPropagation>
      <h2>Edit Game Details</h2>
      <div class="form-group">
        <label for="edit-opponent">Opponent</label>
        <input id="edit-opponent" type="text" bind:value={editingGame.opponent} placeholder="e.g. Red Bulls" />
      </div>
      <div class="form-group">
        <label for="edit-date">Date & Time</label>
        <input id="edit-date" type="datetime-local" bind:value={editingGame.date} />
      </div>
      <div class="form-group">
        <label for="edit-location">Location</label>
        <input id="edit-location" type="text" bind:value={editingGame.location} placeholder="e.g. Field 4" />
      </div>
      <div class="form-group">
        <label>Home / Away</label>
        <div class="ha-toggle">
          <button type="button" class:active={editingGame.homeAway === 'home'} on:click={() => editingGame.homeAway = 'home'}>🏠 Home</button>
          <button type="button" class:active={editingGame.homeAway === 'away'} on:click={() => editingGame.homeAway = 'away'}>✈️ Away</button>
          <button type="button" class:active={editingGame.homeAway === 'neutral'} on:click={() => editingGame.homeAway = 'neutral'}>⚖️ Neutral</button>
          <button type="button" class:active={editingGame.homeAway === 'n/a'} on:click={() => editingGame.homeAway = 'n/a'}>N/A</button>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" on:click={() => showEditModal = false}>Cancel</button>
        <button class="btn-primary" on:click={saveEditModal}>Save</button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* Base Dashboard Layout */
  .dashboard-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #334155; padding-bottom: 1rem; margin-bottom: 2rem; flex-wrap: wrap; gap: 1rem; }
  .back-link { color: #3b82f6; text-decoration: none; font-size: 0.9rem; }
  h1 { margin: 0.25rem 0; color: #f8fafc; }
  .muted, .text-muted { color: #94a3b8; }
  .score-badge { display: inline-block; background: #2563eb; color: white; padding: 0.2rem 0.6rem; border-radius: 0.4rem; font-weight: bold; font-size: 0.85rem; margin-left: 0.25rem; }

  .header-actions { display: flex; gap: 1rem; align-items: center; flex-wrap: wrap;}
  
  .btn-secondary { background: #334155; color: white; border: none; padding: 0.85rem 1.2rem; border-radius: 0.75rem; font-weight: bold; cursor: pointer; transition: background 0.2s;}
  .btn-secondary:hover { background: #475569; }

  .btn-live { background: #10b981; color: white; text-decoration: none; padding: 0.85rem 1.5rem; border-radius: 0.75rem; font-weight: bold; display: flex; align-items: center; gap: 0.75rem; transition: transform 0.2s; }
  .btn-live:hover { transform: translateY(-2px); }
  .btn-live-inactive { background: #d97706; }

  .pulse-dot { width: 10px; height: 10px; background: white; border-radius: 50%; animation: pulse 2s infinite; }
  .pulse-dot.no-pulse { animation: none; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(255, 255, 255, 0.7); } 70% { box-shadow: 0 0 0 8px rgba(255, 255, 255, 0); } 100% { box-shadow: 0 0 0 0 rgba(255, 255, 255, 0); } }

  .grid-layout, .stats-grid { display: grid; grid-template-columns: 1fr; gap: 1.5rem; margin-bottom: 1.5rem;}
  @media (min-width: 800px) { .grid-layout, .stats-grid { grid-template-columns: 1fr 1fr; align-items: start;} }
  @media (min-width: 800px) { .stats-grid-single { grid-template-columns: 1fr; } }

  @media (max-width: 799px) {
    .stats-panel-scroll { max-height: 340px; overflow-y: auto; }
  }

  .panel { background: #111827; border: 1px solid #334155; border-radius: 1rem; padding: 1.5rem; }
  h2 { margin-top: 0; color: #e2e8f0; border-bottom: 1px solid #1e293b; padding-bottom: 0.75rem; margin-bottom: 1rem;}

  /* Forms */
  .form-group { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1rem; }
  label { color: #cbd5e1; font-weight: 500; font-size: 0.95rem;}
  select, textarea { background: #0f172a; border: 1px solid #334155; color: white; padding: 0.75rem; border-radius: 0.5rem; font-family: inherit; resize: vertical; }
  select:focus, textarea:focus { border-color: #3b82f6; outline: none; }
  .save-status { color: #10b981; font-size: 0.85rem; font-style: italic; }

  /* Utility Classes */
  .text-right { text-align: right; }
  .text-center { text-align: center; }
  .text-green { color: #34d399; }
  .text-red { color: #ef4444; }
  .text-yellow { color: #facc15; }
  .small { font-size: 0.85rem; }
  .mr-1 { margin-right: 0.25rem; }

  /* Stats Table */
  .table-container { overflow-x: auto; }
  .btn-player-info {
    display: inline-flex; align-items: center; justify-content: center;
    width: 1.15rem; height: 1.15rem; border-radius: 50%;
    border: 1.5px solid #60a5fa; color: #60a5fa;
    font-size: 0.65rem; font-weight: 700; font-style: italic;
    cursor: pointer; margin-right: 0.4rem; vertical-align: middle;
    transition: background 0.15s, color 0.15s; flex-shrink: 0;
  }
  .btn-player-info:hover { background: #60a5fa; color: #0f172a; }
  .stats-table { width: 100%; border-collapse: collapse; color: #e2e8f0; font-size: 0.95rem;}
  .stats-table th { color: #94a3b8; font-weight: 600; padding: 0.75rem 0.5rem; border-bottom: 2px solid #334155; text-align: left;}
  .stats-table th.text-right { text-align: right; }
  .stats-table td { padding: 0.75rem 0.5rem; border-bottom: 1px solid #1e293b; }
  .stats-table tr:last-child td { border-bottom: none; }
  .bar-row td { padding: 0; border-bottom: 1px solid #1e293b; }
  .bar-cell { padding: 0 0.5rem 0.35rem !important; }
  .player-color-bar { display: flex; height: 5px; border-radius: 3px; overflow: hidden; background: #0f172a; }
  .player-color-bar .bar-seg { flex-shrink: 0; height: 100%; }

  /* Player Minutes panel header row */
  .panel-title-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; }
  .panel-title-row h2 { margin: 0; border: none; padding: 0; }
  .panel-title-right { display: flex; align-items: center; gap: 0.5rem; }
  .bar-mode-toggle { display: flex; background: #0f172a; border-radius: 0.4rem; padding: 0.15rem; }
  .bar-mode-toggle button { background: transparent; border: none; color: #64748b; padding: 0.2rem 0.5rem; border-radius: 0.3rem; cursor: pointer; font-size: 0.72rem; font-weight: 600; }
  .bar-mode-toggle button.active { background: #334155; color: #f8fafc; }

  /* Home/Away badge in header */
  .ha-badge { font-size: 0.85rem; font-weight: 600; margin: 0 0.4rem; color: #94a3b8; }
  .ha-home { color: #10b981; }
  .ha-away { color: #f59e0b; }
  .ha-neutral { color: #818cf8; }

  /* Modal */
  .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.75); display: flex; justify-content: center; align-items: center; z-index: 50; padding: 1rem; }
  .modal-panel { background: #111827; border: 1px solid #334155; border-radius: 1rem; padding: 2rem; width: 100%; max-width: 440px; }
  .modal-panel h2 { margin-top: 0; }
  .modal-panel input[type="text"], .modal-panel input[type="datetime-local"] { background: #0f172a; border: 1px solid #334155; color: white; padding: 0.75rem; border-radius: 0.5rem; width: 100%; box-sizing: border-box; font-family: inherit; }
  .modal-panel input:focus { border-color: #3b82f6; outline: none; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 1rem; padding-top: 1rem; border-top: 1px solid #334155; margin-top: 1rem; }
  .btn-primary { background: #2563eb; color: white; border: none; padding: 0.75rem 1.5rem; border-radius: 0.5rem; cursor: pointer; font-weight: 600; }
  .btn-primary:hover { background: #1d4ed8; }

  /* Home/Away toggle (in modal) */
  .ha-toggle { display: flex; background: #0f172a; border-radius: 0.4rem; padding: 0.15rem; border: 1px solid #334155; }
  .ha-toggle button { flex: 1; background: transparent; border: none; color: #64748b; padding: 0.4rem 0.5rem; border-radius: 0.3rem; cursor: pointer; font-size: 0.82rem; font-weight: 600; transition: all 0.15s; white-space: nowrap; }
  .ha-toggle button.active { background: #334155; color: #f8fafc; }

  .btn-toggle {
    background: #1e293b;
    border: 1px solid #334155;
    color: #cbd5e1;
    padding: 0.35rem 0.75rem;
    border-radius: 0.5rem;
    cursor: pointer;
    font-size: 0.85rem;
    font-weight: 600;
  }
  .btn-toggle:hover { background: #334155; }

  /* Game Plan */
  .game-plan-panel { margin-bottom: 1.5rem; }
  .plan-list { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 0.75rem; }
  .plan-step {
    display: flex; align-items: center; gap: 0.5rem;
    background: #0f172a; border: 1px solid #1e293b; border-radius: 0.5rem;
    padding: 0.5rem 0.75rem; flex-wrap: wrap;
  }
  .step-num { color: #475569; font-size: 0.8rem; font-weight: 700; min-width: 1.2rem; }
  .plan-select { flex: 1; min-width: 0; background: #1e293b; border: 1px solid #334155; color: #f8fafc; padding: 0.4rem 0.5rem; border-radius: 0.4rem; font-size: 0.9rem; outline: none; }
  .plan-select:focus { border-color: #3b82f6; }
  .plan-duration { width: 3.5rem; background: #1e293b; border: 1px solid #334155; color: #f8fafc; padding: 0.4rem 0.5rem; border-radius: 0.4rem; font-size: 0.9rem; text-align: right; outline: none; }
  .plan-duration:focus { border-color: #3b82f6; }
  .plan-mins-label { color: #64748b; font-size: 0.8rem; }
  .plan-reorder { display: flex; gap: 0.2rem; }
  .plan-reorder button { background: #1e293b; border: 1px solid #334155; color: #94a3b8; width: 1.6rem; height: 1.6rem; border-radius: 0.3rem; cursor: pointer; font-size: 0.75rem; padding: 0; display: flex; align-items: center; justify-content: center; }
  .plan-reorder button:disabled { opacity: 0.3; cursor: not-allowed; }
  .plan-reorder button:not(:disabled):hover { background: #334155; }
  .plan-remove { background: transparent; border: none; color: #ef4444; font-size: 1.1rem; cursor: pointer; padding: 0 0.2rem; line-height: 1; opacity: 0.7; }
  .plan-remove:hover { opacity: 1; }
  .plan-name-readonly { flex: 1; color: #f8fafc; font-size: 0.9rem; font-weight: 500; }
  .plan-duration-readonly { color: #94a3b8; font-size: 0.85rem; font-family: monospace; }
  .plan-total { text-align: right; color: #94a3b8; font-size: 0.85rem; }
  .plan-total strong { color: #f8fafc; }

  /* Roster checklist (availability editing) */
  .roster-checklist {
    background: #0f172a;
    border: 1px solid #334155;
    border-radius: 0.5rem;
    padding: 0.5rem;
    max-height: 300px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .check-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.45rem 0.5rem;
    cursor: pointer;
    border-radius: 0.25rem;
  }
  .check-item:hover { background: #1e293b; }
  .check-item input[type="checkbox"] { width: 1rem; height: 1rem; accent-color: #2563eb; flex-shrink: 0; }
  .check-name { flex: 1; color: #f8fafc; font-size: 0.95rem; }
  .check-number { color: #64748b; font-size: 0.85rem; }
</style>