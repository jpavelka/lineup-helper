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
  let showManager = false;
  let managerTab = 'roster';
  let selectedItem = null;
  let touchDrag = null;
  let draggedPosId = null;
  let lineupRosterSort = 'name'; 
  let now = Date.now(); 

  // Modal State
  let showEventModal = false;
  let showTimelineModal = false; // Added for Feature 5
  let eventType = 'goal'; // 'goal' or 'booking'
  let eventTeam = 'mine'; // 'mine' or 'theirs'
  let eventScorer = '';
  let eventAssist = '';
  let eventCard = 'yellow'; // 'yellow' or 'red'
  let eventPlayer = '';

  let viewingPlayerId = null; // Used for the player stats modal

  const PALETTE = [
    '#3b82f6', '#ef4444', '#10b981', '#f59e0b', 
    '#8b5cf6', '#ec4899', '#06b6d4', '#f97316', 
    '#84cc16', '#6366f1'
  ];

  // Dynamically assign colors to unique groups
  $: groupColors = [...new Set(positions.map(p => (p.parent || p.name).trim() || 'Unknown'))]
    .reduce((acc, group, idx) => {
      acc[group] = PALETTE[idx % PALETTE.length];
      return acc;
    }, {});

  function loadState() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        const data = JSON.parse(raw);
        roster = (data.roster ?? defaultState.roster).map(p => ({
          ...p,
          available: p.available !== false // defaults to true for existing players
        }));
        positions = data.positions ?? defaultState.positions;
        lineup = data.lineup ?? defaultState.lineup;
        
        // Backwards compatibility: Map old history items to the new 'events' array structure
        history = (data.history ?? []).map(h => {
          if (h.events) return h;
          return { ...h, events: [{ event: h.label || 'Event', playerId: null, detail: '', gameTime: 0 }] };
        });
        
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
          if (stat.positionTotals === undefined) stat.positionTotals = {};
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
          
          // Add to specific position total
          const posId = Object.keys(lastSavedLineup).find(k => lastSavedLineup[k] === id);
          if (posId) {
            if (!stats.positionTotals) stats.positionTotals = {};
            stats.positionTotals[posId] = (stats.positionTotals[posId] || 0) + elapsed;
          }
        } else {
          stats.benchTotal += elapsed;
          stats.stintBenchTotal += elapsed;
        }
        stats.sessionStart = null;
      }
    }
    playerTimeStats = { ...playerTimeStats };
  }

  function getCurrentGameTime() {
    return gameTimeStats.total + (gameLive && gameTimeStats.sessionStart ? Date.now() - gameTimeStats.sessionStart : 0);
  }

  function resumeTracking() {
    const currentTime = Date.now();

    if (gameLive && !gameTimeStats.sessionStart) {
      gameTimeStats.sessionStart = currentTime;
    }

    roster.forEach(player => {
      if (!playerTimeStats[player.id]) {
        playerTimeStats[player.id] = { activeTotal: 0, benchTotal: 0, stintActiveTotal: 0, stintBenchTotal: 0, sessionStart: null, positionTotals: {} };
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

    commitTime(); 

    const oldActiveIds = new Set(Object.values(lastSavedLineup).filter(Boolean));
    const newActiveIds = new Set(Object.values(lineup).filter(Boolean));

    roster.forEach(player => {
      const id = player.id;
      if (!playerTimeStats[id]) return;
      const wasActive = oldActiveIds.has(id);
      const isActive = newActiveIds.has(id);
      
      if (wasActive !== isActive) {
        playerTimeStats[id].stintBenchTotal = 0;
        playerTimeStats[id].stintActiveTotal = 0;
      }
    });

    const currentGameTime = getCurrentGameTime();
    const events = [];
    positions.forEach(pos => {
      const oldPlayerId = lastSavedLineup[pos.id];
      const newPlayerId = lineup[pos.id];

      if (oldPlayerId !== newPlayerId) {
        if (oldPlayerId) {
          events.push({ event: 'Exits lineup', playerId: oldPlayerId, detail: pos.name, gameTime: currentGameTime });
        }
        if (newPlayerId) {
          events.push({ event: 'Enters lineup', playerId: newPlayerId, detail: pos.name, gameTime: currentGameTime });
        }
      }
    });

    if (events.length === 0) {
      events.push({ event: 'Lineup snapshot', playerId: null, detail: 'No changes', gameTime: currentGameTime });
    }

    const entry = {
      id: uniqueId('history'),
      created: new Date().toISOString(),
      lineup: JSON.parse(JSON.stringify(lineup)),
      positions: JSON.parse(JSON.stringify(positions)),
      roster: JSON.parse(JSON.stringify(roster)),
      events
    };
    history = [entry, ...history];
    
    resumeTracking(); 
    saveState();
  }

  function addHistoryEntry(events) {
    const activeLineup = history.length > 0 ? history[0].lineup : lineup; 
    const currentGameTime = getCurrentGameTime();
    
    // Automatically attach the game time to all passed events
    const eventsWithTime = events.map(e => ({ ...e, gameTime: e.gameTime ?? currentGameTime }));

    const entry = {
      id: uniqueId('history'),
      created: new Date().toISOString(),
      lineup: JSON.parse(JSON.stringify(activeLineup)),
      positions: JSON.parse(JSON.stringify(positions)),
      roster: JSON.parse(JSON.stringify(roster)),
      events: eventsWithTime
    };
    history = [entry, ...history];
    saveState();
  }

  function openEventModal() {
    eventType = 'goal';
    eventTeam = 'mine';
    eventScorer = '';
    eventAssist = '';
    eventCard = 'yellow';
    eventPlayer = '';
    showEventModal = true;
  }

  function saveGameEvent() {
    const events = [];
    let currentScore = { ...score }; // Capture the current score before modification
    
    if (eventType === 'goal') {
      if (eventTeam === 'theirs') {
        currentScore.theirs += 1; // Update copy for feature 4
        events.push({ event: 'Goal conceded', playerId: null, detail: '', scoreAtTime: { ...currentScore } });
      } else {
        currentScore.mine += 1; // Update copy for feature 4
        events.push({ event: 'Goal scored', playerId: eventScorer, detail: '', scoreAtTime: { ...currentScore } });
        if (eventAssist) {
          events.push({ event: 'Goal assisted', playerId: eventAssist, detail: '' });
        }
      }
    } else if (eventType === 'booking') {
      const cardType = eventCard === 'yellow' ? 'Yellow card' : 'Red card';
      events.push({ event: cardType, playerId: eventPlayer, detail: '' });
    }
    
    addHistoryEntry(events);
    showEventModal = false;
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
    // Feature 2: Prevent new game from starting if uncleared game history exists
    if (history.length > 0) return;

    const hasEmpty = positions.some(p => !lineup[p.id]);
    if (hasEmpty) {
      const proceed = confirm("One or more positions are empty. Are you sure you want to start the game with this lineup?");
      if (!proceed) return;
    }

    commitTime();
    
    gameStartedAt = Date.now();
    gameTimeStats = { total: 0, sessionStart: null };
    for (let id in playerTimeStats) {
      playerTimeStats[id] = { activeTotal: 0, benchTotal: 0, stintActiveTotal: 0, stintBenchTotal: 0, sessionStart: null, positionTotals: {} };
    }
    
    const startEvents = [{ event: 'Game started', playerId: null, detail: '', gameTime: 0 }];
    
    positions.forEach(pos => {
      const playerId = lineup[pos.id];
      if (playerId) {
        startEvents.push({ event: 'Enters lineup', playerId, detail: pos.name, gameTime: 0 });
      }
    });

    const entry = {
      id: uniqueId('history'),
      created: new Date().toISOString(),
      lineup: JSON.parse(JSON.stringify(lineup)),
      positions: JSON.parse(JSON.stringify(positions)),
      roster: JSON.parse(JSON.stringify(roster)),
      events: startEvents
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
    addHistoryEntry([{ event: gameLive ? 'Game resumed' : 'Game paused', playerId: null, detail: '' }]);
  }
  
  function clearLineup() {
    if (confirm("Are you sure you want to clear all players from the current lineup?")) {
      lineup = Object.keys(lineup).reduce((acc, key) => ({ ...acc, [key]: null }), {});
      saveState();
    }
  }

  function endGame() {
    // Feature 1: Confirm user intent to end the game
    if (!confirm("Are you sure you want to end the game?")) return;

    commitTime();
    gameStartedAt = null;
    gameLive = false;
    resumeTracking();
    addHistoryEntry([{ event: 'Game stopped', playerId: null, detail: '' }]);
  }

  function uniqueId(prefix) {
    return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function addPlayer() {
    const name = newPlayerName.trim();
    if (!name) return;
    roster = [...roster, { id: uniqueId('player'), name, available: true }]; 
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

  function handleKeydown(event) {
    if (event.key === 'Escape') {
      if (showEventModal) showEventModal = false;
      if (viewingPlayerId) viewingPlayerId = null;
      if (showTimelineModal) showTimelineModal = false;
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
      newLineup[payload.id] = targetId; 
    }
    updateLineup(newLineup);
  }

  function handleSlotClick(posId) {
    if (selectedItem) {
      handleTapDrop('slot', posId);
    } else {
      selectItem('slot', posId);
    }
  }

  function handleRosterClick(playerId) {
    if (selectedItem && selectedItem.sourceType === 'slot') {
      handleTapDrop('roster', playerId);
    } else {
      selectItem('roster', playerId);
    }
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
    const inLiveLineup = Object.values(lastSavedLineup).includes(player.id);
    const inDraftLineup = Object.values(lineup).includes(player.id);
    
    let currentPositionTotals = { ...(stats?.positionTotals || {}) };

    if (stats && stats.sessionStart && gameLive) {
      const elapsed = Math.max(0, now - stats.sessionStart);
      if (inLiveLineup) {
        activeSession = elapsed;
        const livePosId = Object.keys(lastSavedLineup).find(p => lastSavedLineup[p] === player.id);
        if (livePosId) {
           currentPositionTotals[livePosId] = (currentPositionTotals[livePosId] || 0) + elapsed;
        }
      } else {
        benchSession = elapsed;
      }
    }
    
    const activeDurationMs = (stats ? stats.activeTotal : 0) + activeSession;
    
    let positionSegments = [];
    let positionDetails = [];

    if (activeDurationMs > 0) {
      for (let posId in currentPositionTotals) {
        const pTime = currentPositionTotals[posId];
        if (pTime > 0) {
           const posDef = positions.find(p => p.id === posId);
           const pName = posDef ? posDef.name : 'Unknown';
           const pGroup = posDef ? (posDef.parent || posDef.name).trim() || 'Unknown' : 'Unknown';
           
           positionSegments.push({
             posId,
             group: pGroup,
             pct: (pTime / activeDurationMs) * 100
           });

           positionDetails.push({
             posId,
             name: pName,
             group: pGroup,
             durationMs: pTime
           });
        }
      }
    }
    
    positionDetails.sort((a,b) => b.durationMs - a.durationMs);

    return {
      ...player,
      activeDurationMs,
      benchDurationMs: (stats ? stats.benchTotal : 0) + benchSession,
      stintActiveMs: (stats ? stats.stintActiveTotal || 0 : 0) + activeSession,
      stintBenchMs: (stats ? stats.stintBenchTotal || 0 : 0) + benchSession,
      inLiveLineup,
      inDraftLineup,
      positionSegments,
      positionDetails
    };
  });

  $: sortedManagerRoster = [...rosterPlayers].sort((a,b) => {
    return a.name.localeCompare(b.name);
  });

  $: sortedLineupRoster = [...rosterPlayers]
    .filter(p => p.available) 
    .sort((a, b) => {
      if (lineupRosterSort === 'name') {
        return a.name.localeCompare(b.name);
      } else if (lineupRosterSort === 'status') {
         const getRank = (p) => {
           if (!p.inLiveLineup && !p.inDraftLineup) return 0; // Bench, not staged
           if (!p.inLiveLineup && p.inDraftLineup) return 1;  // Bench, staged to sub in
           if (p.inLiveLineup && !p.inDraftLineup) return 2;  // Field, staged to sub out
           return 3; // Field, staged to stay
         };
         const rankA = getRank(a), rankB = getRank(b);
         return rankA !== rankB ? rankA - rankB : a.name.localeCompare(b.name);
      }else if (lineupRosterSort === 'total') {
        return b.activeDurationMs - a.activeDurationMs;
      } else if (lineupRosterSort === 'stintActive') {
        return (a.stintBenchMs - a.stintActiveMs) - (b.stintBenchMs - b.stintActiveMs);
      } else if (lineupRosterSort === 'stintBench') {
        return (b.stintBenchMs - b.stintActiveMs) - (a.stintBenchMs - a.stintActiveMs);
      }
      return 0;
    });

  $: activeStatsPlayer = viewingPlayerId ? rosterPlayers.find(p => p.id === viewingPlayerId) : null;

  $: score = history.reduce((acc, item) => {
    item.events.forEach(ev => {
      if (ev.event === 'Goal scored') acc.mine++;
      if (ev.event === 'Goal conceded') acc.theirs++;
    });
    return acc;
  }, { mine: 0, theirs: 0 });

  // Feature 5: Derived chronological timeline of goals from history
  $: goalTimeline = [...history].reverse().flatMap(item => 
    item.events
      .filter(e => e.event === 'Goal scored' || e.event === 'Goal conceded')
      .map(e => ({
        id: item.id + '-' + e.event,
        gameTime: e.gameTime || 0,
        event: e.event,
        playerId: e.playerId,
        roster: item.roster,
        scoreAtTime: e.scoreAtTime || { mine: 0, theirs: 0 }
      }))
  );

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
    const rows = [['Event', 'Timestamp', 'Game Time', 'Player', 'Detail']];
    
    // Reverse to export chronologically
    [...history].reverse().forEach((item) => {
      const timestamp = new Date(item.created).toLocaleString();
      
      item.events.forEach(ev => {
        const playerName = ev.playerId ? getPlayerNameFromRoster(ev.playerId, item.roster) : '';
        // Include score text in CSV if present
        const scoreStr = ev.scoreAtTime ? `Score: ${ev.scoreAtTime.mine}-${ev.scoreAtTime.theirs}` : '';
        rows.push([
          ev.event,
          timestamp,
          formatDuration(ev.gameTime || 0),
          playerName,
          (ev.detail || '') + scoreStr
        ]);
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

  // Feature 3: Determine if the history entry can be recalled (hide recall on goals/cards)
  function isLineupRecallable(item) {
    const nonRecallableEvents = ['Goal scored', 'Goal conceded', 'Goal assisted', 'Yellow card', 'Red card'];
    return !item.events.some(e => nonRecallableEvents.includes(e.event));
  }

  function removeHistoryItem(id) {
    history = history.filter((item) => item.id !== id);
    saveState();
  }

  function clearEvents() {
    const proceed = confirm('Are you sure you want to remove all history items, reset all timers to 0, and end the current game?');
    if (proceed) {
      history = [];
      gameTimeStats = { total: 0, sessionStart: null };
      for (let id in playerTimeStats) {
        playerTimeStats[id] = {
          activeTotal: 0,
          benchTotal: 0,
          stintActiveTotal: 0,
          stintBenchTotal: 0,
          sessionStart: null,
          positionTotals: {}
        };
      }
      
      gameStartedAt = null;
      gameLive = false;
      gameName = ''; 
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
  on:keydown={handleKeydown} 
/>

{#if showEventModal}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="modal-backdrop" on:click={() => showEventModal = false}>
    <div class="modal-panel" on:click|stopPropagation>
      <h2>Add Game Event</h2>
      
      <div class="form-group">
        <label for="event-type">Event Type</label>
        <select id="event-type" bind:value={eventType}>
          <option value="goal">Goal</option>
          <option value="booking">Booking (Card)</option>
        </select>
      </div>

      {#if eventType === 'goal'}
        <div class="form-group">
          <label for="event-team">Team</label>
          <select id="event-team" bind:value={eventTeam}>
            <option value="mine">Our Team</option>
            <option value="theirs">Opposing Team</option>
          </select>
        </div>
        {#if eventTeam === 'mine'}
          <div class="form-group">
            <label for="event-scorer">Goal Scorer</label>
            <select id="event-scorer" bind:value={eventScorer}>
              <option value="">-- Select Player --</option>
              {#each sortedLineupRoster as p}
                <option value={p.id}>{p.name}</option>
              {/each}
            </select>
          </div>
          <div class="form-group">
            <label for="event-assist">Assist (optional)</label>
            <select id="event-assist" bind:value={eventAssist}>
              <option value="">-- None --</option>
              {#each sortedLineupRoster as p}
                <option value={p.id}>{p.name}</option>
              {/each}
            </select>
          </div>
        {/if}
      {:else if eventType === 'booking'}
        <div class="form-group">
          <label for="event-card">Card</label>
          <select id="event-card" bind:value={eventCard}>
            <option value="yellow">Yellow Card</option>
            <option value="red">Red Card</option>
          </select>
        </div>
        <div class="form-group">
          <label for="event-player">Player</label>
          <select id="event-player" bind:value={eventPlayer}>
            <option value="">-- Select Player --</option>
            {#each sortedLineupRoster as p}
              <option value={p.id}>{p.name}</option>
            {/each}
          </select>
        </div>
      {/if}

      <div class="modal-actions">
        <button class="secondary" on:click={() => showEventModal = false}>Cancel</button>
        <button class="primary" on:click={saveGameEvent} disabled={
          (eventType === 'goal' && eventTeam === 'mine' && !eventScorer) ||
          (eventType === 'booking' && !eventPlayer)
        }>Save Event</button>
      </div>
    </div>
  </div>
{/if}

<!-- Feature 5: Timeline Score Modal -->
{#if showTimelineModal}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="modal-backdrop" on:click={() => showTimelineModal = false}>
    <div class="modal-panel" on:click|stopPropagation>
      <h2>Goal Timeline</h2>
      
      {#if goalTimeline.length === 0}
        <p class="muted">No goals have been scored yet.</p>
      {:else}
        <ul class="stats-list timeline-list">
          {#each goalTimeline as goal}
            <li>
              <div style="display: flex; flex-direction: column; gap: 0.25rem;">
                <strong>{formatDuration(goal.gameTime)} - {goal.event === 'Goal scored' ? 'Our Goal' : 'Opponent Goal'}</strong>
                <span class="muted">
                  {goal.event === 'Goal scored' ? getPlayerNameFromRoster(goal.playerId, goal.roster) : 'Opponent'}
                </span>
              </div>
              <div class="score-timeline-box">
                <span style="color: #34d399;">{goal.scoreAtTime.mine}</span>
                <span style="color: #475569; margin: 0 0.2rem;">-</span>
                <span style="color: #ef4444;">{goal.scoreAtTime.theirs}</span>
              </div>
            </li>
          {/each}
        </ul>
      {/if}

      <div class="modal-actions">
        <button class="secondary" on:click={() => showTimelineModal = false}>Close</button>
      </div>
    </div>
  </div>
{/if}

{#if activeStatsPlayer}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="modal-backdrop" on:click={() => viewingPlayerId = null}>
    <div class="modal-panel" on:click|stopPropagation>
      <h2>{activeStatsPlayer.name}</h2>
      
      <div class="stats-list-totals">
        <div>
          <span>Total Field Time</span>
          <span style="font-weight: bold; color: #34d399;">{formatDuration(activeStatsPlayer.activeDurationMs)}</span>
        </div>
        <div>
          <span>Total Bench Time</span>
          <span style="font-weight: bold; color: #94a3b8;">{formatDuration(activeStatsPlayer.benchDurationMs)}</span>
        </div>
      </div>

      {#if activeStatsPlayer.positionDetails.length > 0}
        <h3 style="margin-top: 0; color: #cbd5e1; font-size: 1rem;">Positions Played</h3>
        <ul class="stats-list">
          {#each activeStatsPlayer.positionDetails as pos}
            <li>
               <div style="display: flex; align-items: center; gap: 0.5rem;">
                 <div class="position-color-bar" style="width: 12px; height: 12px; border-radius: 2px; background-color: {groupColors[pos.group]}"></div>
                 <span>{pos.name} <span class="muted" style="font-size: 0.85em;">({pos.group})</span></span>
               </div>
               <span>{formatDuration(pos.durationMs)}</span>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="muted">No field time yet.</p>
      {/if}
      
      <div class="modal-actions">
        <button class="secondary" on:click={() => viewingPlayerId = null}>Close</button>
      </div>
    </div>
  </div>
{/if}

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
          <!-- Feature 2: Disable starting a game if uncleared data exists -->
          <input 
            type="text" 
            placeholder="Game name (optional)" 
            bind:value={gameName} 
            class="game-name-input" 
            aria-label="Game name"
            disabled={history.length > 0} 
          />
          <button class="secondary" type="button" on:click={startGame} disabled={history.length > 0}>Start game</button>
          
          {#if history.length > 0}
            <!-- Render a clear button alongside Start if they have to clear old data -->
            <button class="secondary small clear-events" type="button" on:click={clearEvents}>Clear previous game</button>
          {/if}
        {:else}
          <div class="game-status-info">
            <span class="status-label">Game:</span>
            <span class="game-name-display">{gameName || 'Unnamed'}</span>
            <!-- Feature 5: Score display is clickable to open Modal -->
            <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
            <div class="scoreboard" on:click={() => showTimelineModal = true} title="Click to view Goal Timeline">
              <span class="score-box">{score.mine}</span>
              <span class="score-separator">-</span>
              <span class="score-box">{score.theirs}</span>
            </div>
            <span class="status-label">Time:</span>
            <span class="game-clock">{formatDuration(liveGameTime)}</span>
            <span class="status-chip {gameLive ? 'live' : 'stopped'}">{gameLive ? 'Live' : 'Paused'}</span>
          </div>
          <button class="secondary small" type="button" on:click={toggleGameLive}>
            {gameLive ? 'Pause' : 'Resume'}
          </button>
          <button class="secondary small warning" type="button" on:click={endGame}>Game over</button>
        {/if}
      </div>
    {/if}
  </div>
</section>

<div class="grid-layout">
  {#if !showManager}
    <section class="panel lineup-panel">
      <div class="lineup-panel-header">
        <h2>Lineup Editor</h2>
        <div>
          <button class="secondary small" style="background:#7f1d1d" type="button" on:click={clearLineup}>Clear</button>
          <button class="secondary small" type="button" on:click={saveCurrentLineup}>Apply</button>
        </div>
      </div>
      <div class="list-columns">
        <div class="list-column lineup-column">
          <div class="scroll-box">
            <ul class="lineup-list">
              {#each positions as position (position.id)}
                <li>
                  <div class="lineup-item"
                    class:selected={selectedItem?.sourceType === 'slot' && selectedItem?.id === position.id}
                    class:changed={hasSavedDifference(position.id, lineup, lastSavedLineup, roster, lastSavedRoster, history)}
                    class:empty-slot={!lineup[position.id]}
                    role="button"
                    tabindex="0"
                    data-drop-target="slot"
                    data-drop-id={position.id}
                    on:pointerdown={(event) => startTouchDrag(event, 'slot', position.id)}
                    on:dragover|preventDefault
                    on:drop={(event) => handleDrop(event, 'slot', position.id)}
                    on:click={() => handleSlotClick(position.id)}
                    on:keydown={(event) => handleKeyboardAction(event, () => handleSlotClick(position.id))}>
                    
                    <div class="lineup-row">
                      <div class="position-badge">
                        <span class="position-name">{position.name}</span>
                        <div class="position-color-bar" style="background-color: {groupColors[(position.parent || position.name).trim() || 'Unknown']}"></div>
                      </div>
                      <span class="player-name">
                        {#if lineup[position.id]}
                          {#if lastSavedLineup[position.id] && lastSavedLineup[position.id] !== lineup[position.id]}
                            Sub: {getPlayerNameFromRoster(lineup[position.id], roster)}
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
                          <span class="slot-empty">Drop/Tap player here</span>
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
                <option value="status">Status</option>
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
                  <button class="list-item roster-list-item"
                    class:selected={selectedItem?.sourceType === 'roster' && selectedItem?.id === player.id}
                    disabled={player.inDraftLineup}
                    type="button"
                    draggable={!player.inDraftLineup}
                    on:pointerdown={(event) => !player.inDraftLineup && startTouchDrag(event, 'roster', player.id)}
                    on:dragstart={(event) => !player.inDraftLineup && onDragStart(event, 'roster', player.id)}
                    on:click={() => !player.inDraftLineup && handleRosterClick(player.id)}
                    on:keydown={(event) => !player.inDraftLineup && handleKeyboardAction(event, () => handleRosterClick(player.id))}
                  >
                    <div class="roster-item-top">
                      <div style="display: flex; align-items: center; min-width: 0; gap: 0.5rem; flex: 1;">
                        <span
                          class="info-btn"
                          role="button"
                          tabindex="0"
                          on:click|stopPropagation={() => viewingPlayerId = player.id}
                          on:keydown={(event) => handleKeyboardAction(event, () => viewingPlayerId = player.id)}
                          on:pointerdown|stopPropagation
                        >
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <circle cx="12" cy="12" r="10"></circle>
                            <line x1="12" y1="16" x2="12" y2="12"></line>
                            <line x1="12" y1="8" x2="12.01" y2="8"></line>
                          </svg>
                        </span>
                        <div class="roster-item-name" style="flex: unset;">{player.name}</div>
                        <div class="player-status-icon">
                          {#if player.inLiveLineup && player.inDraftLineup}
                            <!-- Field: Solid Green Dot -->
                            <svg title="On Field" width="14" height="14" viewBox="0 0 24 24" fill="#34d399">
                              <circle cx="12" cy="12" r="8"></circle>
                            </svg>

                          {:else if !player.inLiveLineup && !player.inDraftLineup}
                            <!-- Bench: Hollow Gray Dot -->
                            <svg title="On Bench" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="3">
                              <circle cx="12" cy="12" r="7"></circle>
                            </svg>

                          {:else if !player.inLiveLineup && player.inDraftLineup}
                            <!-- Sub IN: Pulsing Green Right Arrow -->
                            <svg title="Staged to Sub In" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                              <path d="M5 12h14"></path>
                              <path d="m12 5 7 7-7 7"></path>
                            </svg>

                          {:else if player.inLiveLineup && !player.inDraftLineup}
                            <!-- Sub OUT: Pulsing Red Left Arrow -->
                            <svg class="sub-pending-icon" title="Staged to Sub Out" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                              <path d="M19 12H5"></path>
                              <path d="m12 19-7-7 7-7"></path>
                            </svg>
                          {/if}
                        </div>
                      </div>
                    </div>
                    
                    {#if player.positionSegments?.length > 0}
                      <div class="player-position-bar">
                        {#each player.positionSegments as seg}
                          <div class="pos-segment" style="width: {seg.pct}%; background-color: {groupColors[seg.group]}" title="{seg.group}"></div>
                        {/each}
                      </div>
                    {/if}
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
                  role="button"
                  tabindex="0"
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
              <div class="position-inputs">
                <input
                  type="text"
                  value={position.name}
                  on:change={(event) => updatePositionName(position.id, event.target.value)}
                  aria-label="Position name"
                />
                <input
                  type="text"
                  value={position.parent || ''}
                  placeholder="Group (e.g. DEF)"
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
        <div style="display: flex; gap: 0.5rem; align-items: center;">
          <button class="secondary small" type="button" on:click={openEventModal}>+ Add Event</button>
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
            <div class="history-item-events">
              <div class="muted" style="margin-bottom: 0.25rem;">{new Date(item.created).toLocaleTimeString()}</div>
              {#each item.events as ev}
                <div>
                  <span class="muted" style="margin-right: 0.4rem; font-variant-numeric: tabular-nums;">
                    [{formatDuration(ev.gameTime || 0)}]
                  </span>
                  <strong>{ev.event}</strong>
                  {#if ev.playerId}
                    - <span style="color: #cbd5e1;">{getPlayerNameFromRoster(ev.playerId, item.roster)}</span>
                  {/if}
                  {#if ev.detail}
                    <span class="muted" style="margin-left: 0.25rem;">({ev.detail})</span>
                  {/if}
                  <!-- Feature 4: Render Score inside goal events -->
                  {#if (ev.event === 'Goal scored' || ev.event === 'Goal conceded') && ev.scoreAtTime}
                    <span class="muted" style="margin-left: 0.25rem;">
                      (Score: {ev.scoreAtTime.mine} - {ev.scoreAtTime.theirs})
                    </span>
                  {/if}
                </div>
              {/each}
            </div>
            <div class="history-actions">
              <!-- Feature 3: Hide Recall Lineup for single game events -->
              {#if isLineupRecallable(item)}
                <button on:click={() => recallLineup(item)}>Recall Lineup</button>
              {/if}
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
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  :global(*),
  :global(*::before),
  :global(*::after) {
    box-sizing: border-box;
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
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
    color: #f8fafc;
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
  
  .secondary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .secondary.warning {
    background: #b91c1c; /* A darker red for "Game over" button hover/feel */
  }

  .primary {
    background: #2563eb;
    border: none;
    color: white;
    padding: 0.85rem 1rem;
    border-radius: 0.75rem;
    cursor: pointer;
  }
  .primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
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
    color: #f8fafc;
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

  .roster-list-item {
    display: block;
    padding: 0.6rem 0.8rem;
  }

  .roster-item-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  
  .info-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.35rem;
    margin-right: 0.5rem;
    color: #94a3b8;
    background: transparent;
    border-radius: 50%;
    cursor: pointer;
    transition: background 150ms ease, color 150ms ease;
  }
  
  .info-btn:hover {
    color: #e2e8f0;
    background: #334155;
  }

  .roster-item-name {
    font-weight: 500;
    text-align: left;
    flex: 1;
    min-width: 0;
    color: #f8fafc;
  }

  .time-active {
    color: #34d399;
  }

  .time-bench {
    color: #94a3b8;
  }

  .player-position-bar {
    display: flex;
    height: 5px;
    width: 100%;
    border-radius: 3px;
    overflow: hidden;
    margin-top: 0.4rem;
    background: #334155;
  }

  .pos-segment {
    height: 100%;
  }

  .position-inputs {
    display: flex;
    flex: 1;
    gap: 0.5rem;
    min-width: 0;
    flex-wrap: wrap; 
  }

  .list-item input[type="text"] {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    color: #f8fafc;
    font-size: 1rem;
  }

  .list-item input[type="text"]:focus {
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
    padding: 0.25rem;
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

  .lineup-item.selected, .list-item.selected {
    border-color: #3b82f6;
    box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.4);
    background: rgba(37, 99, 235, 0.15);
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

  .position-badge {
    display: flex;
    flex-direction: column;
    align-items: center;
    min-width: 3.5rem;
    gap: 0.2rem;
  }

  .position-name {
    font-weight: 700;
    color: #e2e8f0;
  }

  .position-color-bar {
    width: 100%;
    height: 3px;
    border-radius: 2px;
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
  
  .history-item-events {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    color: #f8fafc;
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

  /* Modal Styles */
  .modal-backdrop {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0, 0, 0, 0.75);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 1000;
    padding: 1rem;
  }

  .modal-panel {
    background: #111827;
    border: 1px solid #334155;
    border-radius: 1rem;
    padding: 1.5rem;
    width: 100%;
    max-width: 400px;
    box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
    max-height: 90vh;
    display: flex;
    flex-direction: column;
  }

  .modal-panel h2 {
    margin-top: 0;
    margin-bottom: 1.5rem;
    color: #f8fafc;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  .form-group label {
    color: #cbd5e1;
    font-size: 0.9rem;
    font-weight: 500;
  }

  .form-group select {
    padding: 0.75rem 0.9rem;
    border-radius: 0.75rem;
    border: 1px solid #334155;
    background: #0f172a;
    color: #e2e8f0;
    font-size: 1rem;
    outline: none;
  }

  .form-group select:focus {
    border-color: #2563eb;
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.75rem;
    margin-top: 1.5rem;
  }

  /* Stats List UI inside Modal */
  .stats-list-totals {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-bottom: 1.5rem;
  }

  .stats-list-totals div {
    display: flex;
    justify-content: space-between;
    background: #0f172a;
    padding: 0.75rem 1rem;
    border-radius: 0.5rem;
    border: 1px solid #334155;
    color: #f8fafc;
  }

  .stats-list {
    list-style: none;
    padding: 0;
    margin: 0 0 1.5rem 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  
  .timeline-list {
    overflow-y: auto;
    margin-bottom: 0;
    padding-right: 0.5rem;
  }

  .stats-list li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: #1f2937;
    padding: 0.75rem 1rem;
    border-radius: 0.5rem;
    border: 1px solid #334155;
    color: #f8fafc;
  }
  
  .score-timeline-box {
    background: #000;
    padding: 0.4rem 0.6rem;
    border-radius: 0.5rem;
    font-family: 'Courier New', Courier, monospace;
    font-weight: bold;
    font-size: 1.1rem;
  }

  .lineup-panel-header {
    display: flex;
    justify-content: space-between;
  }

  .scoreboard {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    margin: 0 1rem;
    background: #000;
    padding: 0.2rem 0.6rem;
    border-radius: 0.5rem;
    border: 1px solid #334155;
    font-family: 'Courier New', Courier, monospace;
    cursor: pointer;
    transition: box-shadow 0.2s ease;
  }
  
  .scoreboard:hover {
    box-shadow: 0 0 8px rgba(255, 255, 255, 0.2);
  }

  .score-box {
    color: #f8fafc;
    font-size: 1.2rem;
    font-weight: bold;
    min-width: 1.2rem;
    text-align: center;
  }

  .score-separator {
    color: #475569;
    font-weight: bold;
  }

  /* Optional: Pulse effect for our team scoring */
  .score-box:first-child {
    color: #34d399; /* Green for our team */
  }

  /* Red for opponent team */
  .score-box:last-child {
    color: #ef4444;
  }

  .player-status-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    margin-left: 0.25rem;
  }
</style>