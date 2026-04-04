<script>
  import { page } from '$app/stores';
  import { onMount, onDestroy } from 'svelte';
  import { doc, getDoc, updateDoc } from 'firebase/firestore';
  import { db } from '$lib/firebase/config';

  const gameId = $page.params.gameId;

  let game = null;
  let team = null;
  let formation = null;
  let lineup = {}; 
  
  // UI & Selection State
  let selectedItem = null; 
  let loading = true;

  // --- Timer State ---
  let now = Date.now();
  let timerInterval;
  let gameLive = false;

  // --- Event Modal State ---
  let showEventModal = false;
  let eventType = 'goal'; // 'goal' | 'card'
  let eventTeam = 'mine'; // 'mine' | 'theirs'
  let eventScorer = '';
  let eventAssist = '';
  let eventCard = 'yellow';
  let eventPlayer = '';

  onMount(async () => {
    // 1. Fetch Data
    const gameSnap = await getDoc(doc(db, 'games', gameId));
    game = { id: gameSnap.id, ...gameSnap.data() };
    
    // Ensure nested objects exist
    if (!game.lineup) game.lineup = {};
    if (!game.history) game.history = [];
    if (!game.playerStats) game.playerStats = {};
    if (!game.gameTimeStats) game.gameTimeStats = { totalMs: 0, sessionStart: null };
    if (!game.score) game.score = { mine: 0, theirs: 0 };
    
    lineup = { ...game.lineup };
    gameLive = game.status === 'live';

    const teamSnap = await getDoc(doc(db, 'teams', game.teamId));
    team = teamSnap.data();

    if (game.formationId) {
      const formSnap = await getDoc(doc(db, 'formations', game.formationId));
      formation = formSnap.data();
    } else {
      formation = { positions: [{id: 'p1', name: 'GK'}, {id: 'p2', name: 'DEF'}, {id: 'p3', name: 'FWD'}] };
    }

    loading = false;

    // Start local UI tick
    timerInterval = setInterval(() => { now = Date.now(); }, 1000);
  });

  onDestroy(() => {
    if (timerInterval) clearInterval(timerInterval);
  });

  // --- Derived State (Reactive) ---
  $: availableRoster = team?.roster.filter(p => game?.availablePlayers.includes(p.id)) || [];
  $: activePlayerIds = Object.values(lineup).filter(id => id !== null);
  $: benchPlayers = availableRoster.filter(p => !activePlayerIds.includes(p.id));

  // Calculate Live Game Time
  $: liveGameTimeMs = game?.gameTimeStats.totalMs + (gameLive && game.gameTimeStats.sessionStart ? now - game.gameTimeStats.sessionStart : 0);

  // Calculate Live Player Minutes
  $: livePlayerStats = availableRoster.map(player => {
    const base = game?.playerStats[player.id] || { activeMs: 0, benchMs: 0 };
    let currentActive = base.activeMs;
    let currentBench = base.benchMs;

    // Add uncommitted time if game is live
    if (gameLive && game?.gameTimeStats.sessionStart) {
      const elapsed = Math.max(0, now - game.gameTimeStats.sessionStart);
      if (activePlayerIds.includes(player.id)) currentActive += elapsed;
      else currentBench += elapsed;
    }

    return { ...player, activeMs: currentActive, benchMs: currentBench };
  });

  // --- Time Logic ---
  
  function formatDuration(ms) {
    if (!ms) return '0:00';
    const totalSecs = Math.floor(ms / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  function commitTime() {
    if (!gameLive || !game.gameTimeStats.sessionStart) return;
    const elapsed = Date.now() - game.gameTimeStats.sessionStart;
    
    // Update global game clock
    game.gameTimeStats.totalMs += elapsed;
    game.gameTimeStats.sessionStart = Date.now(); // Reset for next tick

    // Update player clocks based on CURRENT lineup (before any subs happen)
    availableRoster.forEach(p => {
      if (!game.playerStats[p.id]) game.playerStats[p.id] = { activeMs: 0, benchMs: 0 };
      if (activePlayerIds.includes(p.id)) game.playerStats[p.id].activeMs += elapsed;
      else game.playerStats[p.id].benchMs += elapsed;
    });
  }

  async function toggleLive() {
    if (gameLive) {
      commitTime();
      game.gameTimeStats.sessionStart = null;
      game.status = 'paused';
      gameLive = false;
      game.history.push({ event: 'Game Paused', timestamp: Date.now(), gameTimeMs: game.gameTimeStats.totalMs });
    } else {
      game.gameTimeStats.sessionStart = Date.now();
      game.status = 'live';
      gameLive = true;
      game.history.push({ event: 'Game Started/Resumed', timestamp: Date.now(), gameTimeMs: game.gameTimeStats.totalMs });
    }
    await syncToDb();
  }

  // --- Sub Logic ---

  function handleSlotClick(posId) {
    if (selectedItem) executeSwap('slot', posId);
    else selectedItem = { type: 'slot', id: posId };
  }

  function handleBenchClick(playerId) {
    if (selectedItem) executeSwap('bench', playerId);
    else selectedItem = { type: 'bench', id: playerId };
  }

  function executeSwap(targetType, targetId) {
    const payload = selectedItem;
    let newLineup = { ...lineup };

    if (payload.type === 'bench' && targetType === 'slot') newLineup[targetId] = payload.id;
    else if (payload.type === 'slot' && targetType === 'slot') {
      newLineup[payload.id] = lineup[targetId];
      newLineup[targetId] = lineup[payload.id];
    } 
    else if (payload.type === 'slot' && targetType === 'bench') newLineup[payload.id] = null;

    lineup = newLineup;
    selectedItem = null;
  }

  async function applyLineup() {
    commitTime(); // Credit players for time played BEFORE the sub
    
    game.lineup = lineup;
    game.history.push({
      event: 'Substitution',
      timestamp: Date.now(),
      gameTimeMs: game.gameTimeStats.totalMs,
      lineupSnapshot: { ...lineup }
    });

    await syncToDb();
  }

  // --- Event Logic (Goals/Cards) ---

  async function saveEvent() {
    commitTime(); // Credit time up to the event

    const eventObj = {
      timestamp: Date.now(),
      gameTimeMs: game.gameTimeStats.totalMs,
      type: eventType
    };

    if (eventType === 'goal') {
      if (eventTeam === 'mine') {
        game.score.mine += 1;
        eventObj.event = 'Goal (Us)';
        eventObj.playerId = eventScorer;
        eventObj.assistId = eventAssist;
      } else {
        game.score.theirs += 1;
        eventObj.event = 'Goal Conceded';
      }
    } else if (eventType === 'card') {
      eventObj.event = eventCard === 'yellow' ? 'Yellow Card' : 'Red Card';
      eventObj.playerId = eventPlayer;
    }

    game.history.push(eventObj);
    showEventModal = false;
    await syncToDb();
  }

  async function syncToDb() {
    try {
      await updateDoc(doc(db, 'games', gameId), {
        status: game.status,
        lineup: game.lineup,
        history: game.history,
        playerStats: game.playerStats,
        gameTimeStats: game.gameTimeStats,
        score: game.score
      });
    } catch (error) {
      console.error("Firebase Sync Error:", error);
    }
  }

  // --- Helpers ---
  function getPlayerName(playerId) {
    if (!playerId) return 'Empty';
    const player = availableRoster.find(p => p.id === playerId);
    return player ? player.name : 'Unknown';
  }

  function getPlayerLiveStats(playerId) {
    const p = livePlayerStats.find(p => p.id === playerId);
    return p ? { active: formatDuration(p.activeMs), bench: formatDuration(p.benchMs) } : { active: '0:00', bench: '0:00' };
  }
</script>

{#if loading}
  <div class="loading">Loading Live Editor...</div>
{:else}
  <!-- MATCH HEADER: SCORE & CLOCK -->
  <header class="live-header">
    <div class="match-overview">
      <div class="scoreboard">
        <span class="score">{game.score.mine}</span>
        <span class="divider">-</span>
        <span class="score">{game.score.theirs}</span>
      </div>
      <div class="clock-display">
        <span class="time">{formatDuration(liveGameTimeMs)}</span>
        <span class="status-badge" class:live={gameLive}>{gameLive ? 'LIVE' : 'PAUSED'}</span>
      </div>
    </div>
    
    <div class="match-actions">
      <button class="btn-secondary" on:click={() => showEventModal = true}>+ Add Event</button>
      <button class="btn-live {gameLive ? 'stop' : 'start'}" on:click={toggleLive}>
        {gameLive ? 'Pause Match' : 'Start Match'}
      </button>
      <button class="btn-primary" on:click={applyLineup}>Apply Subs</button>
    </div>
  </header>

  <!-- PITCH & BENCH LAYOUT -->
  <div class="layout-grid">
    
    <div class="panel pitch-panel">
      <h2>On Field</h2>
      <div class="slots-container">
        {#each formation?.positions || [] as pos}
          <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
          <div class="slot-card"
               class:selected={selectedItem?.type === 'slot' && selectedItem?.id === pos.id}
               class:empty={!lineup[pos.id]}
               on:click={() => handleSlotClick(pos.id)}>
            
            <div class="pos-badge">{pos.name}</div>
            
            <div class="player-info">
              <span class="player-name">{getPlayerName(lineup[pos.id])}</span>
              {#if lineup[pos.id]}
                <span class="player-time active-color">Field: {getPlayerLiveStats(lineup[pos.id]).active}</span>
              {/if}
            </div>
            
            {#if lineup[pos.id]}
              <button class="btn-remove" on:click|stopPropagation={() => executeSwap('slot', pos.id)}>×</button>
            {/if}
          </div>
        {/each}
      </div>
    </div>

    <div class="panel bench-panel">
      <h2>Bench</h2>
      <div class="bench-container">
        {#each benchPlayers as player}
          <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
          <div class="bench-card"
               class:selected={selectedItem?.type === 'bench' && selectedItem?.id === player.id}
               on:click={() => handleBenchClick(player.id)}>
            <div class="player-info">
              <span class="player-name">#{player.number} {player.name}</span>
              <span class="player-time bench-color">Bench: {getPlayerLiveStats(player.id).bench}</span>
            </div>
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}

<!-- EVENT MODAL -->
{#if showEventModal}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="modal-backdrop" on:click={() => showEventModal = false}>
    <div class="modal-panel" on:click|stopPropagation>
      <h2>Add Match Event</h2>

      <div class="form-group">
        <label>Event Type</label>
        <select bind:value={eventType}>
          <option value="goal">Goal</option>
          <option value="card">Booking (Card)</option>
        </select>
      </div>

      {#if eventType === 'goal'}
        <div class="form-group">
          <label>Team</label>
          <select bind:value={eventTeam}>
            <option value="mine">Our Team</option>
            <option value="theirs">Opponent</option>
          </select>
        </div>
        {#if eventTeam === 'mine'}
          <div class="form-group">
            <label>Goal Scorer</label>
            <select bind:value={eventScorer}>
              <option value="">-- Select Player --</option>
              {#each availableRoster as p}<option value={p.id}>{p.name}</option>{/each}
            </select>
          </div>
          <div class="form-group">
            <label>Assist (Optional)</label>
            <select bind:value={eventAssist}>
              <option value="">-- None --</option>
              {#each availableRoster as p}<option value={p.id}>{p.name}</option>{/each}
            </select>
          </div>
        {/if}
      {:else}
        <div class="form-group">
          <label>Card Type</label>
          <select bind:value={eventCard}>
            <option value="yellow">Yellow Card</option>
            <option value="red">Red Card</option>
          </select>
        </div>
        <div class="form-group">
          <label>Player</label>
          <select bind:value={eventPlayer}>
            <option value="">-- Select Player --</option>
            {#each availableRoster as p}<option value={p.id}>{p.name}</option>{/each}
          </select>
        </div>
      {/if}

      <div class="modal-actions">
        <button class="btn-secondary" on:click={() => showEventModal = false}>Cancel</button>
        <button class="btn-primary" on:click={saveEvent}>Save Event</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .live-header {
    display: flex; justify-content: space-between; align-items: center;
    background: #111827; padding: 1rem 1.5rem; border-radius: 1rem; border: 1px solid #334155; margin-bottom: 1.5rem; flex-wrap: wrap; gap: 1rem;
  }
  
  .match-overview { display: flex; align-items: center; gap: 2rem; }
  .scoreboard { background: #000; padding: 0.5rem 1rem; border-radius: 0.5rem; display: flex; gap: 0.75rem; font-family: monospace; font-size: 1.75rem; font-weight: bold; }
  .divider { color: #475569; }
  
  .clock-display { display: flex; flex-direction: column; align-items: flex-start; gap: 0.25rem; }
  .time { font-size: 1.5rem; font-weight: bold; font-variant-numeric: tabular-nums; }
  .status-badge { padding: 0.1rem 0.5rem; border-radius: 1rem; background: #475569; font-size: 0.75rem; font-weight: bold; letter-spacing: 1px;}
  .status-badge.live { background: #ef4444; color: white; animation: blink 2s infinite; }
  
  @keyframes blink { 50% { opacity: 0.6; } }

  .match-actions { display: flex; gap: 0.5rem; flex-wrap: wrap;}
  button { border: none; padding: 0.75rem 1.25rem; border-radius: 0.5rem; font-weight: bold; cursor: pointer; color: white;}
  .btn-live.start { background: #10b981; }
  .btn-live.stop { background: #f59e0b; }
  .btn-primary { background: #3b82f6; }
  .btn-secondary { background: #334155; }

  .layout-grid { display: grid; grid-template-columns: 1fr; gap: 1.5rem; }
  @media (min-width: 800px) { .layout-grid { grid-template-columns: 1.5fr 1fr; align-items: start; } }

  .panel { background: #111827; border: 1px solid #334155; border-radius: 1rem; padding: 1.5rem; }
  h2 { margin-top: 0; font-size: 1.2rem; color: #cbd5e1; border-bottom: 1px solid #334155; padding-bottom: 0.5rem;}

  .slots-container, .bench-container { display: flex; flex-direction: column; gap: 0.5rem; }
  
  .slot-card, .bench-card {
    display: flex; align-items: center; gap: 1rem;
    background: #1e293b; border: 2px solid transparent; border-radius: 0.5rem; padding: 0.75rem;
    cursor: pointer; transition: all 0.1s;
  }
  .slot-card.empty { border: 1px dashed #475569; background: #0f172a; }
  .slot-card.selected, .bench-card.selected { border-color: #3b82f6; background: rgba(59, 130, 246, 0.15); box-shadow: 0 0 10px rgba(59, 130, 246, 0.3);}
  
  .pos-badge { background: #334155; padding: 0.25rem 0.5rem; border-radius: 0.25rem; font-weight: bold; font-size: 0.9rem; min-width: 50px; text-align: center;}
  
  .player-info { display: flex; flex-direction: column; flex: 1; }
  .player-name { font-size: 1.1rem; font-weight: 600; color: #f8fafc; }
  .player-time { font-size: 0.8rem; font-weight: 500; margin-top: 0.1rem;}
  .active-color { color: #34d399; }
  .bench-color { color: #94a3b8; }

  .btn-remove { background: #7f1d1d; color: white; width: 28px; height: 28px; border-radius: 50%; padding: 0; }

  /* Modal */
  .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.8); display: flex; justify-content: center; align-items: center; z-index: 100;}
  .modal-panel { background: #111827; padding: 2rem; border-radius: 1rem; border: 1px solid #334155; width: 100%; max-width: 400px; }
  .form-group { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1rem; }
  .form-group label { color: #cbd5e1; font-size: 0.9rem; }
  .form-group select { background: #0f172a; border: 1px solid #334155; color: white; padding: 0.75rem; border-radius: 0.5rem; font-size: 1rem; outline: none; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 1rem; margin-top: 1.5rem; }
</style>