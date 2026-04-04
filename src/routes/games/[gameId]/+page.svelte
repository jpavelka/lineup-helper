<script>
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { doc, getDoc, updateDoc, collection, getDocs } from 'firebase/firestore';
  import { db } from '$lib/firebase/config';

  const gameId = $page.params.gameId;
  
  let game = null;
  let team = null;
  let formations = [];
  let loading = true;
  let saveStatus = '';

  onMount(async () => {
    await loadGameData();
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

      const teamSnap = await getDoc(doc(db, 'teams', game.teamId));
      if (teamSnap.exists()) team = { id: teamSnap.id, ...teamSnap.data() };

      const formSnap = await getDocs(collection(db, 'formations'));
      formations = formSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    } catch (error) {
      console.error(error);
    } finally {
      loading = false;
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

  // Sort history chronologically
  $: sortedHistory = [...(game?.history || [])].sort((a, b) => a.timestamp - b.timestamp);

  // Generate Player Stats Array
  $: boxScore = (team?.roster || [])
    .filter(p => game?.availablePlayers?.includes(p.id))
    .map(p => {
      const stats = game.playerStats[p.id] || { activeMs: 0, benchMs: 0 };
      return {
        ...p,
        activeMs: stats.activeMs,
        benchMs: stats.benchMs,
        totalMs: stats.activeMs + stats.benchMs
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
          {new Date(game.date).toLocaleString()} • {game.location}
          {#if game.status === 'completed' || game.score.mine > 0 || game.score.theirs > 0}
            <span class="score-badge">Score: {game.score.mine} - {game.score.theirs}</span>
          {/if}
        </p>
      </div>
      
      <div class="header-actions">
        <button class="btn-secondary" on:click={exportCSV}>⬇ Export CSV</button>
        <a href="/games/{gameId}/live" class="btn-live">
          <span class="pulse-dot"></span> Live Match Tracker
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
              <option value={form.id}>{form.name} ({form.size}v{form.size})</option>
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

    <!-- Bottom Section: Stats & Timeline -->
    <div class="stats-grid">
      
      <!-- Player Minutes Box Score -->
      <div class="panel">
        <h2>Player Minutes</h2>
        <div class="table-container">
          <table class="stats-table">
            <thead>
              <tr>
                <th>Player</th>
                <th class="text-right">Field Time</th>
                <th class="text-right">Bench Time</th>
              </tr>
            </thead>
            <tbody>
              {#each boxScore as p}
                <tr>
                  <td>
                    <span class="muted small mr-1">#{p.number}</span> 
                    <strong>{p.name}</strong>
                  </td>
                  <td class="text-right text-green">{formatDuration(p.activeMs)}</td>
                  <td class="text-right text-muted">{formatDuration(p.benchMs)}</td>
                </tr>
              {/each}
              {#if boxScore.length === 0}
                <tr><td colspan="3" class="text-center text-muted">No players assigned to this game.</td></tr>
              {/if}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Match Timeline -->
      <div class="panel">
        <h2>Match Timeline</h2>
        <div class="timeline">
          {#each sortedHistory as ev}
            <div class="timeline-item">
              <div class="time-marker">{formatDuration(ev.gameTimeMs)}</div>
              <div class="event-content">
                <strong class="event-title" 
                  class:text-green={ev.event === 'Goal (Us)'}
                  class:text-red={ev.event === 'Goal Conceded' || ev.event === 'Red Card'}
                  class:text-yellow={ev.event === 'Yellow Card'}
                >
                  {ev.event}
                </strong>
                
                {#if ev.playerId}
                  <div class="event-player">{getPlayerName(ev.playerId)}</div>
                {/if}
                
                {#if ev.assistId}
                  <div class="event-details text-muted">Assist: {getPlayerName(ev.assistId)}</div>
                {/if}
                
                {#if ev.event === 'Lineup Applied' || ev.event === 'Substitution'}
                  <div class="event-details text-muted small">Tactical/Sub Change</div>
                {/if}
              </div>
            </div>
          {/each}
          
          {#if sortedHistory.length === 0}
            <p class="text-muted text-center" style="padding: 2rem 0;">No events recorded yet. Start the Live Tracker to log events.</p>
          {/if}
        </div>
      </div>

    </div>
  </div>
{/if}

<style>
  /* Base Dashboard Layout */
  .dashboard-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #334155; padding-bottom: 1rem; margin-bottom: 2rem; flex-wrap: wrap; gap: 1rem; }
  .back-link { color: #3b82f6; text-decoration: none; font-size: 0.9rem; }
  h1 { margin: 0.5rem 0 0 0; color: #f8fafc; }
  .muted, .text-muted { color: #94a3b8; }
  .score-badge { display: inline-block; background: #2563eb; color: white; padding: 0.2rem 0.6rem; border-radius: 0.5rem; font-weight: bold; margin-left: 0.5rem; font-size: 0.9rem;}

  .header-actions { display: flex; gap: 1rem; align-items: center; flex-wrap: wrap;}
  
  .btn-secondary { background: #334155; color: white; border: none; padding: 0.85rem 1.2rem; border-radius: 0.75rem; font-weight: bold; cursor: pointer; transition: background 0.2s;}
  .btn-secondary:hover { background: #475569; }

  .btn-live { background: #10b981; color: white; text-decoration: none; padding: 0.85rem 1.5rem; border-radius: 0.75rem; font-weight: bold; display: flex; align-items: center; gap: 0.75rem; transition: transform 0.2s; }
  .btn-live:hover { transform: translateY(-2px); }
  
  .pulse-dot { width: 10px; height: 10px; background: white; border-radius: 50%; animation: pulse 2s infinite; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(255, 255, 255, 0.7); } 70% { box-shadow: 0 0 0 8px rgba(255, 255, 255, 0); } 100% { box-shadow: 0 0 0 0 rgba(255, 255, 255, 0); } }

  .grid-layout, .stats-grid { display: grid; grid-template-columns: 1fr; gap: 1.5rem; margin-bottom: 1.5rem;}
  @media (min-width: 800px) { .grid-layout, .stats-grid { grid-template-columns: 1fr 1fr; align-items: start;} }

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
  .stats-table { width: 100%; border-collapse: collapse; color: #e2e8f0; font-size: 0.95rem;}
  .stats-table th { color: #94a3b8; font-weight: 600; padding: 0.75rem 0.5rem; border-bottom: 2px solid #334155; text-align: left;}
  .stats-table th.text-right { text-align: right; }
  .stats-table td { padding: 0.75rem 0.5rem; border-bottom: 1px solid #1e293b; }
  .stats-table tr:last-child td { border-bottom: none; }

  /* Timeline */
  .timeline { display: flex; flex-direction: column; gap: 1rem; max-height: 400px; overflow-y: auto; padding-right: 0.5rem;}
  .timeline::-webkit-scrollbar { width: 8px; }
  .timeline::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }
  
  .timeline-item { display: flex; gap: 1rem; background: #0f172a; padding: 0.75rem; border-radius: 0.75rem; border-left: 4px solid #3b82f6;}
  .time-marker { font-family: monospace; font-weight: bold; color: #cbd5e1; background: #1e293b; padding: 0.25rem 0.5rem; border-radius: 0.25rem; height: fit-content;}
  .event-content { display: flex; flex-direction: column; gap: 0.1rem; }
  .event-title { font-size: 1rem; }
  .event-player { color: #f8fafc; font-weight: 500;}
</style>