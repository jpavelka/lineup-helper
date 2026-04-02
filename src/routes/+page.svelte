<script>
  import { onMount } from 'svelte';
  import { flip } from 'svelte/animate';

  const STORAGE_KEY = 'lineup-helper-state';

  const defaultState = {
    roster: [],
    positions: [],
    lineup: {},
    history: [],
    playerTimeStats: {}, 
    gameTimeStats: { total: 0, sessionStart: null },
    gameStartedAt: null,
    gameLive: false,
    gameName: ''
  };

  let roster = [];
  let positions = [];
  let lineup = {};
  let history = [];
  let playerTimeStats = {};
  let gameTimeStats = { total: 0, sessionStart: null };
  let gameStartedAt = null;
  let gameLive = false;
  let gameName = '';
  
  let newPlayerName = '';
  let newPositionName = '';
  let snapshotName = '';
  let showManager = false;
  let managerTab = 'roster';
  let selectedItem = null;
  let touchDrag = null;
  let draggedPosId = null;
  let lineupRosterSort = 'name'; 
  let now = Date.now(); 

  function loadState() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        const data = JSON.parse(raw);
        roster = roster = (data.roster ?? defaultState.roster).map(p => ({
          ...p,
          available: p.available !== false // defaults to true for existing players
        }));
        positions = data.positions ?? defaultState.positions;
        lineup = data.lineup ?? defaultState.lineup;
        history = data.history ?? [];
        gameStartedAt = data.gameStartedAt ?? defaultState.gameStartedAt;
        gameLive = data.gameLive ?? defaultState.gameLive;
        gameTimeStats = data.gameTimeStats ?? { total: 0, sessionStart: null };
        gameName = data.gameName ?? defaultState.gameName;
        
        playerTimeStats = data.playerTimeStats ?? {};
        
        for (let id in playerTimeStats) {
          const stat = playerTimeStats[id];
          if (stat.total !== undefined) {
            stat.activeTotal = stat.total;
            delete stat.total;
          }
          if (stat.benchTotal === undefined) stat.benchTotal = 0;
          if (stat.stintActiveTotal === undefined) stat.stintActiveTotal = stat.activeTotal || 0;
          if (stat.stintBenchTotal === undefined) stat.stintBenchTotal = stat.benchTotal || 0;
        }
      } catch {
        Object.assign(this, defaultState);
      }
    } else {
      Object.assign(this, defaultState);
    }
    ensureLineupSlots();
    resumeTracking(); 
  }

  function saveState() {
    const state = { roster, positions, lineup, history, playerTimeStats, gameTimeStats, gameStartedAt, gameLive, gameName };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  $: lastSavedLineup = history[0]?.lineup ?? {};
  $: lastSavedRoster = history[0]?.roster ?? [];

  function commitTime() {
    const currentTime = Date.now();
    
    // Commit game time
    if (gameTimeStats.sessionStart) {
      gameTimeStats.total += currentTime - gameTimeStats.sessionStart;
      gameTimeStats.sessionStart = null;
    }

    // Commit player times based on the LAST SAVED lineup (the "live" state)
    const activeIds = new Set(Object.values(lastSavedLineup).filter(Boolean));
    for (const id in playerTimeStats) {
      const stats = playerTimeStats[id];
      if (stats && stats.sessionStart) {
        const elapsed = currentTime - stats.sessionStart;
        if (activeIds.has(id)) {
          stats.activeTotal += elapsed;
          stats.stintActiveTotal += elapsed;
        } else {
          stats.benchTotal += elapsed;
          stats.stintBenchTotal += elapsed;
        }
        stats.sessionStart = null;
      }
    }
    playerTimeStats = { ...playerTimeStats };
  }

  function resumeTracking() {
    const currentTime = Date.now();

    if (gameLive && !gameTimeStats.sessionStart) {
      gameTimeStats.sessionStart = currentTime;
    }

    roster.forEach(player => {
      if (!playerTimeStats[player.id]) {
        playerTimeStats[player.id] = { activeTotal: 0, benchTotal: 0, stintActiveTotal: 0, stintBenchTotal: 0, sessionStart: null };
      }
    });

    if (gameLive) {
      roster.forEach(player => {
        if (playerTimeStats[player.id] && !playerTimeStats[player.id].sessionStart) {
          playerTimeStats[player.id].sessionStart = currentTime;
        }
      });
    }

    playerTimeStats = { ...playerTimeStats };
  }

  // Purely updates the DRAFT lineup, without affecting ticking times
  function updateLineup(newLineup) {
    lineup = newLineup;
    saveState();
  }

  function saveCurrentLineup() {
    if (!gameStartedAt) {
      alert("The first lineup will be applied when the 'Start game' button is pressed.");
      return;
    }

    const hasEmpty = positions.some(p => !lineup[p.id]);
    if (hasEmpty) {
      const proceed = confirm("One or more positions are empty. Are you sure you want to apply this lineup?");
      if (!proceed) return;
    } else {
      const proceed = confirm("Are you sure you want to apply this lineup?");
      if (!proceed) return;
    }

    // Lock in times up to this exact moment using the OLD active lineup
    commitTime(); 

    const oldActiveIds = new Set(Object.values(lastSavedLineup).filter(Boolean));
    const newActiveIds = new Set(Object.values(lineup).filter(Boolean));

    // Calculate subbed in/out stints
    roster.forEach(player => {
      const id = player.id;
      if (!playerTimeStats[id]) return;
      const wasActive = oldActiveIds.has(id);
      const isActive = newActiveIds.has(id);
      
      // If a player swapped states (Field to Bench, or Bench to Field) reset BOTH stint timers to 0
      if (wasActive !== isActive) {
        playerTimeStats[id].stintBenchTotal = 0;
        playerTimeStats[id].stintActiveTotal = 0;
      }
    });

    const label = snapshotName.trim() || 'Lineup snapshot';
    const entry = {
      id: uniqueId('history'),
      label,
      created: new Date().toISOString(),
      lineup: JSON.parse(JSON.stringify(lineup)),
      positions: JSON.parse(JSON.stringify(positions)),
      roster: JSON.parse(JSON.stringify(roster))
    };
    history = [entry, ...history];
    snapshotName = '';
    
    // Start timers again based on the NEW active lineup we just saved
    resumeTracking(); 
    saveState();
  }

  function recordGameEvent(label) {
    const activeLineup = history.length > 0 ? history[0].lineup : lineup; 
    const entry = {
      id: uniqueId('history'),
      label,
      created: new Date().toISOString(),
      lineup: JSON.parse(JSON.stringify(activeLineup)),
      positions: JSON.parse(JSON.stringify(positions)),
      roster: JSON.parse(JSON.stringify(roster))
    };
    history = [entry, ...history];
    saveState();
  }

  function ensureLineupSlots() {
    positions.forEach((position) => {
      if (!(position.id in lineup)) lineup[position.id] = null;
    });
    const validRosterIds = new Set(roster.map((player) => player.id));
    Object.keys(lineup).forEach((posId) => {
      if (lineup[posId] && !validRosterIds.has(lineup[posId])) lineup[posId] = null;
    });
  }

  function startGame() {
    const hasEmpty = positions.some(p => !lineup[p.id]);
    if (hasEmpty) {
      const proceed = confirm("One or more positions are empty. Are you sure you want to start the game with this lineup?");
      if (!proceed) return;
    }

    commitTime();
    
    // Set up new game tracking state
    gameStartedAt = Date.now();
    gameTimeStats = { total: 0, sessionStart: null };
    for (let id in playerTimeStats) {
      playerTimeStats[id] = { activeTotal: 0, benchTotal: 0, stintActiveTotal: 0, stintBenchTotal: 0, sessionStart: null };
    }
    
    // Apply the currently staged lineup to history with the label "Game started"
    const entry = {
      id: uniqueId('history'),
      label: 'Game started',
      created: new Date().toISOString(),
      lineup: JSON.parse(JSON.stringify(lineup)),
      positions: JSON.parse(JSON.stringify(positions)),
      roster: JSON.parse(JSON.stringify(roster))
    };
    history = [entry, ...history];
    
    gameLive = true;
    resumeTracking();
    saveState();
  }

  function toggleGameLive() {
    if (!gameStartedAt) return;
    commitTime();
    gameLive = !gameLive;
    resumeTracking();
    recordGameEvent(gameLive ? 'Game resumed' : 'Game paused');
  }

  function endGame() {
    commitTime();
    gameStartedAt = null;
    gameLive = false;
    resumeTracking();
    recordGameEvent('Game stopped');
  }

  function uniqueId(prefix) {
    return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function addPlayer() {
    const name = newPlayerName.trim();
    if (!name) return;
    roster = [...roster, { id: uniqueId('player'), name, available: true }]; // Added available
    newPlayerName = '';
    resumeTracking();
    saveState();
  }

  function updatePlayerName(id, name) {
    roster = roster.map((player) => (player.id === id ? { ...player, name } : player));
    saveState();
  }

  function removePlayer(id) {
    roster = roster.filter((player) => player.id !== id);
    let newLineup = { ...lineup };
    Object.keys(newLineup).forEach(posId => {
      if (newLineup[posId] === id) newLineup[posId] = null;
    });
    delete playerTimeStats[id];
    updateLineup(newLineup);
  }

  function togglePlayerAvailability(id, available) {
    roster = roster.map((player) => (player.id === id ? { ...player, available } : player));
    
    // If marked unavailable, automatically remove them from the draft lineup if they are in it
    if (!available) {
      let newLineup = { ...lineup };
      let changed = false;
      Object.keys(newLineup).forEach(posId => {
        if (newLineup[posId] === id) {
          newLineup[posId] = null;
          changed = true;
        }
      });
      if (changed) updateLineup(newLineup);
    }
    saveState();
  }

  function addPosition() {
    const name = newPositionName.trim();
    if (!name) return;
    const id = uniqueId('position');
    // Added parent property here (defaults to empty string)
    positions = [...positions, { id, name, parent: '' }];
    lineup = { ...lineup, [id]: null };
    newPositionName = '';
    saveState();
  }

  function updatePositionName(id, name) {
    positions = positions.map((position) => (position.id === id ? { ...position, name } : position));
    saveState();
  }

  function updatePositionParent(id, parent) {
    positions = positions.map((position) => (position.id === id ? { ...position, parent } : position));
    saveState();
  }

  function removePosition(id) {
    positions = positions.filter((position) => position.id !== id);
    const { [id]: _, ...rest } = lineup;
    updateLineup(rest);
  }

  function handlePositionSwapRealtime(targetId, srcId) {
    if (!srcId || srcId === targetId) return;
    const srcIdx = positions.findIndex(p => p.id === srcId);
    const targetIdx = positions.findIndex(p => p.id === targetId);
    if (srcIdx < 0 || targetIdx < 0) return;
    
    const newPos = [...positions];
    const [removed] = newPos.splice(srcIdx, 1);
    newPos.splice(targetIdx, 0, removed);
    positions = newPos;
  }

  function onDragStart(event, sourceType, id) {
    event.dataTransfer.setData(`application/x-${sourceType}`, id);
    event.dataTransfer.effectAllowed = 'move';
  }

  function selectItem(sourceType, id) {
    if (selectedItem && selectedItem.sourceType === sourceType && selectedItem.id === id) {
      selectedItem = null;
      return;
    }
    selectedItem = { sourceType, id };
  }

  function setManagerTab(tab) {
    managerTab = tab;
    selectedItem = null;
  }

  function startTouchDrag(event, sourceType, id) {
    if (event.pointerType !== 'touch') return;
    if (sourceType === 'position') {
      event.preventDefault(); 
      event.stopPropagation();
    }
    touchDrag = { sourceType, id };
  }

  function cancelTouchDrag() {
    touchDrag = null;
    if (draggedPosId) draggedPosId = null;
  }

  function handleTouchMove(event) {
    if (!touchDrag) return;
    if (touchDrag.sourceType === 'position') {
      event.preventDefault(); 
      const x = event.touches[0].clientX;
      const y = event.touches[0].clientY;
      const targetElement = document.elementFromPoint(x, y);
      const dropLi = targetElement?.closest('[data-position-id]');
      if (dropLi) {
        handlePositionSwapRealtime(dropLi.dataset.positionId, touchDrag.id);
      }
    }
  }

  function stopTouchDrag(event) {
    if (!touchDrag) return;
    
    if (touchDrag.sourceType === 'position') {
      saveState(); 
    } else {
      let x = event.clientX;
      let y = event.clientY;
      if (event.type === 'touchend' && event.changedTouches?.length) {
        x = event.changedTouches[0].clientX;
        y = event.changedTouches[0].clientY;
      }
      const targetElement = document.elementFromPoint(x, y);
      const dropTarget = targetElement?.closest('[data-drop-target]');
      if (dropTarget) {
        handlePointerDrop(dropTarget.dataset.dropTarget, dropTarget.dataset.dropId ?? null);
      }
    }
    touchDrag = null;
    draggedPosId = null;
  }

  function handlePointerDrop(targetType, targetId) {
    if (!touchDrag) return;
    const payload = touchDrag;

    let newLineup = { ...lineup };
    if (payload.sourceType === 'roster' && targetType === 'slot') {
      newLineup[targetId] = payload.id;
    } else if (payload.sourceType === 'slot' && targetType === 'slot') {
      const sourcePos = payload.id;
      const targetPos = targetId;
      newLineup[sourcePos] = lineup[targetPos];
      newLineup[targetPos] = lineup[sourcePos];
    } else if (payload.sourceType === 'slot' && targetType === 'roster') {
      newLineup[payload.id] = null;
    }
    updateLineup(newLineup);
  }

  function handleTapDrop(targetType, targetId) {
    if (!selectedItem) return;
    const payload = selectedItem;
    selectedItem = null;

    let newLineup = { ...lineup };
    if (payload.sourceType === 'roster' && targetType === 'slot') {
      newLineup[targetId] = payload.id;
    } else if (payload.sourceType === 'slot' && targetType === 'slot') {
      const sourcePos = payload.id;
      const targetPos = targetId;
      newLineup[sourcePos] = lineup[targetPos];
      newLineup[targetPos] = lineup[sourcePos];
    } else if (payload.sourceType === 'slot' && targetType === 'roster') {
      newLineup[payload.id] = null;
    }
    updateLineup(newLineup);
  }

  function handleKeyboardAction(event, callback) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      callback();
    }
  }

  function removeFromLineup(positionId) {
    updateLineup({ ...lineup, [positionId]: null });
  }

  function undoSub(positionId) {
    const prevPlayerId = lastSavedLineup[positionId] || null;
    let newLineup = { ...lineup };
    
    if (prevPlayerId) {
      const existingPos = Object.keys(newLineup).find(pos => newLineup[pos] === prevPlayerId);
      if (existingPos) {
        newLineup[existingPos] = null;
      }
    }
    newLineup[positionId] = prevPlayerId;
    updateLineup(newLineup);
  }

  function handleDrop(event, targetType, targetId) {
    const playerSrcId = event.dataTransfer.getData('application/x-roster');
    const slotSrcId = event.dataTransfer.getData('application/x-slot');
    
    let newLineup = { ...lineup };
    if (playerSrcId && targetType === 'slot') {
      newLineup[targetId] = playerSrcId;
    } else if (slotSrcId && targetType === 'slot') {
      newLineup[slotSrcId] = lineup[targetId];
      newLineup[targetId] = lineup[slotSrcId];
    } else if (slotSrcId && targetType === 'roster') {
      newLineup[slotSrcId] = null;
    }
    if (playerSrcId || slotSrcId) {
      updateLineup(newLineup);
    }
  }

  function getPlayerNameFromRoster(id, rosterList) {
    if (!id) return '';
    const player = rosterList.find((item) => item.id === id);
    return player ? player.name : 'Unknown player';
  }

  function getPlayerStatusText(id, players, desc=false) {
    const p = players.find(p => p.id === id);
    if (!p) return '';
    if (p.inLiveLineup) return `${desc ? 'Field: ' : ''}${formatDuration(p.stintActiveMs)}`;
    return `${desc ? 'Bench: ' : ''}${formatDuration(p.stintBenchMs)}`;
  }

  function formatDuration(durationMs) {
    const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  $: liveGameTime = gameTimeStats.total + (gameLive && gameTimeStats.sessionStart ? now - gameTimeStats.sessionStart : 0);

  $: rosterPlayers = roster.map((player) => {
    const stats = playerTimeStats[player.id];
    let activeSession = 0;
    let benchSession = 0;
    
    // Status strictly based on the LAST SAVED lineup
    const inLiveLineup = Object.values(lastSavedLineup).includes(player.id);
    const inDraftLineup = Object.values(lineup).includes(player.id);

    if (stats && stats.sessionStart && gameLive) {
      const elapsed = Math.max(0, now - stats.sessionStart);
      if (inLiveLineup) activeSession = elapsed;
      else benchSession = elapsed;
    }

    return {
      ...player,
      activeDurationMs: (stats ? stats.activeTotal : 0) + activeSession,
      benchDurationMs: (stats ? stats.benchTotal : 0) + benchSession,
      stintActiveMs: (stats ? stats.stintActiveTotal || 0 : 0) + activeSession,
      stintBenchMs: (stats ? stats.stintBenchTotal || 0 : 0) + benchSession,
      inLiveLineup,
      inDraftLineup
    };
  });

  $: sortedManagerRoster = [...rosterPlayers].sort((a,b) => {
    // Sort available players to the top, then alphabetically
    return a.name.localeCompare(b.name);
  });

  $: sortedLineupRoster = [...rosterPlayers]
    .filter(p => p.available) // HIDE UNAVAILABLE PLAYERS HERE
    .sort((a, b) => {
      if (lineupRosterSort === 'name') {
        return a.name.localeCompare(b.name);
      } else if (lineupRosterSort === 'total') {
        return b.activeDurationMs - a.activeDurationMs;
      } else if (lineupRosterSort === 'stintActive') {
        return (a.stintBenchMs - a.stintActiveMs) - (b.stintBenchMs - b.stintActiveMs);
      } else if (lineupRosterSort === 'stintBench') {
        return (b.stintBenchMs - b.stintActiveMs) - (a.stintBenchMs - a.stintActiveMs);
      }
      return 0;
    });

  function hasSavedDifference(positionId, currentLineup, savedLineup, currentRoster, savedRoster, historyList) {
    if (!historyList || historyList.length === 0) return false;
    const currentName = currentLineup[positionId] ? getPlayerNameFromRoster(currentLineup[positionId], currentRoster) : '';
    const savedName = savedLineup[positionId] ? getPlayerNameFromRoster(savedLineup[positionId], savedRoster) : '';
    return currentName !== savedName;
  }

  function csvEscape(value) {
    const stringValue = String(value ?? '');
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  function exportHistoryCsv() {
    if (!history.length) return;
    const rows = [['Event label', 'Recorded at', 'Position', 'Player name']];
    history.forEach((item) => {
      const createdLabel = new Date(item.created).toLocaleString();
      item.positions.forEach((position) => {
        const playerName = getPlayerNameFromRoster(item.lineup[position.id], item.roster);
        rows.push([item.label, createdLabel, position.name, playerName]);
      });
    });

    const csv = rows.map((row) => row.map(csvEscape).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    
    const safeGameName = gameName.trim() ? gameName.trim().replace(/[^a-z0-9]/gi, '_').toLowerCase() : 'lineup';
    link.setAttribute('download', `${safeGameName}-history.csv`);
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  function recallLineup(entry) {
    const newLineup = JSON.parse(JSON.stringify(entry.lineup));
    positions = JSON.parse(JSON.stringify(entry.positions));
    roster = JSON.parse(JSON.stringify(entry.roster));
    updateLineup(newLineup);
    ensureLineupSlots();
    saveState();
  }

  function removeHistoryItem(id) {
    history = history.filter((item) => item.id !== id);
    saveState();
  }

  function clearEvents() {
    const proceed = confirm('Are you sure you want to remove all history items, reset all timers to 0, and end the current game?');
    if (proceed) {
      // 1. Clear history entirely
      history = [];
      
      // 2. Reset all timers
      gameTimeStats = { total: 0, sessionStart: null };
      for (let id in playerTimeStats) {
        playerTimeStats[id] = {
          activeTotal: 0,
          benchTotal: 0,
          stintActiveTotal: 0,
          stintBenchTotal: 0,
          sessionStart: null
        };
      }
      
      // 3. End the game
      gameStartedAt = null;
      gameLive = false;
      gameName = ''; // Optional: clear the game name for next time
      
      // 4. Save the reset state
      saveState();
    }
  }

  onMount(() => {
    loadState();
    const timer = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => clearInterval(timer);
  });
</script>

<svelte:window 
  on:touchmove|nonpassive={handleTouchMove}
  on:touchend={stopTouchDrag} 
  on:touchcancel={cancelTouchDrag} 
  on:pointerup={stopTouchDrag} 
  on:pointercancel={cancelTouchDrag} 
/>

<section class="hero">
  <div>
    <h1>Lineup Helper
    <button class="secondary" on:click={() => (showManager = !showManager)}>
      {showManager ? 'Show lineup editor' : 'Edit roster/positions'}
    </button></h1>
  </div>
  <div class="hero-actions">
    {#if !showManager}
      <div class="game-status">
        {#if !gameStartedAt}
          <input 
            type="text" 
            placeholder="Game name (optional)" 
            bind:value={gameName} 
            class="game-name-input" 
            aria-label="Game name"
          />
          <button class="secondary" type="button" on:click={startGame}>Start game</button>
        {:else}
          <div class="game-status-info">
            <span class="status-label">Game:</span>
            <span class="game-name-display">{gameName || 'Unnamed'}</span>
            <span class="status-label">Time:</span>
            <span class="game-clock">{formatDuration(liveGameTime)}</span>
            <span class="status-chip {gameLive ? 'live' : 'stopped'}">{gameLive ? 'Live' : 'Paused'}</span>
          </div>
          <button class="secondary small" type="button" on:click={toggleGameLive}>
            {gameLive ? 'Pause' : 'Resume'}
          </button>
          <button class="secondary small" type="button" on:click={endGame}>Game over</button>
        {/if}
      </div>
    {/if}
  </div>
</section>

<div class="grid-layout">
  {#if !showManager}
    <section class="panel lineup-panel">
      <h2>Lineup Editor</h2>
      <div class="list-columns">
        <div class="list-column lineup-column">
          <div class="lineup-tools">
            <div>
              <h3>Lineup</h3>
              <form class="inline-form" on:submit|preventDefault={saveCurrentLineup}>
                <input
                  type="text"
                  placeholder="Lineup name (optional)"
                  bind:value={snapshotName}
                  aria-label="Snapshot name"
                />
                <button type="submit">Apply lineup</button>
              </form>
            </div>
          </div>
          <div class="scroll-box">
            <ul class="lineup-list">
              {#each positions as position (position.id)}
                <li>
                  <div class="lineup-item"
                    class:changed={hasSavedDifference(position.id, lineup, lastSavedLineup, roster, lastSavedRoster, history)}
                    class:empty-slot={!lineup[position.id]}
                    role="button"
                    tabindex="0"
                    data-drop-target="slot"
                    data-drop-id={position.id}
                    on:pointerdown={(event) => startTouchDrag(event, 'slot', position.id)}
                    on:dragover|preventDefault
                    on:drop={(event) => handleDrop(event, 'slot', position.id)}
                    on:click={() => handleTapDrop('slot', position.id)}
                    on:keydown={(event) => handleKeyboardAction(event, () => handleTapDrop('slot', position.id))}>
                    <div class="lineup-row">
                      <span class="position-name">{position.name}</span>
                      <span class="player-name">
                        {#if lineup[position.id]}
                          {#if lastSavedLineup[position.id] && lastSavedLineup[position.id] !== lineup[position.id]}
                            Sub: {getPlayerNameFromRoster(lineup[position.id], roster)} ({getPlayerStatusText(lineup[position.id], rosterPlayers, true)})
                          {:else}
                            {getPlayerNameFromRoster(lineup[position.id], roster)} ({getPlayerStatusText(lineup[position.id], rosterPlayers)})
                          {/if}
                          <span class="previous-lineup-note">                            
                            {#if lastSavedLineup[position.id] && lastSavedLineup[position.id] !== lineup[position.id]}
                              For: {getPlayerNameFromRoster(lastSavedLineup[position.id], lastSavedRoster)}
                              ({getPlayerStatusText(lastSavedLineup[position.id], rosterPlayers)})
                            {/if}
                          </span>
                        {:else}
                          <span class="slot-empty">Drop player here</span>
                          {#if lastSavedLineup[position.id]}
                            <span class="previous-lineup-note">Last: {getPlayerNameFromRoster(lastSavedLineup[position.id], lastSavedRoster)}</span>
                          {/if}
                        {/if}
                      </span>
                      <div class="lineup-item-actions">
                        {#if history.length > 0 && lineup[position.id] !== (lastSavedLineup[position.id] || null)}
                          <button class="undo-sub" type="button" on:pointerdown|stopPropagation on:click|stopPropagation={() => undoSub(position.id)}>
                            Undo
                          </button>
                        {:else if lineup[position.id]}
                          <button class="remove-lineup" type="button" on:pointerdown|stopPropagation on:click|stopPropagation={() => removeFromLineup(position.id)}>
                            Remove
                          </button>
                        {/if}
                      </div>
                    </div>
                  </div>
                </li>
              {/each}
            </ul>
          </div>
        </div>

        <div class="list-column roster-column">
          <div class="lineup-tools">
            <h3>Roster</h3>
            <div class="sort-controls">
              <label for="roster-sort">Sort:</label>
              <select id="roster-sort" bind:value={lineupRosterSort}>
                <option value="name">Name (A-Z)</option>
                <option value="total">Total Field Time</option>
                <option value="stintActive">Current Field Stint</option>
                <option value="stintBench">Current Bench Stint</option>
              </select>
            </div>
          </div>
          <div class="scroll-box">
            <ul class="list">
              {#each sortedLineupRoster as player (player.id)}
                <li>
                  <button class="list-item roster-list-item {selectedItem && selectedItem.sourceType === 'roster' && selectedItem.id === player.id ? 'selected' : ''}"
                    disabled={player.inDraftLineup}
                    type="button"
                    draggable={!player.inDraftLineup}
                    on:pointerdown={(event) => !player.inDraftLineup && startTouchDrag(event, 'roster', player.id)}
                    on:dragstart={(event) => !player.inDraftLineup && onDragStart(event, 'roster', player.id)}
                    on:click={() => !player.inDraftLineup && selectItem('roster', player.id)}
                    on:keydown={(event) => !player.inDraftLineup && handleKeyboardAction(event, () => selectItem('roster', player.id))}
                  >
                    <div class="roster-item-name">{player.name}</div>
                    <div class="roster-item-stats">
                      <div>Total: {formatDuration(player.activeDurationMs)}</div>
                      {#if player.inLiveLineup}
                        <div class="time-active">Field: {formatDuration(player.stintActiveMs)}</div>
                      {:else}
                        <div class="time-bench">Bench: {formatDuration(player.stintBenchMs)}</div>
                      {/if}
                    </div>
                  </button>
                </li>
              {/each}
              {#if sortedLineupRoster.length === 0}
                <li class="muted">No players have been added yet.</li>
              {/if}
            </ul>
          </div>
        </div>
      </div>
    </section>
  {/if}

  {#if showManager}
    <section class="panel manager-tabs">
      <div class="tabs">
        <button class="tab-button {managerTab === 'roster' ? 'active' : ''}" type="button" on:click={() => setManagerTab('roster')}>
          Roster
        </button>
        <button class="tab-button {managerTab === 'positions' ? 'active' : ''}" type="button" on:click={() => setManagerTab('positions')}>
          Positions
        </button>
      </div>
    </section>

    <div class="manager-editor">
      <section class="panel roster-panel tab-panel {managerTab === 'roster' ? 'active' : ''}">
        <div style="display: flex; justify-content: space-between; align-items: baseline;">
          <h2>Roster</h2>
          <span class="muted" style="font-size: 0.85rem;">(Uncheck to hide from game)</span>
        </div>
        
        <form class="inline-form" on:submit|preventDefault={addPlayer}>
          <input
            type="text"
            placeholder="Add player name"
            bind:value={newPlayerName}
            aria-label="New player name"
          />
          <button type="submit">Add</button>
        </form>

        <ul class="list">
          {#each sortedManagerRoster as player (player.id)}
            <li class="list-item" class:unavailable={!player.available}>
              <input
                type="checkbox"
                class="availability-toggle"
                checked={player.available}
                on:change={(e) => togglePlayerAvailability(player.id, e.target.checked)}
                title="Available for game"
                aria-label="Toggle availability"
              />
              <input
                type="text"
                value={player.name}
                on:click|stopPropagation
                on:change={(event) => updatePlayerName(player.id, event.target.value)}
                aria-label="Player name"
              />
              <button class="mini" on:click|stopPropagation={() => removePlayer(player.id)} aria-label="Remove player">×</button>
            </li>
          {/each}
        </ul>
      </section>

      <section class="panel positions-panel tab-panel {managerTab === 'positions' ? 'active' : ''}">
        <h2>Positions</h2>
        <form class="inline-form" on:submit|preventDefault={addPosition}>
          <input
            type="text"
            placeholder="Add position name"
            bind:value={newPositionName}
            aria-label="New position name"
          />
          <button type="submit">Add</button>
        </form>

        <ul class="list">
          {#each positions as position (position.id)}
            <li class="list-item"
                animate:flip={{ duration: 250 }}
                class:is-dragging={draggedPosId === position.id || touchDrag?.id === position.id}
                data-position-id={position.id}
                on:dragenter={(e) => {
                  if (draggedPosId) handlePositionSwapRealtime(position.id, draggedPosId);
                }}
                on:dragover|preventDefault
            >
              <div class="drag-handle" 
                   draggable="true"
                   aria-label="Drag to reorder"
                   on:dragstart={(e) => {
                     draggedPosId = position.id;
                     e.dataTransfer.effectAllowed = 'move';
                     e.dataTransfer.setData('application/x-position', position.id);
                   }}
                   on:dragend={() => {
                     draggedPosId = null;
                     saveState();
                   }}
                   on:pointerdown={(e) => startTouchDrag(e, 'position', position.id)}
              >☰</div>
              <div>
                <input
                  type="text"
                  value={position.name}
                  on:change={(event) => updatePositionName(position.id, event.target.value)}
                  aria-label="Position name"
                />
                <input
                  type="text"
                  value={position.parent || ''}
                  placeholder="Position group"
                  on:change={(event) => updatePositionParent(position.id, event.target.value)}
                  aria-label="Position group"
                />
              </div>
              <button class="mini" on:click={() => removePosition(position.id)} aria-label="Remove position">×</button>
            </li>
          {/each}
        </ul>
      </section>
    </div>
  {/if}

  {#if !showManager}
    <section class="panel history-panel">
      <div class="history-tools">
        <h2>Game Events</h2>
        <div>
          <button class="secondary small" type="button" on:click={exportHistoryCsv}>Export CSV</button>
          <button disabled={history.length === 0} class="secondary small clear-events" type="button" on:click={clearEvents}>Clear</button>
        </div>
      </div>

    {#if history.length === 0}
      <p class="muted">No game events yet. Start, pause, resume, or stop the game to record events.</p>
    {:else}
      <div class="history-list">
        {#each history as item (item.id)}
          <article class="history-item">
            <div>
              <strong>{item.label}</strong>
              <div class="muted">{new Date(item.created).toLocaleString()}</div>
            </div>
            <div class="history-actions">
              <button on:click={() => recallLineup(item)}>Recall</button>
              <button class="mini" on:click={() => removeHistoryItem(item.id)}>×</button>
            </div>
          </article>
        {/each}
      </div>
    {/if}
  </section>
  {/if}
</div>

<style>
  :global(body) {
    margin: 0;
    background: #0f172a;
  }

  .hero {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: flex-start;
    margin-bottom: 1rem;
    flex-wrap: wrap;
  }

  h1 {
    margin: 0;
    font-size: clamp(2rem, 3vw, 2.6rem);
  }

  .hero p {
    margin: 0.5rem 0 0;
    max-width: 40rem;
    color: #cbd5e1;
  }

  .hero-actions {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
    align-items: center;
  }

  .game-status {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .game-name-input {
    padding: 0.75rem 0.9rem;
    border-radius: 0.75rem;
    border: 1px solid #334155;
    background: #0f172a;
    color: #e2e8f0;
    min-width: 200px;
  }

  .game-name-display {
    font-weight: 600;
    color: #f8fafc;
    margin-right: 0.5rem;
  }

  .game-status-info {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: #cbd5e1;
    font-size: 0.95rem;
  }
  
  .game-clock {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    margin-right: 0.25rem;
  }

  .status-chip {
    padding: 0.25rem 0.6rem;
    border-radius: 999px;
    font-size: 0.85rem;
    color: white;
  }

  .status-chip.live {
    background: #16a34a;
  }

  .status-chip.stopped {
    background: #f59e0b;
  }

  .secondary {
    background: #475569;
    border: none;
    color: white;
    padding: 0.85rem 1rem;
    border-radius: 0.75rem;
    cursor: pointer;
  }

  .grid-layout {
    display: grid;
    gap: 1rem;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  }

  .lineup-panel {
    display: grid;
  }

  .list-columns {
    display: grid;
    gap: 1rem;
    grid-template-columns: minmax(270px, 1.3fr) minmax(220px, 0.9fr);
    align-items: start;
  }

  .list-column {
    display: grid;
    gap: 0.75rem;
    align-self: start;
  }

  .lineup-tools {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
    margin-bottom: 0.75rem;
  }

  .lineup-tools h3 {
    margin: 0;
  }

  .history-tools {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
    margin-bottom: 0.75rem;
  }

  .history-tools h2 {
    margin: 0;
  }

  .sort-controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
    color: #94a3b8;
  }

  .sort-controls select {
    background: #1e293b;
    color: #e2e8f0;
    border: 1px solid #334155;
    border-radius: 0.5rem;
    padding: 0.25rem 0.5rem;
    font-size: 0.9rem;
    cursor: pointer;
    outline: none;
  }

  .scroll-box {
    max-height: min(65vh, 540px);
    overflow: auto;
    padding-right: 0.25rem;
    border: 1pt solid #334155;
    border-radius: 1rem;
    padding: 4pt;
  }

  .scroll-box::-webkit-scrollbar {
    width: 10px;
  }

  .scroll-box::-webkit-scrollbar-thumb {
    background: #475569;
    border-radius: 999px;
  }

  @media (max-width: 720px) {
    .list-columns {
      grid-template-columns: 1fr;
    }

    .list-column {
      min-height: 0;
    }

    .list-column .scroll-box {
      max-height: 36vh;
    }
  }

  .scroll-box::-webkit-scrollbar-track {
    background: transparent;
  }

  .panel {
    background: #111827;
    border: 1px solid #334155;
    border-radius: 1rem;
    padding: 1rem;
    box-shadow: 0 10px 30px rgba(15, 23, 42, 0.35);
  }

  h2 {
    margin-top: 0;
    color: #f8fafc;
  }

  .inline-form {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
    margin-bottom: 1rem;
  }

  .inline-form input {
    flex: 1;
    min-width: 0;
    padding: 0.75rem 0.9rem;
    border-radius: 0.75rem;
    border: 1px solid #334155;
    background: #0f172a;
    color: #e2e8f0;
    margin-top: 5pt;
  }

  .inline-form button,
  .secondary.small {
    background: #2563eb;
    border: none;
    padding: 0.75rem 1rem;
    border-radius: 0.75rem;
    color: white;
    cursor: pointer;
  }

  .secondary.small {
    padding: 0.5rem 0.8rem;
    font-size: 0.9rem;
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.75rem;
  }

  .list-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.8rem 1rem;
    border-radius: 0.9rem;
    border: 1px solid #334155;
    background: #1f2937;
    color: #f8fafc;
    text-align: left;
    width: 100%;
    touch-action: manipulation;
    transition: box-shadow 150ms ease, opacity 150ms ease;
  }

  .list-item.is-dragging {
    opacity: 0.6;
    box-shadow: inset 0 0 0 2px #3b82f6;
    z-index: 10;
  }

  .list-item:disabled {
    opacity: 0.45;
    cursor: default;
    background: #0f172a;
    border-color: #1e293b;
  }

  .roster-list-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.6rem 0.8rem;
  }

  .roster-item-name {
    font-weight: 500;
    text-align: left;
    flex: 1;
    min-width: 0;
    color: #f8fafc;
  }

  .roster-item-stats {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.15rem;
    font-size: 0.85rem;
    color: #94a3b8;
  }

  .time-active {
    color: #34d399;
  }

  .time-bench {
    color: #94a3b8;
  }

  .list-item input {
    flex: 1;
    border: none;
    background: transparent;
    color: #f8fafc;
    font-size: 1rem;
  }

  .list-item input:focus {
    outline: none;
  }

  .mini {
    background: #334155;
    border: 1px solid #475569;
    color: #cbd5e1;
    border-radius: 999px;
    cursor: pointer;
    min-width: 2.5rem;
    min-height: 2.5rem;
  }

  .drag-handle {
    cursor: grab;
    padding: 0.5rem;
    margin-left: -0.5rem;
    color: #64748b;
    user-select: none;
    touch-action: none;
  }

  .drag-handle:active {
    cursor: grabbing;
  }

  .manager-tabs {
    padding: 0.75rem 1rem 0.5rem;
    margin-bottom: 0.5rem;
    background: #111827;
    border: 1px solid #334155;
    border-radius: 1rem;
  }

  .tabs {
    display: flex;
    gap: 0.5rem;
  }

  .tab-button {
    flex: 1;
    border: 1px solid #334155;
    background: #0f172a;
    color: #cbd5e1;
    border-radius: 0.85rem;
    padding: 0.75rem 1rem;
    cursor: pointer;
  }

  .tab-button.active {
    background: #2563eb;
    border-color: #2563eb;
    color: white;
  }

  .manager-editor {
    display: grid;
    gap: 1rem;
  }

  .tab-panel {
    display: none;
  }

  .tab-panel.active {
    display: block;
  }

  @media (min-width: 860px) {
    .manager-tabs {
      display: none;
    }

    .manager-editor {
      grid-template-columns: 1fr 1fr;
    }

    .tab-panel {
      display: block;
    }
  }

  .lineup-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.75rem;
  }

  .lineup-item {
    padding: 0.95rem 1rem;
    border-radius: 0.9rem;
    border: 1px solid #334155;
    background: #0f172a;
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: center;
    min-height: 3rem;
    touch-action: manipulation;
    transition: background 160ms ease, border-color 160ms ease, box-shadow 160ms ease;
    position: relative;
    cursor: pointer;
  }

  .lineup-item.empty-slot {
    border-color: #475569;
    background: rgba(203, 86, 59, 0.18);
  }

  .lineup-item.empty-slot .position-name {
    color: #94a3b8;
  }

  .lineup-item.empty-slot .slot-empty {
    color: #fd0101;
    font-style: italic;
  }

  .lineup-item.changed {
    border-color: #60a5fa;
    background: rgba(37, 99, 235, 0.22);
    box-shadow: inset 0 0 0 1px rgba(96, 165, 250, 0.35), 0 0 0 1px rgba(96, 165, 250, 0.12);
  }

  .lineup-item.changed::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0.35rem;
    height: calc(100% - 0.7rem);
    width: 0.25rem;
    background: #60a5fa;
    border-radius: 999px;
  }

  .lineup-item.changed.empty-slot {
    background: rgba(37, 99, 235, 0.12);
  }

  .lineup-item.changed .position-name {
    color: #60a5fa;
  }

  .lineup-row {
    display: flex;
    flex: 1;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: center;
    min-width: 0;
  }

  .position-name {
    font-weight: 700;
    color: #e2e8f0;
    min-width: 3rem;
  }

  .player-name {
    color: #cbd5e1;
    flex: 1;
    min-width: 0;
  }

  .lineup-item-actions {
    display: flex;
    gap: 0.5rem;
  }

  .remove-lineup, .undo-sub {
    border: none;
    color: white;
    padding: 0.55rem 0.9rem;
    border-radius: 0.75rem;
    cursor: pointer;
  }

  .remove-lineup {
    background: #7f1d1d;
  }

  .undo-sub {
    background: #475569;
  }

  .selected {
    border-color: #2563eb;
    background: rgba(37, 99, 235, 0.15);
  }

  .slot-empty {
    color: #94a3b8;
  }

  .previous-lineup-note {
    display: block;
    margin-top: 0.15rem;
    color: #94a3b8;
    font-size: 0.88rem;
  }

  .history-list {
    display: grid;
    gap: 0.75rem;
  }

  .history-item {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: center;
    padding: 0.85rem 1rem;
    border-radius: 1rem;
    border: 1px solid #334155;
    background: #0f172a;
  }

  .history-actions {
    display: flex;
    gap: 0.5rem;
  }

  .history-actions button {
    border: none;
    border-radius: 0.75rem;
    padding: 0.65rem 0.85rem;
    cursor: pointer;
  }

  .history-actions button:first-child {
    background: #2563eb;
    color: white;
  }

  .muted {
    color: #94a3b8;
    font-size: 0.95rem;
  }

  .secondary.small.clear-events {
    background-color: #7f1d1d;
  }

  .list-item.unavailable {
    background: #0f172a;
    border-color: #1e293b;
  }
  
  .list-item.unavailable input[type="text"] {
    text-decoration: line-through;
    opacity: 0.45;
  }

  .availability-toggle {
    width: 1.25rem;
    height: 1.25rem;
    cursor: pointer;
    accent-color: #2563eb;
    margin: 0;
  }
</style>