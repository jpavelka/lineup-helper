<script>
  import { page } from '$app/stores';
  import { onMount, onDestroy } from 'svelte';
  import { doc, getDoc, updateDoc } from 'firebase/firestore';
  import { db } from '$lib/firebase/config';
  import { getGroupColor } from '$lib/groupColors.js';

  const gameId = $page.params.gameId;

  let game = null;
  let team = null;
  let formation = null;
  let lineup = {}; 
  
  // UI & Selection State
  let selectedItem = null;
  let pitchView = false;
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

    if (!payload) {
      if (targetType === 'slot') {
        newLineup[targetId] = null;
      }
    } else if (payload.type === 'bench' && targetType === 'slot') {
      // Direction: Player -> Position
      newLineup[targetId] = payload.id;
    } 
    else if (payload.type === 'slot' && targetType === 'bench') {
      // Direction: Position -> Player
      newLineup[payload.id] = targetId;
    }
    else if (payload.type === 'slot' && targetType === 'slot') {
      // Direction: Position -> Position (Swap)
      const temp = newLineup[payload.id];
      newLineup[payload.id] = newLineup[targetId];
      newLineup[targetId] = temp;
    } 

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
      <a href="/games/{gameId}" class="back-link">← Dashboard</a>
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
      <div class="pitch-header">
        <h2>On Field</h2>
        <div class="view-toggle">
          <button class:active={!pitchView} on:click={() => pitchView = false}>List</button>
          <button class:active={pitchView} on:click={() => pitchView = true}>Field</button>
        </div>
      </div>

      {#if pitchView}
        <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
        <div class="field-wrap" on:click|self={() => selectedItem = null}>
          <div class="field-container">
            <div class="field-lines">
              <div class="center-circle"></div>
              <div class="penalty-arc top"></div>
              <div class="penalty-arc bottom"></div>
              <div class="penalty-box top"></div>
              <div class="penalty-box bottom"></div>
              <div class="goal-box top"></div>
              <div class="goal-box bottom"></div>
            </div>
            {#each formation?.positions || [] as pos}
              {@const color = getGroupColor(pos.group)}
              <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
              <div
                class="field-pos"
                class:selected={selectedItem?.type === 'slot' && selectedItem?.id === pos.id}
                class:empty={!lineup[pos.id]}
                style="left: {pos.x}%; top: {pos.y}%;"
                on:click|stopPropagation={() => handleSlotClick(pos.id)}
              >
                <div class="field-node" style="background: {color.bg}; border-color: {color.bg};">{pos.name}</div>
                <div class="field-node-label">{lineup[pos.id] ? getPlayerName(lineup[pos.id]) : '—'}</div>
                {#if lineup[pos.id]}
                  <div class="field-node-time">{getPlayerLiveStats(lineup[pos.id]).active}</div>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {:else}
        <div class="slots-container">
          {#each formation?.positions || [] as pos}
            {@const color = getGroupColor(pos.group)}
            <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
            <div class="slot-card"
                 class:selected={selectedItem?.type === 'slot' && selectedItem?.id === pos.id}
                 class:empty={!lineup[pos.id]}
                 on:click={() => handleSlotClick(pos.id)}>

              <div class="pos-badge" style="background: {color.bg}; color: {color.text};">{pos.name}</div>

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
      {/if}
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
  
  .match-overview { display: flex; align-items: center; gap: 1.5rem; }
  .back-link { color: #3b82f6; text-decoration: none; font-size: 0.9rem; font-weight: bold; }
  .back-link:hover { text-decoration: underline; }
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

  .layout-grid { 
    display: flex;
    flex-direction: column;
    gap: 1rem;
    height: calc(100vh - 200px); /* Account for match header */
  }

  .panel { 
    background: #111827; 
    border: 1px solid #334155; 
    border-radius: 1rem; 
    padding: 1rem; 
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .pitch-panel { flex: 1.2; }
  .bench-panel { flex: 1; }

  h2 { margin-top: 0; font-size: 1rem; color: #cbd5e1; border-bottom: 1px solid #334155; padding-bottom: 0.5rem; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.75rem; }

  .slots-container, .bench-container { 
    overflow-y: auto; 
    flex: 1;
    padding-right: 0.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  /* Custom Scrollbars */
  .slots-container::-webkit-scrollbar, .bench-container::-webkit-scrollbar { width: 4px; }
  .slots-container::-webkit-scrollbar-track, .bench-container::-webkit-scrollbar-track { background: #0f172a; }
  .slots-container::-webkit-scrollbar-thumb, .bench-container::-webkit-scrollbar-thumb { background: #334155; border-radius: 2px; }

  /* Compact grid for slots on mobile */
  .slots-container {
    display: grid;
  }

  .slot-card, .bench-card {
    display: flex; align-items: center; gap: 0.5rem;
    background: #1e293b; border: 2px solid transparent; border-radius: 0.5rem; padding: 0.5rem 0.75rem;
    cursor: pointer; transition: all 0.1s;
    min-height: 50px;
  }
  .slot-card.empty { border: 1px dashed #475569; background: #0f172a; }
  .slot-card.selected, .bench-card.selected { border-color: #3b82f6; background: rgba(59, 130, 246, 0.15); box-shadow: 0 0 10px rgba(59, 130, 246, 0.3);}
  
  .pos-badge { background: #334155; padding: 0.1rem 0.4rem; border-radius: 0.25rem; font-weight: bold; font-size: 0.75rem; min-width: 40px; text-align: center; color: #94a3b8; }
  
  .player-info { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
  .player-name { font-size: 0.9rem; font-weight: 600; color: #f8fafc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .player-time { font-size: 0.7rem; font-weight: 500; margin-top: 0.05rem;}
  .active-color { color: #34d399; }
  .bench-color { color: #94a3b8; }

  .btn-remove { background: #7f1d1d; color: white; width: 22px; height: 22px; border-radius: 50%; padding: 0; font-size: 0.8rem; }

  @media (min-width: 800px) { 
    .layout-grid { display: grid; grid-template-columns: 1.5fr 1fr; height: auto; } 
    .pitch-panel, .bench-panel { flex: none; height: auto; }
    .slots-container, .bench-container { overflow-y: visible; height: auto; display: flex; flex-direction: column; }
    .slots-container { display: flex; }
    .panel { padding: 1.5rem; overflow: visible; }
    h2 { font-size: 1.2rem; }
    .player-name { font-size: 1.1rem; }
    .player-time { font-size: 0.8rem; }
    .pos-badge { font-size: 0.9rem; padding: 0.25rem 0.5rem; }
    .btn-remove { width: 28px; height: 28px; font-size: 1rem; }
  }

  /* Pitch header with toggle */
  .pitch-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #334155; padding-bottom: 0.5rem; margin-bottom: 0.75rem; }
  .pitch-header h2 { margin: 0; border: none; padding: 0; }
  .view-toggle { display: flex; background: #0f172a; border-radius: 0.4rem; padding: 0.15rem; }
  .view-toggle button { background: transparent; border: none; color: #64748b; padding: 0.25rem 0.6rem; border-radius: 0.3rem; cursor: pointer; font-size: 0.75rem; font-weight: 600; }
  .view-toggle button.active { background: #334155; color: #f8fafc; }

  /* Field View */
  .field-wrap { flex: 1; display: flex; justify-content: center; padding: 0.5rem 0; overflow: auto; }
  .field-container { position: relative; width: 100%; max-width: 280px; aspect-ratio: 2 / 3; background: #14532d; border: 2px solid rgba(255,255,255,0.4); border-radius: 6px; flex-shrink: 0; }
  .field-lines { position: absolute; inset: 0; pointer-events: none; }
  .field-lines::before { content: ''; position: absolute; top: 50%; left: 0; right: 0; height: 1px; background: rgba(255,255,255,0.4); }
  .center-circle { position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); width: 22%; aspect-ratio: 1; border: 1px solid rgba(255,255,255,0.4); border-radius: 50%; }
  .penalty-box { position: absolute; width: 50%; height: 15%; border: 1px solid rgba(255,255,255,0.4); left: 25%; }
  .penalty-box.top { top: 0; border-top: none; }
  .penalty-box.bottom { bottom: 0; border-bottom: none; }
  .goal-box { position: absolute; width: 25%; height: 5%; border: 1px solid rgba(255,255,255,0.4); left: 37.5%; }
  .goal-box.top { top: 0; border-top: none; }
  .goal-box.bottom { bottom: 0; border-bottom: none; }
  .penalty-arc { position: absolute; width: 22%; aspect-ratio: 1; border: 1px solid rgba(255,255,255,0.4); border-radius: 50%; left: 39%; }
  .penalty-arc.top { top: 11%; transform: translateY(-50%); clip-path: inset(74% 0 0 0); }
  .penalty-arc.bottom { bottom: 11%; transform: translateY(50%); clip-path: inset(0 0 74% 0); }

  .field-pos { position: absolute; transform: translate(-50%,-50%); display: flex; flex-direction: column; align-items: center; cursor: pointer; z-index: 1; }
  .field-node { width: 2.1rem; height: 2.1rem; border-radius: 50%; border: 2px solid rgba(255,255,255,0.3); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.6rem; color: white; box-shadow: 0 2px 6px rgba(0,0,0,0.5); transition: all 0.15s; }
  .field-pos.selected .field-node { border-color: white; box-shadow: 0 0 0 3px rgba(59,130,246,0.8), 0 2px 6px rgba(0,0,0,0.5); transform: scale(1.15); }
  .field-pos.empty .field-node { background: #1e293b !important; border: 2px dashed #475569 !important; }
  .field-node-label { font-size: 0.58rem; color: #f1f5f9; text-shadow: 0 1px 3px rgba(0,0,0,0.9); margin-top: 0.1rem; max-width: 3.5rem; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; line-height: 1.2; }
  .field-node-time { font-size: 0.52rem; color: #34d399; font-weight: 700; line-height: 1.2; }

  @media (min-width: 800px) {
    .field-container { max-width: 320px; }
    .field-node { width: 2.6rem; height: 2.6rem; font-size: 0.7rem; }
    .field-node-label { font-size: 0.65rem; max-width: 4.5rem; }
    .field-node-time { font-size: 0.6rem; }
  }

  /* Modal */
  .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.8); display: flex; justify-content: center; align-items: center; z-index: 100;}
  .modal-panel { background: #111827; padding: 2rem; border-radius: 1rem; border: 1px solid #334155; width: 100%; max-width: 400px; }
  .form-group { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1rem; }
  .form-group label { color: #cbd5e1; font-size: 0.9rem; }
  .form-group select { background: #0f172a; border: 1px solid #334155; color: white; padding: 0.75rem; border-radius: 0.5rem; font-size: 1rem; outline: none; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 1rem; margin-top: 1.5rem; }
</style>