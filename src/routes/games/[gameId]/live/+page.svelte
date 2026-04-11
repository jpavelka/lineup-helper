<script>
  import { page } from '$app/stores';
  import { onMount, onDestroy } from 'svelte';
  import { doc, getDoc, updateDoc, collection, query, where, getDocs } from 'firebase/firestore';
  import { db } from '$lib/firebase/config';
  import { authStore } from '$lib/stores/authStore';
  import { getGroupColor } from '$lib/groupColors.js';
  import { computePositionStats, computePlayerTimelines } from '$lib/utils.js';
  import MatchTimeline from '$lib/components/MatchTimeline.svelte';
  import PlayerStatsModal from '$lib/components/PlayerStatsModal.svelte';

  const gameId = $page.params.gameId;

  let game = null;
  let team = null;
  let formation = null;
  let formations = [];
  let lineup = {};
  let savedLineups = [];

  // UI & Selection State
  let selectedItem = null;
  let pitchView = false;
  let loading = true;

  // --- Timer State ---
  let now = Date.now();
  let timerInterval;
  let gameLive = false;
  let gameEnded = false;
  $: gameStarted = game?.status && game.status !== 'scheduled';

  // --- Bench Sort & Bar Mode ---
  let benchSort = 'status';
  let colorBarMode = 'timeline'; // 'grouped' | 'timeline'
  let pitchExpanded = false;
  let benchExpanded = false;

  // --- Preset lineup tracking ---
  let appliedLineupId = null;  // which saved lineup is currently on the field
  let appliedPlanStepName = null; // name of plan step currently on the field
  let pendingLineupId = null;  // which saved lineup the pending local lineup came from
  let pendingPlanStepName = null; // name of plan step loaded into pending lineup

  // --- Game plan navigation ---
  let planStepIndex = null; // null = not following plan; number = current step index

  // --- Stint tracking (playerId -> gameTimeMs when they entered current status) ---
  let stintStartMs = {};

  // --- Toast ---
  let toastMessage = '';
  let toastTimeout = null;

  function showToast(msg) {
    toastMessage = msg;
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => { toastMessage = ''; }, 4000);
  }

  // --- Modals ---
  let showPauseModal = false;
  let pauseReason = 'Halftime';
  let showEventModal = false;
  let showGoalsModal = false;
  let showPlayerStatsModal = false;
  let statsModalPlayer = null;
  let eventType = 'goal';
  let eventTeam = 'mine';
  let eventScorer = '';
  let eventAssist = '';
  let eventCard = 'yellow';
  let eventPlayer = '';

  onMount(async () => {
    const gameSnap = await getDoc(doc(db, 'games', gameId));
    game = { id: gameSnap.id, ...gameSnap.data() };

    if (!game.lineup) game.lineup = {};
    if (!game.history) game.history = [];
    if (!game.playerStats) game.playerStats = {};
    if (!game.gameTimeStats) game.gameTimeStats = { totalMs: 0, sessionStart: null };
    if (!game.score) game.score = { mine: 0, theirs: 0 };
    if (!game.gamePlan) game.gamePlan = [];
    if (!game.appliedLineupId) game.appliedLineupId = null;
    if (!game.appliedPlanStepName) game.appliedPlanStepName = null;

    lineup = { ...game.lineup };
    appliedLineupId = game.appliedLineupId;
    appliedPlanStepName = game.appliedPlanStepName;
    gameLive = game.status === 'live';
    gameEnded = game.status === 'completed';

    const teamSnap = await getDoc(doc(db, 'teams', game.teamId));
    team = teamSnap.data();

    const lineupsSnap = await getDocs(query(collection(db, 'lineups'), where('teamId', '==', game.teamId)));
    savedLineups = lineupsSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));

    // Migrate old gamePlan format: { lineupId, durationMins } → { durationMins, players, formationId }
    game.gamePlan = game.gamePlan.map(step => {
      if (step.lineupId !== undefined && !step.players) {
        const lu = savedLineups.find(l => l.id === step.lineupId);
        return { ...step, players: { ...(lu?.players ?? {}) } };
      }
      if (!step.players) step.players = {};
      return step;
    });

    const formationsSnap = await getDocs(query(collection(db, 'formations'), where('ownerId', '==', $authStore.user.uid)));
    formations = formationsSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(f => f.name).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
    formation = formations.find(f => f.id === game.formationId) ?? null;

    // Initialise stint tracking from the last sub event (or 0 if no subs yet)
    const lastSub = [...game.history].filter(e => e.lineupSnapshot).sort((a, b) => b.gameTimeMs - a.gameTimeMs)[0];
    const stintBase = lastSub ? lastSub.gameTimeMs : 0;
    (team?.roster || []).forEach(p => { stintStartMs[p.id] = stintBase; });

    // Pre-stage first game plan step for unstarted games with an empty lineup
    const hasLineup = Object.values(game.lineup).some(Boolean);
    if (game.status === 'scheduled' && !hasLineup && game.gamePlan.length > 0) {
      const firstStep = game.gamePlan[0];
      if (firstStep.formationId && firstStep.formationId !== game.formationId) {
        const stepFormation = formations.find(f => f.id === firstStep.formationId);
        if (stepFormation) { formation = stepFormation; game.formationId = firstStep.formationId; }
      }
      const availableIds = new Set(
        (team?.roster ?? []).filter(p => game.availablePlayers?.includes(p.id)).map(p => p.id)
      );
      const newLineup = {};
      for (const [posId, playerId] of Object.entries(firstStep.players ?? {})) {
        newLineup[posId] = availableIds.has(playerId) ? playerId : null;
      }
      lineup = newLineup;
      pendingPlanStepName = firstStep.name || 'Lineup 1';
      planStepIndex = 0;
    }

    loading = false;
    timerInterval = setInterval(() => { now = Date.now(); }, 1000);
  });

  onDestroy(() => { if (timerInterval) clearInterval(timerInterval); });

  // --- Derived State ---
  $: availableRoster = team?.roster.filter(p => game?.availablePlayers?.includes(p.id)) || [];
  $: appliedPlayerIds = Object.values(game?.lineup || {}).filter(id => id !== null);
  $: benchPlayers = availableRoster.filter(p => !appliedPlayerIds.includes(p.id));

  $: eventModalPlayers = (() => {
    const onFieldIds = new Set(Object.values(lineup).filter(Boolean));
    const sort = (a, b) => a.name.localeCompare(b.name);
    return {
      onField: availableRoster.filter(p => onFieldIds.has(p.id)).sort(sort),
      onBench: availableRoster.filter(p => !onFieldIds.has(p.id)).sort(sort),
    };
  })();

  $: liveGameTimeMs = (game?.gameTimeStats.totalMs ?? 0) +
    (gameLive && game?.gameTimeStats.sessionStart ? now - game.gameTimeStats.sessionStart : 0);

  $: livePlayerStats = availableRoster.map(player => {
    const base = game?.playerStats[player.id] || { activeMs: 0, benchMs: 0 };
    let currentActive = base.activeMs;
    let currentBench = base.benchMs;
    if (gameLive && game?.gameTimeStats.sessionStart) {
      const elapsed = Math.max(0, now - game.gameTimeStats.sessionStart);
      if (appliedPlayerIds.includes(player.id)) currentActive += elapsed;
      else currentBench += elapsed;
    }
    return { ...player, activeMs: currentActive, benchMs: currentBench };
  });

  // Pending subs: diff local lineup vs last saved lineup
  $: pendingSubs = (() => {
    if (!game?.lineup || !formation) return [];
    return formation.positions.reduce((acc, pos) => {
      const prev = game.lineup[pos.id] ?? null;
      const curr = lineup[pos.id] ?? null;
      if (prev !== curr) acc.push({ posName: pos.name, posId: pos.id, playerInId: curr, playerOutId: prev });
      return acc;
    }, []);
  })();

  // Goal events for scoreboard modal
  $: goalEvents = [...(game?.history || [])].filter(e => e.type === 'goal').sort((a, b) => a.gameTimeMs - b.gameTimeMs);

  $: lineupLabel = (() => {
    const appliedName = appliedPlanStepName ?? (appliedLineupId ? savedLineups.find(l => l.id === appliedLineupId)?.name ?? null : null);
    const pendingName = pendingPlanStepName ?? (pendingLineupId ? savedLineups.find(l => l.id === pendingLineupId)?.name ?? null : null);
    if (!appliedName && !pendingName) return null;
    if (!gameStarted || appliedName === pendingName) return pendingName ?? appliedName ?? 'manual lineup';
    return `${appliedName ?? 'manual lineup'} → ${pendingName ?? 'manual lineup'}`;
  })();

  // Combined + sorted player list for bench panel
  $: sortedAvailablePlayers = (() => {
    const players = availableRoster.map(p => {
      const stats = livePlayerStats.find(s => s.id === p.id) || { activeMs: 0, benchMs: 0 };
      const onField = appliedPlayerIds.includes(p.id);
      const stintMs = liveGameTimeMs - (stintStartMs[p.id] ?? 0);
      const pendingIn = gameStarted && pendingSubs.some(s => s.playerInId === p.id);
      const pendingOut = gameStarted && pendingSubs.some(s => s.playerOutId === p.id);
      return { ...p, ...stats, onField, stintMs, pendingIn, pendingOut };
    });

    switch (benchSort) {
      case 'totalField':
        return players.sort((a, b) => b.activeMs - a.activeMs || a.name.localeCompare(b.name));
      case 'benchStint':
        return players.sort((a, b) => {
          if (!a.onField && !b.onField) return b.stintMs - a.stintMs || a.name.localeCompare(b.name);
          if (!a.onField) return -1;
          if (!b.onField) return 1;
          return a.name.localeCompare(b.name);
        });
      case 'fieldStint':
        return players.sort((a, b) => {
          if (a.onField && b.onField) return b.stintMs - a.stintMs || a.name.localeCompare(b.name);
          if (a.onField) return -1;
          if (b.onField) return 1;
          return a.name.localeCompare(b.name);
        });
      case 'status':
        return players.sort((a, b) => {
          const getGroup = (p) => {
            if (!p.onField) return p.pendingOut ? 2 : 0;
            return p.pendingIn ? 1 : 3;
          };
          const aGroup = getGroup(a);
          const bGroup = getGroup(b);
          return aGroup - bGroup || a.name.localeCompare(b.name);
        });
      default: // alpha
        return players.sort((a, b) => a.name.localeCompare(b.name));
    }
  })();

  // --- Time Helpers ---
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
    game.gameTimeStats.totalMs += elapsed;
    game.gameTimeStats.sessionStart = Date.now();
    availableRoster.forEach(p => {
      if (!game.playerStats[p.id]) game.playerStats[p.id] = { activeMs: 0, benchMs: 0 };
      if (appliedPlayerIds.includes(p.id)) game.playerStats[p.id].activeMs += elapsed;
      else game.playerStats[p.id].benchMs += elapsed;
    });
  }

  // --- Match Lifecycle ---
  async function toggleLive() {
    if (gameLive) {
      pauseReason = 'Halftime';
      showPauseModal = true;
      return;
    } else {
      // Warn if not all positions are filled
      const emptyPositions = (formation?.positions || []).filter(p => !lineup[p.id]);
      if (emptyPositions.length > 0) {
        const names = emptyPositions.map(p => p.name).join(', ');
        if (!confirm(`${emptyPositions.length} position(s) are empty: ${names}.\n\nStart anyway?`)) return;
      }
      const isResume = game.status === 'paused';

      // On first start, always record the initial lineup and auto-apply any pending changes
      if (!isResume) {
        if (pendingSubs.length > 0) {
          const prevFieldIds = new Set(Object.values(game.lineup).filter(Boolean));
          const newFieldIds = new Set(Object.values(lineup).filter(Boolean));
          availableRoster.forEach(p => {
            if (prevFieldIds.has(p.id) !== newFieldIds.has(p.id)) {
              stintStartMs = { ...stintStartMs, [p.id]: 0 };
            }
          });
          game.lineup = { ...lineup };
          appliedLineupId = pendingLineupId;
          appliedPlanStepName = pendingPlanStepName;
          game.appliedLineupId = appliedLineupId;
          game.appliedPlanStepName = appliedPlanStepName;
        }
        game.history.push({ event: 'Lineup Set', timestamp: Date.now(), gameTimeMs: 0, lineupSnapshot: { ...game.lineup }, formationId: game.formationId ?? null, formationName: formation?.name ?? null });
      }

      game.gameTimeStats.sessionStart = Date.now();
      game.status = 'live';
      gameLive = true;
      changedPositionPlayers = new Set();
      game.history.push({ event: isResume ? 'Game Resumed' : 'Game Started', timestamp: Date.now(), gameTimeMs: game.gameTimeStats.totalMs });
    }
    await syncToDb();
  }

  async function confirmPause() {
    showPauseModal = false;
    commitTime();
    game.gameTimeStats.sessionStart = null;
    game.status = 'paused';
    gameLive = false;
    game.history.push({ event: `Game Paused – ${pauseReason}`, timestamp: Date.now(), gameTimeMs: game.gameTimeStats.totalMs });
    await syncToDb();
  }

  async function endMatch() {
    if (!confirm('End the match? This will stop the clock and mark the game as completed.')) return;
    commitTime();
    game.gameTimeStats.sessionStart = null;
    game.status = 'completed';
    gameLive = false;
    gameEnded = true;
    game.history.push({ event: 'Match Ended', timestamp: Date.now(), gameTimeMs: game.gameTimeStats.totalMs });
    await syncToDb();
  }

  async function resetGame() {
    if (!confirm('Reset all game data? This clears the score, timeline, player stats, and lineup. This cannot be undone.')) return;
    game.history = [];
    game.playerStats = {};
    game.gameTimeStats = { totalMs: 0, sessionStart: null };
    game.score = { mine: 0, theirs: 0 };
    game.status = 'scheduled';
    game.lineup = {};
    game.appliedLineupId = null;
    game.appliedPlanStepName = null;
    lineup = {};
    gameLive = false;
    gameEnded = false;
    stintStartMs = {};
    appliedLineupId = null;
    appliedPlanStepName = null;
    pendingLineupId = null;
    pendingPlanStepName = null;
    await syncToDb();
  }

  // --- Load Saved Lineup ---
  let changedPositionPlayers = new Set();

  async function changeFormation(formationId) {
    if (!formationId) return;
    const newFormation = formations.find(f => f.id === formationId);
    if (!newFormation) return;

    const oldPosNameMap = {};
    (formation?.positions || []).forEach(p => { oldPosNameMap[p.id] = p.name; });

    const playerOldPosName = {};
    for (const [posId, playerId] of Object.entries(lineup)) {
      if (playerId) playerOldPosName[playerId] = oldPosNameMap[posId];
    }

    const onFieldPlayers = Object.values(lineup).filter(id => id);
    const newPositions = newFormation.positions || [];
    const newLineup = {};
    const usedPlayers = new Set();
    const filledPositions = new Set();

    // First pass: match by position name
    for (const newPos of newPositions) {
      const match = onFieldPlayers.find(pid => !usedPlayers.has(pid) && playerOldPosName[pid] === newPos.name);
      if (match) {
        newLineup[newPos.id] = match;
        usedPlayers.add(match);
        filledPositions.add(newPos.id);
      }
    }

    // Second pass: fill remaining slots with unmatched players
    const unmatched = onFieldPlayers.filter(pid => !usedPlayers.has(pid));
    const emptySlots = newPositions.filter(p => !filledPositions.has(p.id));
    unmatched.forEach((pid, i) => { if (i < emptySlots.length) newLineup[emptySlots[i].id] = pid; });

    // Track players whose position name changed
    const changed = new Set();
    for (const [newPosId, playerId] of Object.entries(newLineup)) {
      const newPosName = newPositions.find(p => p.id === newPosId)?.name;
      if (playerOldPosName[playerId] !== undefined && playerOldPosName[playerId] !== newPosName) {
        changed.add(playerId);
      }
    }

    changedPositionPlayers = changed;
    formation = newFormation;
    lineup = newLineup;
    game.formationId = formationId;
    await updateDoc(doc(db, 'games', gameId), { formationId });
  }

  function loadSavedLineup(lineupId) {
    if (!lineupId) return;
    const saved = savedLineups.find(l => l.id === lineupId);
    if (!saved) return;
    // Map saved positionId -> playerId, filtering to only available players
    const availableIds = new Set(availableRoster.map(p => p.id));
    const newLineup = {};
    let missingCount = 0;
    for (const [posId, playerId] of Object.entries(saved.players || {})) {
      if (availableIds.has(playerId)) {
        newLineup[posId] = playerId;
      } else {
        newLineup[posId] = null;
        if (playerId) missingCount++;
      }
    }
    lineup = newLineup;
    pendingLineupId = lineupId;
    pendingPlanStepName = null;
    if (missingCount > 0) {
      showToast(`${missingCount} player${missingCount > 1 ? 's' : ''} from "${saved.name}" ${missingCount > 1 ? 'are' : 'is'} not available — ${missingCount > 1 ? 'their positions were' : 'their position was'} left empty.`);
    }
  }

  function loadPlanStep(i) {
    if (i < 0 || i >= (game?.gamePlan?.length ?? 0)) return;
    planStepIndex = i;
    const step = game.gamePlan[i];
    const stepName = step.name || `Lineup ${i + 1}`;

    if (step.formationId && step.formationId !== game.formationId) {
      const newFormation = formations.find(f => f.id === step.formationId);
      if (newFormation) {
        formation = newFormation;
        game.formationId = step.formationId;
        updateDoc(doc(db, 'games', gameId), { formationId: step.formationId });
      }
    }

    // Support old format where step had lineupId instead of players map
    const stepPlayers = step.players ?? (step.lineupId ? (savedLineups.find(l => l.id === step.lineupId)?.players ?? {}) : {});

    const availableIds = new Set(availableRoster.map(p => p.id));
    const newLineup = {};
    let missingCount = 0;
    for (const [posId, playerId] of Object.entries(stepPlayers)) {
      if (availableIds.has(playerId)) {
        newLineup[posId] = playerId;
      } else {
        newLineup[posId] = null;
        if (playerId) missingCount++;
      }
    }
    lineup = newLineup;
    changedPositionPlayers = new Set();
    pendingLineupId = null;
    pendingPlanStepName = stepName;
    if (missingCount > 0) {
      showToast(`${missingCount} player${missingCount > 1 ? 's' : ''} from "${stepName}" ${missingCount > 1 ? 'are' : 'is'} not available — ${missingCount > 1 ? 'their positions were' : 'their position was'} left empty.`);
    }
  }

  function getSubChain(startSub) {
    const chain = [startSub.playerInId];
    let currentOutId = startSub.playerOutId;
    while (currentOutId) {
      if (currentOutId === startSub.playerInId) break; // cycle back to start
      chain.push(currentOutId);
      const nextSub = pendingSubs.find(s => s.playerInId === currentOutId);
      if (!nextSub || !nextSub.playerOutId) break; // going to bench or empty slot
      currentOutId = nextSub.playerOutId;
    }
    return chain;
  }

  // --- Sub / Swap Logic ---
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
      if (targetType === 'slot') newLineup[targetId] = null;
    } else if (payload.type === 'bench' && targetType === 'slot') {
      newLineup[targetId] = payload.id;
    } else if (payload.type === 'slot' && targetType === 'bench') {
      newLineup[payload.id] = targetId;
    } else if (payload.type === 'slot' && targetType === 'slot') {
      const temp = newLineup[payload.id];
      newLineup[payload.id] = newLineup[targetId];
      newLineup[targetId] = temp;
    }

    lineup = newLineup;
    selectedItem = null;
    pendingLineupId = null;
    pendingPlanStepName = null;
  }

  async function applyLineup() {
    const gameStarted = game.status !== 'scheduled';

    if (gameStarted) commitTime();

    // Update stint starts for players who changed field/bench status
    const prevFieldIds = new Set(Object.values(game.lineup).filter(Boolean));
    const newFieldIds = new Set(Object.values(lineup).filter(Boolean));
    const currentGameTime = game.gameTimeStats.totalMs;
    availableRoster.forEach(p => {
      if (prevFieldIds.has(p.id) !== newFieldIds.has(p.id)) {
        stintStartMs = { ...stintStartMs, [p.id]: currentGameTime };
      }
    });

    game.lineup = { ...lineup };
    appliedLineupId = pendingLineupId;
    appliedPlanStepName = pendingPlanStepName;
    game.appliedLineupId = appliedLineupId;
    game.appliedPlanStepName = appliedPlanStepName;
    if (gameStarted) {
      game.history.push({ event: 'Substitution', timestamp: Date.now(), gameTimeMs: game.gameTimeStats.totalMs, lineupSnapshot: { ...lineup }, formationId: game.formationId ?? null, formationName: formation?.name ?? null });
    }
    await syncToDb();
  }

  // --- Event Logic ---
  async function saveEvent() {
    commitTime();
    const eventObj = { timestamp: Date.now(), gameTimeMs: game.gameTimeStats.totalMs, type: eventType };

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
    eventScorer = ''; eventAssist = ''; eventPlayer = '';
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
        score: game.score,
        appliedLineupId: game.appliedLineupId,
        appliedPlanStepName: game.appliedPlanStepName
      });
    } catch (error) {
      console.error("Firebase Sync Error:", error);
    }
  }

  function getPlayerName(playerId) {
    if (!playerId) return 'Empty';
    const player = availableRoster.find(p => p.id === playerId);
    return player ? player.name : 'Unknown';
  }

  function getPlayerLiveStats(playerId) {
    const p = livePlayerStats.find(p => p.id === playerId);
    return p ? { active: formatDuration(p.activeMs), bench: formatDuration(p.benchMs) } : { active: '0:00', bench: '0:00' };
  }

  $: basePositionStats = computePositionStats(game?.history || [], formation);

  // Add the currently-running session's elapsed time on top of the base
  $: livePositionStats = (() => {
    const result = {};
    for (const [pid, s] of Object.entries(basePositionStats)) {
      result[pid] = { positionMs: { ...s.positionMs }, groupMs: { ...s.groupMs } };
    }
    if (gameLive && game?.gameTimeStats.sessionStart) {
      const elapsed = Math.max(0, now - game.gameTimeStats.sessionStart);
      Object.entries(game.lineup || {}).forEach(([posId, playerId]) => {
        if (!playerId) return;
        if (!result[playerId]) result[playerId] = { positionMs: {}, groupMs: {} };
        result[playerId].positionMs[posId] = (result[playerId].positionMs[posId] || 0) + elapsed;
        const group = formation?.positions.find(p => p.id === posId)?.group;
        if (group) result[playerId].groupMs[group] = (result[playerId].groupMs[group] || 0) + elapsed;
      });
    }
    return result;
  })();

  $: basePlayerTimelines = computePlayerTimelines(game?.history || [], formation, availableRoster);

  $: livePlayerTimelines = (() => {
    const result = {};
    for (const [pid, segs] of Object.entries(basePlayerTimelines)) result[pid] = [...segs];
    if (gameLive && game?.gameTimeStats.sessionStart) {
      const segStart = game.gameTimeStats.totalMs;
      const segEnd = liveGameTimeMs;
      if (segEnd > segStart) {
        availableRoster.forEach(p => {
          if (!result[p.id]) result[p.id] = [];
          const posId = Object.keys(game.lineup || {}).find(k => game.lineup[k] === p.id);
          const group = posId ? (formation?.positions.find(fp => fp.id === posId)?.group ?? null) : null;
          result[p.id].push({ startMs: segStart, endMs: segEnd, group: appliedPlayerIds.includes(p.id) ? group : null });
        });
      }
    }
    return result;
  })();
</script>

{#if loading}
  <div class="loading">Loading Live Editor...</div>
{:else}
  <!-- MATCH HEADER -->
  <header class="live-header">
    <div class="match-overview">
      <div class="match-title-group">
        <a href="/games/{gameId}" class="back-link">← Dashboard</a>
        <span class="match-name">{game.homeAway === 'away' ? '@' : 'vs'} {game.opponent || 'TBD'}</span>
      </div>

      <!-- Scoreboard — click to see goals -->
      <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
      <div class="scoreboard" class:clickable={goalEvents.length > 0} on:click={() => goalEvents.length > 0 && (showGoalsModal = true)} title={goalEvents.length > 0 ? 'View goals' : ''}>
        <span class="score">{game.score.mine}</span>
        <span class="divider">-</span>
        <span class="score">{game.score.theirs}</span>
        {#if goalEvents.length > 0}<span class="goals-hint">⚽</span>{/if}
      </div>

      <div class="clock-display">
        <span class="time">{formatDuration(liveGameTimeMs)}</span>
        <span class="status-badge" class:live={gameLive} class:ended={gameEnded}>
          {gameEnded ? 'ENDED' : gameLive ? 'LIVE' : game.status === 'scheduled' ? 'NOT STARTED' : 'PAUSED'}
        </span>
      </div>
    </div>

    <div class="match-actions">
      {#if !gameEnded}
        <div class="actions-row">
          <button class="btn-live {gameLive ? 'stop' : 'start'}" on:click={toggleLive}>
            {gameLive ? 'Pause' : game.status === 'scheduled' ? 'Start' : 'Resume'}
          </button>
        </div>
        <div class="actions-row">
          <button class="btn-secondary" on:click={() => showEventModal = true}>+ Event</button>
          <button class="btn-end" on:click={endMatch}>End</button>
          <button class="btn-reset" on:click={resetGame} title="Reset game">↺ Reset</button>
        </div>
      {:else}
        <button class="btn-reset" on:click={resetGame} title="Reset game">↺ Reset</button>
      {/if}
    </div>
  </header>

  <!-- GAME PLAN NAVIGATOR -->
  {#if game.gamePlan?.length > 0}
    <div class="plan-nav">
      <span class="plan-nav-label">Game Plan</span>
      <div class="plan-nav-bottom">
        <div class="plan-steps">
          {#each game.gamePlan as step, i}
            {@const name = step.name || `Lineup ${i + 1}`}
            <button
              class="plan-step-chip"
              class:active={name === appliedPlanStepName}
              class:pending={name === pendingPlanStepName && name !== appliedPlanStepName}
              on:click={() => loadPlanStep(i)}
              title="{name} · {step.durationMins} min"
            >
              <span class="chip-name">{name}</span>
              <span class="chip-dur">{step.durationMins}′</span>
            </button>
          {/each}
        </div>
        <div class="plan-nav-arrows">
          <button class="plan-arrow" disabled={planStepIndex === null || planStepIndex <= 0} on:click={() => loadPlanStep((planStepIndex ?? 1) - 1)}>‹</button>
          <button class="plan-arrow" disabled={planStepIndex !== null && planStepIndex >= game.gamePlan.length - 1} on:click={() => loadPlanStep(planStepIndex === null ? 0 : planStepIndex + 1)}>›</button>
        </div>
      </div>
    </div>
  {/if}

  <!-- PITCH & PLAYERS LAYOUT -->
  <div class="layout-grid" class:any-expanded={pitchExpanded || benchExpanded}>

    <div class="panel pitch-panel" class:expanded={pitchExpanded} class:sibling-expanded={!pitchExpanded && benchExpanded}>
      <div class="pitch-header">
        <div class="pitch-header-title">
          <h2>On Field</h2>
          {#if !gameEnded}
            <button class="btn-primary" on:click={applyLineup} style="margin-left:5pt" disabled={pendingSubs.length === 0 || game.status === 'scheduled'}>Apply Subs</button>
          {/if}
          <div class="view-toggle">
            <button class:active={!pitchView} on:click={() => pitchView = false}>List</button>
            <button class:active={pitchView} on:click={() => pitchView = true}>Field</button>
          </div>
          <button class="btn-expand" on:click={() => pitchExpanded = !pitchExpanded}>{pitchExpanded ? '⤡' : '⤢'}</button>
        </div>
        <div class="pitch-header-actions">
          {#if !gameEnded}
            <button class="btn-secondary btn-sub-action" on:click={() => { lineup = { ...game.lineup }; pendingLineupId = appliedLineupId; pendingPlanStepName = appliedPlanStepName; selectedItem = null; }} disabled={pendingSubs.length === 0}>Clear</button>
          {/if}
          <!-- svelte-ignore a11y-no-onchange -->
          <select class="lineup-select" value={game.formationId ?? ''} on:change={(e) => changeFormation(e.target.value)}>
            <option value="">Formation…</option>
            {#each formations.filter(f => game.playersOnField == null || (f.positions?.length ?? 0) === game.playersOnField) as f}
              <option value={f.id}>{f.name}</option>
            {/each}
          </select>
          <select class="lineup-select"
            on:mousedown={(e) => { if (!game.formationId) { e.preventDefault(); alert('Select a formation first.'); } }}
            on:change={(e) => { loadSavedLineup(e.target.value); e.target.value = ''; }}>
            <option value="">Load lineup…</option>
            {#each savedLineups.filter(sl => !game.formationId || sl.formationId === game.formationId) as sl}
              <option value={sl.id}>{sl.name}</option>
            {/each}
          </select>
        </div>
      </div>
      {#if lineupLabel}
        <div class="lineup-label">{lineupLabel}</div>
      {/if}

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
                <div class="field-node-label" class:pos-changed={gameStarted && changedPositionPlayers.has(lineup[pos.id])}>{lineup[pos.id] ? getPlayerName(lineup[pos.id]) : '—'}</div>
              </div>
            {/each}
          </div>
        </div>
      {:else}
        <div class="slots-container" class:expanded={pitchExpanded}>
          {#each formation?.positions || [] as pos}
            {@const color = getGroupColor(pos.group)}
            {@const pendingSub = pendingSubs.find(s => s.posId === pos.id)}
            <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
            <div class="slot-card"
                 class:selected={selectedItem?.type === 'slot' && selectedItem?.id === pos.id}
                 class:empty={!lineup[pos.id]}
                 class:has-pending={gameStarted && !!pendingSub}
                 on:click={() => handleSlotClick(pos.id)}>
              <div class="pos-badge" style="background: {color.bg}; color: {color.text};">{pos.name}</div>
              <div class="player-info">
                {#if gameStarted && pendingSub}
                  {#if pendingSub.playerInId}
                    {@const fromPosId = Object.entries(game.lineup).find(([, pid]) => pid === pendingSub.playerInId)?.[0]}
                    {@const fromPosName = fromPosId ? formation.positions.find(p => p.id === fromPosId)?.name : null}
                    {@const chain = getSubChain(pendingSub)}
                    <span class="player-name sub-name-in">{getPlayerName(pendingSub.playerInId)}{#if fromPosName}&nbsp;<span class="pos-move">({fromPosName}→{pendingSub.posName})</span>{/if}
                      {#if chain.length > 2 && !Object.values(game.lineup).includes(pendingSub.playerInId)}
                        {@const playerOut = 'for ' + getPlayerName(chain[chain.length - 1])}
                        {@const playersMoving = chain.toReversed().slice(1, chain.length - 1).map(playerId => {
                            const pendSub = [...pendingSubs].find(s => s.playerInId === playerId);
                            const pos = pendSub ? pendSub.posName : 'bench';
                            return `${getPlayerName(playerId)} → ${pos}`;
                        }).join(', ')}
                        <span class="pos-move">
                          ({playerOut}, {playersMoving})
                        </span>
                      {/if}</span>
                  {/if}
                  {#if pendingSub.playerOutId}
                    {@const movingToSub = pendingSubs.find(s => s.playerInId === pendingSub.playerOutId)}
                    {#if movingToSub}
                      <span class="player-name sub-name-move">({getPlayerName(pendingSub.playerOutId)} → {movingToSub.posName})</span>
                    {:else}
                    <span class="player-name sub-name-bench">{getPlayerName(pendingSub.playerOutId)}</span>
                    {/if}
                  {/if}
                {:else}
                  <span class="player-name" class:pos-changed={gameStarted && changedPositionPlayers.has(lineup[pos.id])}>{getPlayerName(lineup[pos.id])}</span>
                  {#if lineup[pos.id]}
                    <span class="player-time active-color">Field: {formatDuration(livePlayerStats.find(p => p.id === lineup[pos.id])?.activeMs ?? 0)}</span>
                  {/if}
                {/if}
              </div>
              {#if gameStarted && pendingSub}
                <button class="btn-restore" title="Restore current player" on:click|stopPropagation={() => { lineup = { ...lineup, [pos.id]: game.lineup[pos.id] ?? null }; selectedItem = null; pendingLineupId = null; pendingPlanStepName = null; }}>↺</button>
              {:else if lineup[pos.id]}
                <button class="btn-remove" on:click|stopPropagation={() => executeSwap('slot', pos.id)}>×</button>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <div class="panel bench-panel" class:expanded={benchExpanded} class:sibling-expanded={!benchExpanded && pitchExpanded}>
      <div class="bench-header">
        <h2>Players</h2>
        <button class="btn-expand" on:click={() => benchExpanded = !benchExpanded}>{benchExpanded ? '⤡' : '⤢'}</button>
        <div class="bench-header-controls">
          <div class="bar-mode-toggle">
            <button class:active={colorBarMode === 'timeline'} on:click={() => colorBarMode = 'timeline'}>Timeline</button>
            <button class:active={colorBarMode === 'grouped'} on:click={() => colorBarMode = 'grouped'}>Grouped</button>
          </div>
          <select class="sort-select" bind:value={benchSort}>
            <option value="status">By Status</option>
            <option value="alpha">A–Z</option>
            <option value="totalField">Most Field Time</option>
            <option value="benchStint">Longest on Bench</option>
            <option value="fieldStint">Longest on Field</option>
          </select>
        </div>
      </div>
      <div class="bench-container" class:expanded={benchExpanded}>
        {#each sortedAvailablePlayers as player}
          <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
          <div class="bench-card"
               class:selected={selectedItem?.type === 'bench' && selectedItem?.id === player.id}
               class:on-field={player.onField}
               class:pending-in={player.pendingIn}
               class:pending-out={player.pendingOut}
               on:click={() => !player.onField && handleBenchClick(player.id)}>
            <div class="bench-card-row">
              <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
              <span class="btn-player-info" title="View position stats" on:click|stopPropagation={() => { statsModalPlayer = player; showPlayerStatsModal = true; }}>i</span>
              <div class="player-info">
                <span class="player-name">#{player.number} {player.name}</span>
                <span class="player-time {player.onField ? 'active-color' : 'bench-color'}">
                  {player.onField ? 'Field: ' + getPlayerLiveStats(player.id).active : 'Bench: ' + getPlayerLiveStats(player.id).bench}
                </span>
              </div>
              <div class="time-totals">
                <span class="time-total active-color">F {getPlayerLiveStats(player.id).active}</span>
                <span class="time-total bench-color">B {getPlayerLiveStats(player.id).bench}</span>
              </div>
              {#if player.pendingIn}
                <span class="sub-badge sub-badge-in">↑ IN</span>
              {:else if player.pendingOut}
                <span class="sub-badge sub-badge-out">↓ OUT</span>
              {:else if player.onField}
                <span class="field-dot">▶</span>
              {/if}
            </div>
            {#if liveGameTimeMs > 0}
              <div class="color-bar">
                {#if colorBarMode === 'timeline'}
                  {#each livePlayerTimelines[player.id] ?? [] as seg}
                    <div class="bar-seg" style="width:{((seg.endMs - seg.startMs) / liveGameTimeMs * 100).toFixed(2)}%;background:{getGroupColor(seg.group).bg};"></div>
                  {/each}
                {:else}
                  {@const ps = livePositionStats[player.id] || { groupMs: {} }}
                  {@const benchMs = livePlayerStats.find(p => p.id === player.id)?.benchMs ?? 0}
                  {@const groupSegs = [...Object.entries(ps.groupMs).sort((a,b) => b[1]-a[1]), [null, benchMs]].filter(([,ms]) => ms > 0)}
                  {#each groupSegs as [group, ms]}
                    <div class="bar-seg" style="width:{(ms / liveGameTimeMs * 100).toFixed(2)}%;background:{getGroupColor(group).bg};"></div>
                  {/each}
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  </div>

  <!-- MATCH TIMELINE -->
  <div class="panel timeline-panel">
    <h2>Match Timeline</h2>
    <MatchTimeline
      history={game.history}
      roster={availableRoster}
      {gameId}
      {formation}
      allowEditing={true}
      on:updated={(e) => { game.history = e.detail; }}
    />
  </div>
{/if}

<!-- TOAST -->
{#if toastMessage}
  <div class="toast">{toastMessage}</div>
{/if}

<!-- PAUSE MODAL -->
{#if showPauseModal}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="modal-backdrop" on:click={() => showPauseModal = false}>
    <div class="modal-panel" on:click|stopPropagation>
      <h2>Pause Game</h2>
      <div class="pause-reasons">
        {#each ['Halftime', 'Injury', 'Water Break', 'End of Reg.', 'Other'] as reason}
          <button
            class="pause-reason-btn"
            class:selected={pauseReason === reason}
            on:click={() => pauseReason = reason}
          >{reason}</button>
        {/each}
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" on:click={() => showPauseModal = false}>Cancel</button>
        <button class="btn-primary" on:click={confirmPause}>Pause</button>
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
              <optgroup label="On Field">
                {#each eventModalPlayers.onField as p}<option value={p.id}>{p.name}</option>{/each}
              </optgroup>
              <optgroup label="On Bench">
                {#each eventModalPlayers.onBench as p}<option value={p.id}>{p.name}</option>{/each}
              </optgroup>
            </select>
          </div>
          <div class="form-group">
            <label>Assist (Optional)</label>
            <select bind:value={eventAssist}>
              <option value="">-- None --</option>
              <optgroup label="On Field">
                {#each eventModalPlayers.onField as p}<option value={p.id}>{p.name}</option>{/each}
              </optgroup>
              <optgroup label="On Bench">
                {#each eventModalPlayers.onBench as p}<option value={p.id}>{p.name}</option>{/each}
              </optgroup>
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
            <optgroup label="On Field">
              {#each eventModalPlayers.onField as p}<option value={p.id}>{p.name}</option>{/each}
            </optgroup>
            <optgroup label="On Bench">
              {#each eventModalPlayers.onBench as p}<option value={p.id}>{p.name}</option>{/each}
            </optgroup>
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

<!-- GOALS MODAL -->
{#if showGoalsModal}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="modal-backdrop" on:click={() => showGoalsModal = false}>
    <div class="modal-panel" on:click|stopPropagation>
      <div class="goals-modal-header">
        <h2>Goals</h2>
        <div class="score-display">{game.score.mine} – {game.score.theirs}</div>
      </div>
      {#if goalEvents.length === 0}
        <p class="goals-empty">No goals recorded yet.</p>
      {:else}
        <div class="goals-list">
          {#each goalEvents as ev}
            <div class="goal-row" class:ours={ev.event === 'Goal (Us)'}>
              <span class="goal-time">{formatDuration(ev.gameTimeMs)}</span>
              <span class="goal-icon">{ev.event === 'Goal (Us)' ? '⚽' : '🚫'}</span>
              <div class="goal-detail">
                <span class="goal-type">{ev.event === 'Goal (Us)' ? 'Goal' : 'Goal Conceded'}</span>
                {#if ev.playerId}
                  <span class="goal-player">{getPlayerName(ev.playerId)}</span>
                {/if}
                {#if ev.assistId}
                  <span class="goal-assist">Assist: {getPlayerName(ev.assistId)}</span>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}
      <div class="modal-actions">
        <button class="btn-primary" on:click={() => showGoalsModal = false}>Close</button>
      </div>
    </div>
  </div>
{/if}

<!-- PLAYER STATS MODAL -->
{#if showPlayerStatsModal && statsModalPlayer}
  <PlayerStatsModal
    player={statsModalPlayer}
    activeMs={livePlayerStats.find(p => p.id === statsModalPlayer.id)?.activeMs ?? 0}
    benchMs={livePlayerStats.find(p => p.id === statsModalPlayer.id)?.benchMs ?? 0}
    positionStats={livePositionStats[statsModalPlayer.id] || { positionMs: {}, groupMs: {} }}
    timelineSegments={livePlayerTimelines[statsModalPlayer.id] ?? []}
    totalGameMs={liveGameTimeMs}
    {formation}
    on:close={() => showPlayerStatsModal = false}
  />
{/if}

<style>
  .loading { padding: 3rem; text-align: center; color: #94a3b8; }

  /* ─── Header ─── */
  .live-header {
    display: flex; justify-content: space-between; align-items: center;
    background: #111827; padding: 1rem 1.5rem; border-radius: 1rem;
    border: 1px solid #334155; margin-bottom: 0.75rem; flex-wrap: wrap; gap: 1rem;
  }
  .match-overview { display: flex; align-items: center; gap: 1.5rem; flex-wrap: wrap; }
  .match-title-group { display: flex; flex-direction: column; gap: 0.15rem; }
  .back-link { color: #3b82f6; text-decoration: none; font-size: 0.9rem; font-weight: bold; }
  .back-link:hover { text-decoration: underline; }
  .match-name { font-size: 1rem; font-weight: 700; color: #f8fafc; }

  .scoreboard {
    background: #000; padding: 0.5rem 1rem; border-radius: 0.5rem;
    display: flex; gap: 0.75rem; align-items: center;
    font-family: monospace; font-size: 1.75rem; font-weight: bold;
  }
  .scoreboard.clickable { cursor: pointer; transition: background 0.15s; }
  .scoreboard.clickable:hover { background: #1a1a1a; }
  .divider { color: #475569; }
  .goals-hint { font-size: 0.9rem; margin-left: 0.25rem; opacity: 0.7; }

  .clock-display { display: flex; flex-direction: column; align-items: flex-start; gap: 0.25rem; }
  .time { font-size: 1.5rem; font-weight: bold; font-variant-numeric: tabular-nums; }
  .status-badge { padding: 0.1rem 0.5rem; border-radius: 1rem; background: #475569; font-size: 0.75rem; font-weight: bold; letter-spacing: 1px; }
  .status-badge.live { background: #ef4444; color: white; animation: blink 2s infinite; }
  .status-badge.ended { background: #334155; color: #94a3b8; }
  @keyframes blink { 50% { opacity: 0.6; } }

  .match-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
  .actions-row { display: flex; gap: 0.5rem; }
  @media (max-width: 799px) {
    .live-header { flex-direction: column; align-items: stretch; }
    .match-actions { width: 100%; flex-direction: column; }
    .actions-row { width: 100%; }
    .actions-row > * { flex: 1; min-width: 0; }
  }
  button { border: none; padding: 0.75rem 1.25rem; border-radius: 0.5rem; font-weight: bold; cursor: pointer; color: white; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-live.start { background: #10b981; }
  .btn-live.stop { background: #f59e0b; }
  .btn-primary { background: #3b82f6; }
  .btn-secondary { background: #334155; }
  .btn-end { background: #7f1d1d; color: #fca5a5; }
  .btn-end:hover { background: #991b1b; }
  .btn-reset { background: transparent; border: 1px solid #334155; color: #64748b; font-size: 0.85rem; padding: 0.5rem 0.75rem; }
  .btn-reset:hover { background: #1e293b; color: #94a3b8; }

  /* ─── Game plan navigator ─── */
  .plan-nav {
    display: flex; flex-direction: column; align-items: flex-start; gap: 0.35rem;
    background: #0f172a; border: 1px solid #1e293b; border-radius: 0.6rem;
    padding: 0.4rem 0.6rem; margin-bottom: 0.6rem; overflow: hidden;
  }
  .plan-nav-label { font-size: 0.9rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }
  .plan-nav-bottom { display: flex; align-items: center; gap: 0.5rem; width: 100%; overflow: hidden; }
  .plan-steps { display: flex; gap: 0.3rem; overflow-x: auto; flex: 1; padding-bottom: 1px; }
  .plan-steps::-webkit-scrollbar { display: none; }
  .plan-step-chip {
    display: flex; align-items: center; gap: 0.3rem;
    background: #1e293b; border: 1px solid #334155; color: #64748b;
    padding: 0.4rem 0.5rem; border-radius: 0.4rem; cursor: pointer;
    font-size: 0.75rem; white-space: nowrap; flex-shrink: 0; transition: all 0.15s;
  }
  .plan-step-chip:hover { background: #334155; color: #cbd5e1; }
  .plan-step-chip.active { background: #1e3a5f; border-color: #3b82f6; color: #93c5fd; }
  .plan-step-chip.pending { background: #2d1f08; border-color: #d97706; color: #fcd34d; }
  .chip-num { font-weight: 700; color: #475569; font-size: 0.65rem; }
  .plan-step-chip.active .chip-num { color: #60a5fa; }
  .plan-step-chip.pending .chip-num { color: #f59e0b; }
  .chip-name { font-weight: 600; }
  .chip-dur { color: #475569; font-size: 0.65rem; }
  .plan-step-chip.active .chip-dur { color: #60a5fa; }
  .plan-step-chip.pending .chip-dur { color: #f59e0b; }
  .plan-nav-arrows { display: flex; gap: 0.2rem; flex-shrink: 0; }
  .plan-arrow {
    background: #1e293b; border: 1px solid #334155; color: #94a3b8;
    width: 1.6rem; height: 1.6rem; border-radius: 0.3rem; cursor: pointer;
    font-size: 1rem; display: flex; align-items: center; justify-content: center; padding: 0;
    transition: all 0.15s;
  }
  .plan-arrow:not(:disabled):hover { background: #334155; color: #f8fafc; }
  .plan-arrow:disabled { opacity: 0.3; cursor: not-allowed; }

  /* ─── Layout ─── */
  .layout-grid {
    display: flex; flex-direction: column; gap: 1rem;
    height: calc(100vh - 100px);
  }
  .layout-grid.any-expanded { height: auto; }
  .panel {
    background: #111827; border: 1px solid #334155; border-radius: 1rem;
    padding: 1rem; display: flex; flex-direction: column; overflow: hidden;
  }
  .pitch-panel { flex: 1.2; }
  .bench-panel { flex: 1; }
  .panel.expanded { flex: none; height: auto; overflow: visible; }
  .panel.sibling-expanded { flex: none; height: 45vh; }
  .slots-container.expanded, .bench-container.expanded { overflow-y: visible; height: auto; flex: none; }

  .btn-expand {
    background: transparent; border: 1px solid #334155; color: #64748b;
    width: 1.5rem; height: 1.5rem; border-radius: 0.3rem; cursor: pointer;
    font-size: 0.85rem; display: flex; align-items: center; justify-content: center;
    padding: 0; flex-shrink: 0;
  }
  .btn-expand:hover { background: #334155; color: #f8fafc; }

  h2 { margin-top: 0; font-size: 1rem; color: #cbd5e1; border-bottom: 1px solid #334155; padding-bottom: 0.5rem; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.75rem; }

  /* ─── Pitch panel ─── */
  .pitch-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #334155; padding-bottom: 0.5rem; margin-bottom: 0.75rem; gap: 0.5rem; flex-wrap: wrap; }
  .lineup-label { font-size: 0.72rem; color: #f8fafc; margin-bottom: 0.5rem; font-style: italic; font-weight: bold;}
  .pitch-header-title { display: flex; align-items: center; gap: 0.5rem; flex: 1; }
  .pitch-header h2 { margin: 0; border: none; padding: 0; }
  .pitch-header-actions { display: flex; align-items: center; gap: 0.5rem; margin-left: auto; }
  .lineup-select { background: #0f172a; border: 1px solid #334155; color: #cbd5e1; padding: 0.5rem 0.5rem; border-radius: 0.35rem; font-size: 0.78rem; cursor: pointer; outline: none; max-width: 130px; }
  .btn-sub-action { padding: 0.5rem 0.6rem; font-size: 0.78rem; border-radius: 0.35rem; }
  .view-toggle { display: flex; background: #0f172a; border-radius: 0.4rem; padding: 0.15rem; margin-left: auto; }
  .view-toggle button { background: transparent; border: none; color: #64748b; padding: 0.25rem 0.6rem; border-radius: 0.3rem; cursor: pointer; font-size: 0.75rem; font-weight: 600; }
  .view-toggle button.active { background: #334155; color: #f8fafc; }

  .slots-container, .bench-container {
    overflow-y: auto; flex: 1; padding-right: 0.25rem;
    display: flex; flex-direction: column; gap: 0.5rem;
  }
  .slots-container::-webkit-scrollbar, .bench-container::-webkit-scrollbar { width: 4px; }
  .slots-container::-webkit-scrollbar-thumb, .bench-container::-webkit-scrollbar-thumb { background: #334155; border-radius: 2px; }
  .slots-container { display: grid; }

  .slot-card, .bench-card {
    display: flex; align-items: center; gap: 0.5rem;
    background: #1e293b; border: 2px solid transparent; border-radius: 0.5rem;
    padding: 0.3rem 0.5rem; cursor: pointer; transition: all 0.1s; min-height: 50px;
  }
  .bench-card { flex-direction: column; align-items: stretch; gap: 0.35rem; padding-bottom: 0.3rem; flex-shrink: 0; }
  .bench-card-row { display: flex; align-items: center; gap: 0.5rem; }
  .color-bar { display: flex; height: 5px; border-radius: 3px; overflow: hidden; background: #0f172a; }
  .bar-seg { flex-shrink: 0; height: 100%; }
  .slot-card.empty { border: 1px dashed #475569; background: #0f172a; }
  .slot-card.selected, .bench-card.selected { border-color: #3b82f6; background: rgba(59,130,246,0.15); box-shadow: 0 0 10px rgba(59,130,246,0.3); }
  .slot-card.has-pending { border-color: #f59e0b; background: rgba(245,158,11,0.08); }
  .sub-name-in { color: #34d399; }
  .pos-move { font-size: 0.78rem; opacity: 0.8; font-weight: 400; }
  .sub-name-move { color: #fb923c; font-size: 0.8rem; }
  .sub-name-bench { color: #f87171; font-size: 0.8rem; text-decoration: line-through; }

  .pos-badge { background: #334155; padding: 0.1rem 0.4rem; border-radius: 0.25rem; font-weight: bold; font-size: 0.75rem; min-width: 40px; text-align: center; color: #94a3b8; }

  .player-info { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
  .player-name { font-size: 1rem; font-weight: 600; color: #f8fafc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pos-changed { color: #fb923c; }
  .field-node-label.pos-changed { color: #fb923c; }
  .player-time { font-size: 0.7rem; font-weight: 500; margin-top: 0.05rem; }
  .active-color { color: #34d399; }
  .bench-color { color: #94a3b8; }

  .btn-remove { background: #7f1d1d; color: white; width: 22px; height: 22px; border-radius: 50%; padding: 0; font-size: 0.8rem; flex-shrink: 0; }
  .btn-restore { background: #92400e; color: #fcd34d; width: 22px; height: 22px; border-radius: 50%; padding: 0; font-size: 0.9rem; flex-shrink: 0; line-height: 1; }

  /* ─── Bench / Players panel ─── */
  .bench-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #334155; padding-bottom: 0.5rem; margin-bottom: 0.75rem; gap: 0.5rem; flex-wrap: wrap; }
  .bench-header h2 { margin: 0; border: none; padding: 0; }
  .bench-header-controls { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .sort-select { background: #0f172a; border: 1px solid #334155; color: #cbd5e1; padding: 0.25rem 0.5rem; border-radius: 0.35rem; font-size: 0.78rem; cursor: pointer; outline: none; }
  .bar-mode-toggle { display: flex; background: #0f172a; border-radius: 0.4rem; padding: 0.15rem; }
  .bar-mode-toggle button { background: transparent; border: none; color: #64748b; padding: 0.2rem 0.5rem; border-radius: 0.3rem; cursor: pointer; font-size: 0.72rem; font-weight: 600; }
  .bar-mode-toggle button.active { background: #334155; color: #f8fafc; }

  .bench-card.on-field { background: #0f1f0f; border-color: #166534; cursor: default; opacity: 0.75; }
  .bench-card.pending-in { border-color: #10b981; background: rgba(16,185,129,0.1); }
  .bench-card.pending-out { border-color: #f87171; background: rgba(248,113,113,0.08); }

  .sub-badge { font-size: 0.68rem; font-weight: 800; padding: 0.15rem 0.4rem; border-radius: 0.25rem; flex-shrink: 0; }
  .sub-badge-in { background: #064e3b; color: #34d399; }
  .sub-badge-out { background: #7f1d1d; color: #fca5a5; }
  .field-dot { color: #166534; font-size: 0.7rem; flex-shrink: 0; }
  .btn-player-info {
    flex-shrink: 0; cursor: pointer;
    width: 1.25rem; height: 1.25rem; border-radius: 50%;
    border: 1.5px solid #60a5fa; color: #60a5fa;
    font-size: 0.7rem; font-weight: 700; font-style: italic;
    display: flex; align-items: center; justify-content: center;
    line-height: 1; transition: background 0.15s, color 0.15s;
  }
  .btn-player-info:hover { background: #60a5fa; color: #0f172a; }

  .time-totals { display: flex; flex-direction: column; align-items: flex-end; gap: 0.1rem; flex-shrink: 0; margin-right: 0.25rem; }
  .time-total { font-size: 0.68rem; font-weight: 600; font-variant-numeric: tabular-nums; }

  /* ─── Toast ─── */
  .toast {
    position: fixed; bottom: 1.5rem; left: 50%; transform: translateX(-50%);
    background: #1e3a5f; border: 1px solid #3b82f6; color: #bfdbfe;
    padding: 0.75rem 1.25rem; border-radius: 0.6rem;
    font-size: 0.88rem; font-weight: 500; z-index: 200;
    max-width: 90vw; text-align: center;
    box-shadow: 0 4px 16px rgba(0,0,0,0.5);
    animation: toast-in 0.2s ease;
  }
  @keyframes toast-in { from { opacity: 0; transform: translateX(-50%) translateY(8px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }

  /* ─── Field view ─── */
  .field-wrap { flex: 1; display: flex; justify-content: center; padding: 0.5rem 0; overflow: auto; max-height: 450px; }
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
  .field-node-label { font-size: 0.58rem; color: #f1f5f9; text-shadow: 0 1px 3px rgba(0,0,0,0.9); margin-top: 0.1rem; max-width: 3.5rem; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }


  /* ─── Wider screens ─── */
  @media (min-width: 800px) {
    .layout-grid { display: grid; grid-template-columns: 1.5fr 1fr; height: auto; }
    .pitch-panel, .bench-panel { flex: none; height: auto; }
    .btn-expand { display: none; }
    .slots-container, .bench-container { overflow-y: visible; height: auto; display: flex; flex-direction: column; }
    .slots-container { display: flex; }
    .panel { padding: 1.5rem; overflow: visible; }
    h2 { font-size: 1.2rem; }
    .player-name { font-size: 1.1rem; }
    .player-time { font-size: 0.8rem; }
    .pos-badge { font-size: 0.9rem; padding: 0.25rem 0.5rem; }
    .btn-remove { width: 28px; height: 28px; font-size: 1rem; }
    .field-container { max-width: 320px; }
    .field-node { width: 2.6rem; height: 2.6rem; font-size: 0.7rem; }
    .field-node-label { font-size: 0.65rem; max-width: 4.5rem; }
  }

  /* ─── Modals ─── */
  .pause-reasons { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1.5rem; }
  .pause-reason-btn { background: #1e293b; border: 1px solid #334155; color: #cbd5e1; padding: 0.65rem 1rem; border-radius: 0.5rem; cursor: pointer; font-size: 0.95rem; text-align: left; }
  .pause-reason-btn:hover { background: #334155; }
  .pause-reason-btn.selected { border-color: #3b82f6; background: rgba(59,130,246,0.15); color: #f8fafc; }
  .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.8); display: flex; justify-content: center; align-items: center; z-index: 100; }
  .modal-panel { background: #111827; padding: 2rem; border-radius: 1rem; border: 1px solid #334155; width: 100%; max-width: 400px; max-height: 90vh; overflow-y: auto; }
  .form-group { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1rem; }
  .form-group label { color: #cbd5e1; font-size: 0.9rem; }
  .form-group select { background: #0f172a; border: 1px solid #334155; color: white; padding: 0.75rem; border-radius: 0.5rem; font-size: 1rem; outline: none; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 1rem; margin-top: 1.5rem; }

  /* Goals modal */
  .goals-modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.25rem; }
  .goals-modal-header h2 { margin: 0; }
  .score-display { font-family: monospace; font-size: 1.5rem; font-weight: bold; background: #000; padding: 0.25rem 0.75rem; border-radius: 0.4rem; }
  .goals-list { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1rem; }
  .goal-row { display: flex; align-items: center; gap: 0.75rem; background: #0f172a; padding: 0.6rem 0.85rem; border-radius: 0.5rem; border-left: 3px solid #334155; }
  .goal-row.ours { border-left-color: #10b981; }
  .goal-time { font-family: monospace; font-size: 0.85rem; color: #94a3b8; width: 2.5rem; flex-shrink: 0; }
  .goal-icon { font-size: 1rem; flex-shrink: 0; }
  .goal-detail { display: flex; flex-direction: column; gap: 0.1rem; }
  .goal-type { font-weight: 600; color: #f8fafc; font-size: 0.9rem; }
  .goal-player { color: #34d399; font-size: 0.85rem; }
  .goal-assist { color: #64748b; font-size: 0.8rem; }
  .goals-empty { color: #475569; text-align: center; padding: 1.5rem 0; margin: 0; }

  /* ─── Player stats modal ─── */

  /* ─── Timeline panel ─── */
  .timeline-panel { margin-top: 1rem; }
  .timeline-panel h2 { font-size: 1rem; color: #cbd5e1; border-bottom: 1px solid #334155; padding-bottom: 0.5rem; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.75rem; }
</style>
