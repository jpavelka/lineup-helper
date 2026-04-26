<script>
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { beforeNavigate } from '$app/navigation';
  import { doc, getDoc, updateDoc, addDoc, collection, getDocs, query, where } from 'firebase/firestore';
  import { db } from '$lib/firebase/config';
  import { authStore } from '$lib/stores/authStore';
  import MatchTimeline from '$lib/components/MatchTimeline.svelte';
  import PlayerStatsModal from '$lib/components/PlayerStatsModal.svelte';
  import AddEventModal from '$lib/components/AddEventModal.svelte';
  import { computePositionStats, computePlayerTimelines, generateUUID } from '$lib/utils.js';
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
  let statsBarMode = 'timeline'; // 'grouped' | 'timeline'
  let planBarMode = 'timeline'; // 'grouped' | 'timeline'
  let planSort = 'name'; // 'name' | 'time'
  let showPlanStatsModal = false;
  let planStatsModalPlayer = null;
  let savedLineups = [];
  let showAddEventModal = false;

  // --- Player picker modal (mobile long-press / desktop right-click) ---
  let showPickerModal = false;
  let pickerCell = null; // { stepIdx, posId, posName }
  let longPressTimer = null;
  let longPressTriggered = false;

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
      if (!game.gamePlanFormationId) game.gamePlanFormationId = '';
      const teamSnap = await getDoc(doc(db, 'teams', game.teamId));
      if (teamSnap.exists()) team = { id: teamSnap.id, ...teamSnap.data() };

      if (game.playersOnField == null && team?.defaultPlayersOnField != null) {
        game.playersOnField = team.defaultPlayersOnField;
        await updateDoc(doc(db, 'games', gameId), { playersOnField: game.playersOnField });
      }

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
      savedLineups = lineupsSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));

      // Migrate old gamePlan step format: { lineupId, durationMins } → { durationMins, players, formationId }
      function migrateSteps(steps) {
        return (steps || []).map(step => {
          if (step.lineupId !== undefined && !step.players) {
            const lu = savedLineups.find(l => l.id === step.lineupId);
            return { durationMins: step.durationMins, players: { ...(lu?.players ?? {}) }, formationId: step.formationId ?? game.gamePlanFormationId ?? null };
          }
          if (!step.players) step.players = {};
          if (step.formationId === undefined) step.formationId = game.gamePlanFormationId ?? null;
          return step;
        });
      }

      // Multi-plan migration: promote legacy single gamePlan into gamePlans array
      if (game.gamePlans?.length) {
        planMeta = game.gamePlans.map(({ id, name }) => ({ id, name }));
        allPlanSteps = Object.fromEntries(game.gamePlans.map(p => [p.id, migrateSteps(p.steps)]));
        activePlanId = game.activePlanId ?? planMeta[0]?.id ?? null;
      } else {
        const id = generateUUID();
        planMeta = [{ id, name: 'Plan A' }];
        allPlanSteps = { [id]: migrateSteps(game.gamePlan) };
        activePlanId = id;
      }
      selectedPlanId = activePlanId;
      game.gamePlan = JSON.parse(JSON.stringify(allPlanSteps[selectedPlanId] ?? []));

      // Pre-populate formation from team default if not already set on this game
      if (!game.formationId && team?.defaultFormationId) {
        game.formationId = team.defaultFormationId;
        await updateDoc(doc(db, 'games', gameId), { formationId: game.formationId });
      }

      // Snapshots for revert
      savedPlanMetaSnapshot = JSON.parse(JSON.stringify(planMeta));
      savedPlanStepsSnapshot = JSON.parse(JSON.stringify(allPlanSteps));
      savedActivePlanIdSnapshot = activePlanId;

    } catch (error) {
      console.error(error);
    } finally {
      loading = false;
    }
  }

  beforeNavigate(({ cancel }) => {
    if (gamePlanDirty && !confirm('You have unsaved changes to the Game Plan. Leave without saving?')) {
      cancel();
    }
  });

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
        playersOnField: game.playersOnField ?? null
      });
      saveStatus = 'Saved.';
      setTimeout(() => saveStatus = '', 2000);
    } catch (err) {
      saveStatus = 'Error saving.';
    }
  }

  // --- Game Plan (multi-plan) ---
  let gamePlanDirty = false;
  let planMeta = [];            // [{ id, name }] — ordered list of plans
  let allPlanSteps = {};        // { planId: steps[] } — in-memory steps for every plan
  let selectedPlanId = null;    // which plan tab is currently open
  let activePlanId = null;      // which plan feeds the live tracker
  let savedPlanMetaSnapshot = [];
  let savedPlanStepsSnapshot = {};
  let savedActivePlanIdSnapshot = null;

  function markGamePlanDirty() { gamePlanDirty = true; }

  async function saveGamePlan() {
    // Stash current view before saving
    allPlanSteps[selectedPlanId] = JSON.parse(JSON.stringify(game.gamePlan));
    const gamePlans = planMeta.map(m => ({ id: m.id, name: m.name, steps: allPlanSteps[m.id] ?? [] }));
    const activeSteps = allPlanSteps[activePlanId] ?? [];
    try {
      await updateDoc(doc(db, 'games', gameId), {
        gamePlans,
        activePlanId,
        gamePlan: activeSteps,          // kept in sync for the live tracker
        gamePlanFormationId: game.gamePlanFormationId || null
      });
      savedPlanMetaSnapshot = JSON.parse(JSON.stringify(planMeta));
      savedPlanStepsSnapshot = JSON.parse(JSON.stringify(allPlanSteps));
      savedActivePlanIdSnapshot = activePlanId;
      gamePlanDirty = false;
    } catch (err) {
      console.error('Error saving game plan:', err);
    }
  }

  function revertGamePlan() {
    planMeta = JSON.parse(JSON.stringify(savedPlanMetaSnapshot));
    allPlanSteps = JSON.parse(JSON.stringify(savedPlanStepsSnapshot));
    activePlanId = savedActivePlanIdSnapshot;
    // If the selected plan was added after last save, fall back to active
    if (!allPlanSteps[selectedPlanId]) selectedPlanId = activePlanId;
    game.gamePlan = JSON.parse(JSON.stringify(allPlanSteps[selectedPlanId] ?? []));
    gamePlanDirty = false;
  }

  function switchToPlan(planId) {
    if (planId === selectedPlanId) return;
    allPlanSteps[selectedPlanId] = JSON.parse(JSON.stringify(game.gamePlan));
    selectedPlanId = planId;
    game.gamePlan = JSON.parse(JSON.stringify(allPlanSteps[planId] ?? []));
  }

  let showAddPlanModal = false;

  function addGamePlan() {
    showAddPlanModal = true;
  }

  function confirmAddGamePlan(copyFromId = null) {
    showAddPlanModal = false;
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const name = `Plan ${letters[planMeta.length] ?? planMeta.length + 1}`;
    const id = generateUUID();
    // Stash current view so the copy source is up-to-date
    allPlanSteps[selectedPlanId] = JSON.parse(JSON.stringify(game.gamePlan));
    allPlanSteps[id] = copyFromId ? JSON.parse(JSON.stringify(allPlanSteps[copyFromId] ?? [])) : [];
    planMeta = [...planMeta, { id, name }];
    switchToPlan(id);
    markGamePlanDirty();
  }

  function deleteCurrentPlan() {
    if (planMeta.length <= 1) return;
    const deletingId = selectedPlanId;
    const newMeta = planMeta.filter(p => p.id !== deletingId);
    delete allPlanSteps[deletingId];
    planMeta = newMeta;
    if (activePlanId === deletingId) activePlanId = newMeta[0].id;
    selectedPlanId = activePlanId;
    game.gamePlan = JSON.parse(JSON.stringify(allPlanSteps[selectedPlanId] ?? []));
    markGamePlanDirty();
  }

  function setActivePlan(planId) {
    activePlanId = planId;
    markGamePlanDirty();
  }

  function renamePlan(planId, newName) {
    planMeta = planMeta.map(p => p.id === planId ? { ...p, name: newName } : p);
    markGamePlanDirty();
  }

  function remapStepPlayers(idx, newFormationId) {
    const step = game.gamePlan[idx];
    const oldFormation = formations.find(f => f.id === (step.formationId ?? null)) ?? null;
    const newFormation = formations.find(f => f.id === (newFormationId ?? null)) ?? null;

    const oldPosNameMap = {};
    (oldFormation?.positions || []).forEach(p => { oldPosNameMap[p.id] = p.name; });

    const playerOldPosName = {};
    for (const [posId, playerId] of Object.entries(step.players || {})) {
      if (playerId) playerOldPosName[playerId] = oldPosNameMap[posId];
    }

    const onFieldPlayers = Object.values(step.players || {}).filter(id => id);
    const newPositions = newFormation?.positions || [];
    const newPlayers = {};
    const usedPlayers = new Set();
    const filledPositions = new Set();

    for (const newPos of newPositions) {
      const match = onFieldPlayers.find(pid => !usedPlayers.has(pid) && playerOldPosName[pid] === newPos.name);
      if (match) {
        newPlayers[newPos.id] = match;
        usedPlayers.add(match);
        filledPositions.add(newPos.id);
      }
    }

    const unmatched = onFieldPlayers.filter(pid => !usedPlayers.has(pid));
    const emptySlots = newPositions.filter(p => !filledPositions.has(p.id));
    unmatched.forEach((pid, i) => { if (i < emptySlots.length) newPlayers[emptySlots[i].id] = pid; });

    game.gamePlan[idx].players = newPlayers;
  }

  function addPlanStep() {
    const lastStep = game.gamePlan[game.gamePlan.length - 1];
    const formationId = lastStep?.formationId ?? game.gamePlanFormationId ?? null;
    game.gamePlan = [...game.gamePlan, { durationMins: 20, players: {}, formationId }];
    markGamePlanDirty();
  }

  // --- Save step as lineup modal ---
  let showSaveLineupModal = false;
  let saveLineupStepIdx = null;
  let saveLineupName = '';
  let saveLineupConflict = null;

  function openSaveLineupModal(stepIdx) {
    saveLineupStepIdx = stepIdx;
    saveLineupName = game.gamePlan[stepIdx].name || '';
    saveLineupConflict = null;
    showSaveLineupModal = true;
  }

  async function confirmSaveLineup(overwrite = false) {
    const name = saveLineupName.trim();
    if (!name) return;
    const existing = savedLineups.find(l => l.name === name);
    if (existing && !overwrite) { saveLineupConflict = existing; return; }
    const step = game.gamePlan[saveLineupStepIdx];
    const players = { ...(step.players ?? {}) };
    try {
      if (existing && overwrite) {
        await updateDoc(doc(db, 'lineups', existing.id), { name, players });
        savedLineups = savedLineups.map(l => l.id === existing.id ? { ...l, name, players } : l);
      } else {
        const nextSortOrder = savedLineups.reduce((max, l) => Math.max(max, l.sortOrder ?? 0), -1) + 1;
        const ref = await addDoc(collection(db, 'lineups'), {
          name, teamId: game.teamId,
          formationId: game.gamePlanFormationId,
          formationName: planFormation?.name ?? '',
          players, ownerId: $authStore.user.uid,
          sortOrder: nextSortOrder
        });
        savedLineups = [...savedLineups, { id: ref.id, name, teamId: game.teamId, formationId: game.gamePlanFormationId, players, sortOrder: nextSortOrder }];
      }
      showSaveLineupModal = false;
      saveLineupConflict = null;
    } catch (err) {
      console.error('Error saving lineup:', err);
    }
  }

  function importLineupToStep(stepIdx, lineupId) {
    if (!lineupId) return;
    const lu = savedLineups.find(l => l.id === lineupId);
    if (!lu) return;
    game.gamePlan[stepIdx].players = { ...lu.players };
    game.gamePlan = [...game.gamePlan];
    markGamePlanDirty();
  }

  // --- Cell nav + edit modes ---
  let navCell = null;    // { stepIdx, posId } — keyboard-navigable highlight
  let activeCell = null; // { stepIdx, posId } — edit mode (input + dropdown)
  let cellInputVal = '';
  let cellHighlightIdx = 0;
  let dropdownPos = { top: 0, left: 0, width: 0 };

  $: cellFilteredPlayers = (() => {
    if (!activeCell) return [];
    const { stepIdx, posId } = activeCell;
    const step = game.gamePlan[stepIdx];
    const stepFormation = formations.find(f => f.id === (step?.formationId ?? null)) ?? null;
    const posNameMap = {};
    (stepFormation?.positions || []).forEach(p => { posNameMap[p.id] = p.name; });
    // Map playerId → position name for players already assigned elsewhere in this step
    const playerCurrentPos = {};
    Object.entries(step?.players ?? {}).forEach(([pid, playerId]) => {
      if (pid !== posId && playerId) playerCurrentPos[playerId] = posNameMap[pid] ?? null;
    });
    const q = cellInputVal.trim().toLowerCase();
    return availableRoster
      .filter(p => !q || p.name.toLowerCase().includes(q))
      .map(p => ({ ...p, currentPosName: playerCurrentPos[p.id] ?? null }));
  })();

  $: pickerPlayers = (() => {
    if (!pickerCell) return [];
    const { stepIdx, posId } = pickerCell;
    const step = game?.gamePlan?.[stepIdx];
    const stepFormation = formations.find(f => f.id === (step?.formationId ?? null)) ?? null;
    const posNameMap = {};
    const posGroupMap = {};
    (stepFormation?.positions || []).forEach(p => { posNameMap[p.id] = p.name; posGroupMap[p.id] = p.group ?? null; });
    const playerCurrentPos = {};
    const playerCurrentGroup = {};
    Object.entries(step?.players ?? {}).forEach(([pid, playerId]) => {
      if (pid !== posId && playerId) {
        playerCurrentPos[playerId] = posNameMap[pid] ?? null;
        playerCurrentGroup[playerId] = posGroupMap[pid] ?? null;
      }
    });
    return availableRoster.map(p => ({ ...p, currentPosName: playerCurrentPos[p.id] ?? null, currentPosGroup: playerCurrentGroup[p.id] ?? null }));
  })();

  function openPickerModal(stepIdx, posId, posName) {
    if (game.status === 'completed') return;
    pickerCell = { stepIdx, posId, posName };
    showPickerModal = true;
  }

  function closePickerModal() {
    showPickerModal = false;
    pickerCell = null;
  }

  function pickerSelectPlayer(playerId) {
    if (!pickerCell) return;
    const { stepIdx, posId } = pickerCell;
    activeCell = { stepIdx, posId };
    selectCellPlayer(playerId);
    closePickerModal();
  }

  function onCellTouchStart(stepIdx, posId, posName) {
    longPressTriggered = false;
    longPressTimer = setTimeout(() => {
      longPressTriggered = true;
      openPickerModal(stepIdx, posId, posName);
    }, 500);
  }

  function onCellTouchEnd() {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }

  function autoFocus(node) {
    setTimeout(() => {
      node.focus();
      if (!cellInputVal) {
        node.select();
      } else {
        const len = node.value.length;
        node.setSelectionRange(len, len);
      }
    }, 0);
    return {};
  }

  // Click a cell: first click → nav mode; click already-nav cell → edit mode
  function clickCell(stepIdx, posId, e) {
    if (longPressTriggered) { longPressTriggered = false; return; }
    if (game.status === 'completed') return;
    if (navCell?.stepIdx === stepIdx && navCell?.posId === posId && !activeCell) {
      openEditCell(stepIdx, posId, e.currentTarget, true);
    } else {
      navCell = { stepIdx, posId };
      closeEditMode();
    }
  }

  function openEditCell(stepIdx, posId, element, clearInput = false) {
    const rect = element.getBoundingClientRect();
    dropdownPos = { top: rect.bottom, left: rect.left, width: Math.max(rect.width, 140) };
    const currentPlayerId = game.gamePlan[stepIdx]?.players?.[posId];
    activeCell = { stepIdx, posId };
    cellInputVal = clearInput ? '' : (currentPlayerId ? getPlayerName(currentPlayerId) : '');
    cellHighlightIdx = 0;
  }

  function closeEditMode() {
    activeCell = null;
    cellInputVal = '';
    cellHighlightIdx = 0;
  }

  function closeAllModes() {
    navCell = null;
    activeCell = null;
    cellInputVal = '';
    cellHighlightIdx = 0;
  }

  function selectCellPlayer(playerId) {
    if (!activeCell) return;
    const { stepIdx, posId } = activeCell;
    const step = game.gamePlan[stepIdx];
    if (!step.players) step.players = {};
    if (playerId) {
      // Remove the player from any other position they currently occupy in this step
      for (const [pid, pid2] of Object.entries(step.players)) {
        if (pid !== posId && pid2 === playerId) delete step.players[pid];
      }
      step.players[posId] = playerId;
    } else {
      delete step.players[posId];
    }
    game.gamePlan = [...game.gamePlan];
    markGamePlanDirty();
    // Return to nav mode on the same cell after selecting
    navCell = { stepIdx, posId };
    closeEditMode();
  }

  function scrollDropdownToHighlight() {
    setTimeout(() => {
      const dropdown = document.querySelector('.plan-dropdown');
      if (!dropdown) return;
      const item = dropdown.querySelector('.plan-drop-hi');
      if (!item) return;
      const itemTop = item.offsetTop;
      const itemBottom = itemTop + item.offsetHeight;
      if (itemBottom > dropdown.scrollTop + dropdown.clientHeight) {
        dropdown.scrollTop = itemBottom - dropdown.clientHeight;
      } else if (itemTop < dropdown.scrollTop) {
        dropdown.scrollTop = itemTop;
      }
    }, 0);
  }

  $: showClearOption = !!(activeCell && !cellInputVal.trim() && game.gamePlan[activeCell.stepIdx]?.players?.[activeCell.posId]);

  function onCellKeydown(e) {
    const len = cellFilteredPlayers.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (cellHighlightIdx === -1) cellHighlightIdx = 0;
      else cellHighlightIdx = Math.min(cellHighlightIdx + 1, len - 1);
      scrollDropdownToHighlight();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (cellHighlightIdx > 0) cellHighlightIdx--;
      else if (cellHighlightIdx === 0 && showClearOption) cellHighlightIdx = -1;
      scrollDropdownToHighlight();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (cellHighlightIdx === -1) selectCellPlayer(null);
      else if (len > 0) selectCellPlayer(cellFilteredPlayers[cellHighlightIdx]?.id ?? cellFilteredPlayers[0].id);
      else if (!cellInputVal.trim()) selectCellPlayer(null);
      else closeEditMode();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // Return to nav mode on the same cell rather than closing everything
      navCell = { stepIdx: activeCell.stepIdx, posId: activeCell.posId };
      closeEditMode();
    } else if (e.key === 'Tab') {
      closeAllModes();
    }
  }

  function onCellBlur() {
    // Only close edit mode on blur; keep nav mode so arrow keys still work
    setTimeout(closeEditMode, 120);
  }

  // --- Nav-mode keyboard handler (window-level) ---
  function onWindowKeydown(e) {
    if (!navCell) return;
    // Don't intercept keys when the user is typing in any input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

    const { stepIdx, posId } = navCell;

    if (e.key === 'Escape') {
      e.preventDefault();
      navCell = null;
      return;
    }

    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      navigateNav(e.key);
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      const el = document.querySelector(`[data-navcell="${stepIdx}-${posId}"]`);
      if (el) openEditCell(stepIdx, posId, el, true);
      return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      const step = game.gamePlan[stepIdx];
      if (step?.players) {
        delete step.players[posId];
        game.gamePlan = [...game.gamePlan];
        markGamePlanDirty();
      }
      return;
    }

    // Any printable character → enter edit mode pre-filled with that char
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const el = document.querySelector(`[data-navcell="${stepIdx}-${posId}"]`);
      if (el) {
        const rect = el.getBoundingClientRect();
        dropdownPos = { top: rect.bottom, left: rect.left, width: Math.max(rect.width, 140) };
        cellInputVal = e.key;
        cellHighlightIdx = 0;
        activeCell = { stepIdx, posId };
      }
    }
  }

  function onWindowClick(e) {
    if (!navCell) return;
    const planGrid = document.querySelector('.plan-grid-wrap');
    if (planGrid && planGrid.contains(e.target)) return;
    navCell = null;
  }

  function navigateNav(key) {
    if (!navCell) return;
    const { stepIdx, posId } = navCell;
    const stepColsArr = planColumns.filter(c => c.type === 'step');
    const currentStepColIdx = stepColsArr.findIndex(c => c.idx === stepIdx);
    const currentStepCol = stepColsArr[currentStepColIdx];
    const positions = currentStepCol?.posCol?.formation?.positions ?? [];
    const rowIdx = positions.findIndex(p => p.id === posId);

    if (key === 'ArrowUp') {
      if (rowIdx > 0) navCell = { stepIdx, posId: positions[rowIdx - 1].id };
    } else if (key === 'ArrowDown') {
      if (rowIdx < positions.length - 1) navCell = { stepIdx, posId: positions[rowIdx + 1].id };
    } else if (key === 'ArrowLeft') {
      const newIdx = currentStepColIdx - 1;
      if (newIdx >= 0) {
        const newPositions = stepColsArr[newIdx]?.posCol?.formation?.positions ?? [];
        const target = Math.min(rowIdx, newPositions.length - 1);
        if (target >= 0) navCell = { stepIdx: stepColsArr[newIdx].idx, posId: newPositions[target].id };
      }
    } else if (key === 'ArrowRight') {
      const newIdx = currentStepColIdx + 1;
      if (newIdx < stepColsArr.length) {
        const newPositions = stepColsArr[newIdx]?.posCol?.formation?.positions ?? [];
        const target = Math.min(rowIdx, newPositions.length - 1);
        if (target >= 0) navCell = { stepIdx: stepColsArr[newIdx].idx, posId: newPositions[target].id };
      }
    }

    // Scroll the newly-focused cell into view
    setTimeout(() => {
      const el = document.querySelector(`[data-navcell="${navCell?.stepIdx}-${navCell?.posId}"]`);
      el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, 0);
  }

  function removePlanStep(i) {
    game.gamePlan = game.gamePlan.filter((_, idx) => idx !== i);
    markGamePlanDirty();
  }

  function movePlanStep(i, dir) {
    const arr = [...game.gamePlan];
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    game.gamePlan = arr;
    markGamePlanDirty();
  }

  function copyPlanStep(i) {
    const src = game.gamePlan[i];
    const copy = { ...src, players: { ...(src.players ?? {}) }, name: src.name ? src.name + ' (copy)' : '' };
    const arr = [...game.gamePlan];
    arr.splice(i + 1, 0, copy);
    game.gamePlan = arr;
    markGamePlanDirty();
  }

  $: totalPlanMins = (game?.gamePlan || []).reduce((sum, s) => s.included !== false ? sum + (Number(s.durationMins) || 0) : sum, 0);
  $: isPreGame = game?.status !== 'live' && game?.status !== 'completed';

  // Planned per-player stats derived from game plan steps
  $: playerPlan = (() => {
    if (!availableRoster.length) return [];
    const stats = {};
    availableRoster.forEach(p => { stats[p.id] = { activeMs: 0, benchMs: 0, positionMs: {}, groupMs: {} }; });
    for (const step of (game?.gamePlan || [])) {
      if (step.included === false) continue;
      const ms = (Number(step.durationMins) || 0) * 60 * 1000;
      if (ms <= 0) continue;
      const stepFormation = formations.find(f => f.id === (step.formationId ?? null)) ?? null;
      const posMap = {};
      (stepFormation?.positions || []).forEach(p => { posMap[p.id] = p; });
      const players = step.players || {};
      availableRoster.forEach(player => {
        const s = stats[player.id];
        const posId = Object.keys(players).find(k => players[k] === player.id);
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
    const timelines = {};
    availableRoster.forEach(p => { timelines[p.id] = []; });
    let curMs = 0;
    for (const step of (game?.gamePlan || [])) {
      if (step.included === false) continue;
      const ms = (Number(step.durationMins) || 0) * 60 * 1000;
      if (ms <= 0) continue;
      const stepFormation = formations.find(f => f.id === (step.formationId ?? null)) ?? null;
      const posMap = {};
      (stepFormation?.positions || []).forEach(p => { posMap[p.id] = p; });
      const players = step.players || {};
      const segEnd = curMs + ms;
      availableRoster.forEach(player => {
        const posId = Object.keys(players).find(k => players[k] === player.id);
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

  // Build a flat column sequence: insert a 'pos' column before step 0 and before any step
  // whose formation differs from the previous step's formation.
  // Each step col carries a reference to its owning posCol for efficient block lookup.
  $: planColumns = (() => {
    const cols = [];
    let lastFormId = '__none__';
    let currentPosCol = null;
    for (let i = 0; i < (game?.gamePlan?.length ?? 0); i++) {
      const step = game.gamePlan[i];
      const fid = step.formationId ?? null;
      if (fid !== lastFormId) {
        currentPosCol = { type: 'pos', formation: formations.find(f => f.id === fid) ?? null };
        cols.push(currentPosCol);
        lastFormId = fid;
      }
      cols.push({ type: 'step', step, idx: i, posCol: currentPosCol });
    }
    return cols;
  })();

  // For the player plan stats modal: use the formation of the first step
  $: planFormation = formations.find(f => f.id === (game?.gamePlan?.[0]?.formationId ?? null)) ?? null;
  $: maxPlanRows = planColumns.filter(c => c.type === 'pos').reduce((max, c) => Math.max(max, c.formation?.positions?.length ?? 0), 0);
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

<svelte:window on:keydown={onWindowKeydown} on:click={onWindowClick} />

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
        <div class="form-group form-group-inline">
          <label>Players on Field</label>
          <input type="number" min="1" max="20" placeholder="e.g. 11"
            value={game.playersOnField ?? ''}
            on:change={(e) => { game.playersOnField = e.target.value ? Number(e.target.value) : null; saveGameNotes(); }} />
        </div>
        <div class="form-group">
          <label>Pre-Game Notes</label>
          <textarea bind:value={game.preNotes} on:blur={saveGameNotes} rows="6"></textarea>
        </div>
        <span class="save-status">{saveStatus}</span>
      </div>

      <!-- Top Right: Post-Game Notes -->
      {#if game.status === 'completed'}
        <div class="panel">
          <h2>Post-Game Review</h2>
          <div class="form-group">
            <label>Post-Game Notes</label>
            <textarea bind:value={game.postNotes} on:blur={saveGameNotes} rows="6" placeholder="What went well? What needs work?"></textarea>
          </div>
        </div>
      {/if}
    </div>

    <!-- Game Plan -->
    <div class="panel game-plan-panel">
      <div class="panel-title-row">
        <h2>Game Plan</h2>
        <div class="plan-header-controls">
          {#if game.status !== 'completed'}
            <button class="btn-toggle" on:click={addPlanStep}>+ Add Step</button>
            <button class="btn-toggle" on:click={addGamePlan}>+ Alt Plan</button>
          {/if}
          {#if gamePlanDirty}
            <div class="plan-dirty-actions">
              <button class="btn-toggle" on:click={revertGamePlan}>Revert</button>
              <button class="btn-primary plan-save-action" on:click={saveGamePlan}>Save</button>
            </div>
          {/if}
        </div>
      </div>

      <!-- Plan tabs (only shown when there are multiple plans or always for context) -->
      {#if planMeta.length > 1 || game.status !== 'completed'}
        <div class="plan-tabs-row">
          <div class="plan-tabs">
            {#each planMeta as plan}
              <button class="plan-tab"
                class:plan-tab-sel={plan.id === selectedPlanId}
                class:plan-tab-live={plan.id === activePlanId}
                on:click={() => switchToPlan(plan.id)}>
                {plan.name}{#if plan.id === activePlanId}&nbsp;●{/if}
              </button>
            {/each}
          </div>
          {#if game.status !== 'completed'}
            <div class="plan-cur-controls">
              <input class="plan-name-edit" type="text"
                value={planMeta.find(p => p.id === selectedPlanId)?.name ?? ''}
                on:input={(e) => renamePlan(selectedPlanId, e.target.value)}
                placeholder="Plan name" />
              {#if selectedPlanId !== activePlanId}
                <button class="btn-toggle plan-set-active-btn" title="Use this plan in the live tracker" on:click={() => setActivePlan(selectedPlanId)}>Set Active</button>
              {:else}
                <span class="plan-active-badge">✓ Active</span>
              {/if}
              {#if planMeta.length > 1}
                <button class="plan-delete-btn" on:click={deleteCurrentPlan}>Delete</button>
              {/if}
            </div>
          {/if}
        </div>
      {/if}

      {#if !game.gamePlan?.length}
        <p class="text-muted small">No steps yet. Add a step to start planning your rotations.</p>
      {:else}
        {@const stepCols = planColumns.filter(c => c.type === 'step')}
        <div class="plan-grid-wrap">
          <table class="plan-grid">
            <!-- HEADER ROW -->
            <thead>
              <tr>
                {#each planColumns as col, i}
                  {#if col.type === 'pos'}
                    <th class="plan-pos-th" class:plan-pos-th-sep={i === 0}>
                      <span class="plan-seg-form-ro">{col.formation?.name ?? '?'}</span>
                    </th>
                  {:else}
                    {@const { step, idx } = col}
                    <th class="plan-step-th">
                      <div class="plan-step-hdr">
                        {#if game.status !== 'completed'}
                          <input class="plan-step-name-input" type="text" value={step.name ?? ''}
                            on:input={(e) => { game.gamePlan[idx].name = e.target.value; markGamePlanDirty(); }}
                            placeholder="Lineup {idx + 1}" />
                          <div class="plan-dur-row">
                            <input style="width: 4rem" class="plan-dur-input" type="number" min="1" max="120"
                              value={step.durationMins}
                              on:input={(e) => { game.gamePlan[idx].durationMins = Number(e.target.value); markGamePlanDirty(); }} />
                            <span class="plan-dur-label">min</span>
                          </div>
                          <!-- svelte-ignore a11y-no-onchange -->
                          <select class="load-lineup-sel"
                            value={step.formationId ?? ''}
                            on:change={(e) => {
                              const newFormationId = e.target.value || null;
                              remapStepPlayers(idx, newFormationId);
                              game.gamePlan[idx].formationId = newFormationId;
                              game.gamePlan = [...game.gamePlan];
                              markGamePlanDirty();
                            }}>
                            <option value="">-- Formation --</option>
                            {#each formations.filter(f => game.playersOnField == null || (f.positions?.length ?? 0) === game.playersOnField) as f}
                              <option value={f.id}>{f.name}</option>
                            {/each}
                          </select>
                          <!-- svelte-ignore a11y-no-onchange -->
                          <select class="load-lineup-sel"
                            on:mousedown={(e) => { if (!step.formationId) { e.preventDefault(); alert('Select a formation first.'); } }}
                            on:change={(e) => {
                              const val = e.target.value;
                              if (!val) return;
                              if (val.startsWith('step:')) {
                                const srcIdx = Number(val.slice(5));
                                const src = game.gamePlan[srcIdx];
                                if (src) { game.gamePlan[idx].players = { ...(src.players ?? {}) }; game.gamePlan = [...game.gamePlan]; markGamePlanDirty(); }
                              } else {
                                importLineupToStep(idx, val);
                              }
                              e.target.value = '';
                            }}>
                            <option value="">Load lineup...</option>
                            {#if game.gamePlan.some((s, i) => i !== idx && s.formationId === step.formationId)}
                              <optgroup label="Plan steps">
                                {#each game.gamePlan as s, i}
                                  {#if i !== idx && s.formationId === step.formationId}
                                    <option value="step:{i}">{s.name || `Lineup ${i + 1}`}</option>
                                  {/if}
                                {/each}
                              </optgroup>
                            {/if}
                            {#if savedLineups.some(l => !step.formationId || l.formationId === step.formationId)}
                              <optgroup label="Saved lineups">
                                {#each savedLineups.filter(l => !step.formationId || l.formationId === step.formationId) as l}
                                  <option value={l.id}>{l.name}</option>
                                {/each}
                              </optgroup>
                            {/if}
                          </select>
                          <div class="plan-step-actions">
                            <button class="plan-mv-btn" on:click={() => movePlanStep(idx, -1)} disabled={idx === 0}>←</button>
                            <button class="plan-mv-btn" on:click={() => movePlanStep(idx, 1)} disabled={idx === game.gamePlan.length - 1}>→</button>
                            <button class="plan-mv-btn" title="Copy step" on:click={() => copyPlanStep(idx)}>⧉</button>
                            <button class="plan-mv-btn" title="Save as lineup" on:click={() => openSaveLineupModal(idx)}>
                              <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M2 1a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V4.414L11.586 1H2zm9 1.5V5H5V2.5h6zM5 9h6v4H5V9zm1 1v2h1v-2H6zm3 0v2h1v-2H9z"/></svg>
                            </button>
                            <button class="plan-remove" on:click={() => removePlanStep(idx)}>×</button>
                          </div>
                        {:else}
                          <span class="plan-step-name-ro">{step.name || `Lineup ${idx + 1}`}</span>
                          <span class="plan-dur-ro">{step.durationMins} min</span>
                        {/if}
                      </div>
                    </th>
                  {/if}
                {/each}
              </tr>
            </thead>

            <!-- BODY: single tbody, one row per position slot index across all formations -->
            <tbody>
              {#each {length: maxPlanRows} as _, rowIdx}
                <tr>
                  {#each planColumns as col}
                    {#if col.type === 'pos'}
                      {@const pos = col.formation?.positions?.[rowIdx]}
                      {#if pos}
                        {@const posColor = getGroupColor(pos.group)}
                        <td class="plan-pos-td" style="box-shadow: inset 3px 0 0 {posColor.bg};">{pos.name}</td>
                      {:else}
                        <td class="plan-pos-td plan-pos-empty-cell"></td>
                      {/if}
                    {:else}
                      {@const { step, idx } = col}
                      {@const pos = col.posCol?.formation?.positions?.[rowIdx]}
                      {#if pos}
                        {@const thisPlayer = step.players?.[pos.id] ?? ''}
                        {@const prevStepPlayers = idx > 0 ? (game.gamePlan[idx - 1].players ?? {}) : null}
                        {@const prevPlayer = prevStepPlayers ? (prevStepPlayers[pos.id] ?? '') : null}
                        {@const playerChanged = prevStepPlayers !== null && thisPlayer !== prevPlayer}
                        {@const playerSubOn = playerChanged && !!thisPlayer && !Object.values(prevStepPlayers).includes(thisPlayer)}
                        {@const playerSwitched = playerChanged && !!thisPlayer && Object.values(prevStepPlayers).includes(thisPlayer)}
                        <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
                        <td class="plan-cell"
                          class:plan-cell-subon={playerSubOn}
                          class:plan-cell-switched={playerSwitched}
                          class:plan-cell-nav={navCell?.stepIdx === idx && navCell?.posId === pos.id && !activeCell}
                          data-navcell="{idx}-{pos.id}"
                          on:click={(e) => clickCell(idx, pos.id, e)}
                          on:contextmenu|preventDefault={() => openPickerModal(idx, pos.id, pos.name)}
                          on:touchstart|passive={() => onCellTouchStart(idx, pos.id, pos.name)}
                          on:touchend={onCellTouchEnd}
                          on:touchcancel={onCellTouchEnd}
                          on:touchmove={onCellTouchEnd}>
                          {#if activeCell?.stepIdx === idx && activeCell?.posId === pos.id}
                            <input class="plan-cell-input" use:autoFocus
                              bind:value={cellInputVal}
                              on:input={() => cellHighlightIdx = 0}
                              on:keydown={onCellKeydown}
                              on:blur={onCellBlur} />
                          {:else if game.status !== 'completed'}
                            <span class="plan-cell-val" class:plan-player-subon={playerSubOn} class:plan-player-switched={playerSwitched}>
                              {thisPlayer ? getPlayerName(thisPlayer) : ''}
                            </span>
                          {:else}
                            <span class="plan-player-ro" class:plan-player-subon={playerSubOn} class:plan-player-switched={playerSwitched}>
                              {thisPlayer ? getPlayerName(thisPlayer) : '--'}
                            </span>
                          {/if}
                        </td>
                      {:else}
                        <td class="plan-cell plan-cell-oos"></td>
                      {/if}
                    {/if}
                  {/each}
                </tr>
              {/each}
            </tbody>

            <!-- FOOTER: include toggles -->
            <tfoot>
              <tr>
                {#each planColumns as col}
                  {#if col.type === 'pos'}
                    <td class="plan-pos-td"></td>
                  {:else}
                    {@const { step, idx } = col}
                    <td class="plan-cell">
                      <button
                        class="plan-include-btn"
                        class:plan-include-off={step.included === false}
                        title={step.included === false ? 'Excluded from time calculations' : 'Included in time calculations'}
                        on:click={() => {
                          game.gamePlan[idx].included = game.gamePlan[idx].included === false ? true : false;
                          game.gamePlan = [...game.gamePlan];
                          markGamePlanDirty();
                        }}>
                        {step.included === false ? 'excluded' : 'included'}
                      </button>
                    </td>
                  {/if}
                {/each}
              </tr>
            </tfoot>
          </table>
        </div>
        <div class="plan-grand-total">Grand total: <strong>{totalPlanMins} min</strong></div>
      {/if}

      {#if isPreGame}
        <!-- Player Plan (folded into Game Plan panel) -->
        <div class="player-plan-section">
          <div class="plan-controls" style="margin-top: 1.25rem;">
            <div class="bar-mode-toggle">
              <button class:active={planSort === 'name'} on:click={() => planSort = 'name'}>A–Z</button>
              <button class:active={planSort === 'time'} on:click={() => planSort = 'time'}>Time</button>
            </div>
            <div class="bar-mode-toggle">
              <button class:active={planBarMode === 'timeline'} on:click={() => planBarMode = 'timeline'}>Timeline</button>
              <button class:active={planBarMode === 'grouped'} on:click={() => planBarMode = 'grouped'}>Grouped</button>
            </div>
            <div style="margin-left: auto;">
              <button class="btn-toggle" on:click={() => editingAvailability = !editingAvailability}>
                {editingAvailability ? 'Done' : 'Edit Availability'}
              </button>
            </div>
          </div>

          {#if editingAvailability}
            <p class="small text-muted" style="margin: 0 0 0.75rem 0;">Check players available for this game.</p>
            <div class="roster-checklist">
              {#each (team?.roster || []).sort((a, b) => a.name.localeCompare(b.name)) as player}
                {@const played = game.status === 'completed' && (game.playerStats?.[player.id]?.activeMs ?? 0) > 0}
                <label class="check-item" class:check-item-locked={played}>
                  <input
                    type="checkbox"
                    checked={game.availablePlayers?.includes(player.id)}
                    on:change={() => togglePlayerAvailability(player.id)}
                    disabled={played}
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
            <div class="table-container">
              <table class="stats-table">
                <thead>
                  <tr>
                    <th>Player</th>
                    <th class="text-right">Planned Time</th>
                  </tr>
                </thead>
                <tbody>
                  {#each [...playerPlan].sort((a, b) => planSort === 'time' ? (b.activeMs - a.activeMs) || a.name.localeCompare(b.name) : a.name.localeCompare(b.name)) as p}
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
                              {#each planSegs as seg, i}
                                {@const color = getGroupColor(seg.group)}
                                <div class="bar-seg" style="width:{((seg.endMs - seg.startMs) / totalPlanMs * 100).toFixed(2)}%;background:{color.bg};" title="{seg.group ?? 'Bench'}: {formatDuration(seg.endMs - seg.startMs)}"></div>
                                {#if i < planSegs.length - 1}
                                  <div class="bar-lineup-change"></div>
                                {/if}
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
        </div>
      {/if}
    </div>

    <!-- Bottom Section: Stats & Timeline (live/completed only) -->
    {#if !isPreGame}
    <div class="stats-grid">
      <div class="panel">
          <!-- Player Stats (live / completed) -->
          <div class="panel-title-row">
            <h2>Player Stats</h2>
            <div class="panel-title-right">
              <div class="bar-mode-toggle">
                <button class:active={statsBarMode === 'timeline'} on:click={() => statsBarMode = 'timeline'}>Timeline</button>
                <button class:active={statsBarMode === 'grouped'} on:click={() => statsBarMode = 'grouped'}>Grouped</button>
              </div>
              <button class="btn-toggle" on:click={() => editingAvailability = !editingAvailability}>
                {editingAvailability ? 'Done' : 'Edit Availability'}
              </button>
            </div>
          </div>

          {#if editingAvailability}
            <p class="small text-muted" style="margin: 0 0 0.75rem 0;">Check players available for this game.</p>
            <div class="roster-checklist">
              {#each (team?.roster || []).sort((a, b) => a.name.localeCompare(b.name)) as player}
                {@const played = game.status === 'completed' && (game.playerStats?.[player.id]?.activeMs ?? 0) > 0}
                <label class="check-item" class:check-item-locked={played}>
                  <input
                    type="checkbox"
                    checked={game.availablePlayers?.includes(player.id)}
                    on:change={() => togglePlayerAvailability(player.id)}
                    disabled={played}
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
      </div>

      <!-- Match Timeline -->
      <div class="panel">
        <div class="panel-title-row">
          <h2>Match Timeline</h2>
          <button class="btn-toggle" on:click={() => showAddEventModal = true}>+ Add Event</button>
        </div>
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

    </div>
    {/if}
  </div>
{/if}

<!-- CELL AUTOCOMPLETE DROPDOWN -->
{#if activeCell}
  <div class="plan-dropdown" style="top:{dropdownPos.top}px;left:{dropdownPos.left}px;width:{dropdownPos.width}px;">
    {#if !cellInputVal.trim() && game.gamePlan[activeCell.stepIdx]?.players?.[activeCell.posId]}
      <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
      <div class="plan-drop-item plan-drop-clear" class:plan-drop-hi={cellHighlightIdx === -1} on:mousedown|preventDefault={() => selectCellPlayer(null)}>— clear —</div>
    {/if}
    {#each cellFilteredPlayers as player, j}
      <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
      <div class="plan-drop-item" class:plan-drop-hi={j === cellHighlightIdx}
        on:mousedown|preventDefault={() => selectCellPlayer(player.id)}>
        {player.name}{#if player.currentPosName}<span class="plan-drop-pos">{player.currentPosName}</span>{/if}
      </div>
    {/each}
    {#if cellFilteredPlayers.length === 0 && cellInputVal.trim()}
      <div class="plan-drop-empty">No match</div>
    {/if}
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
    formation={planFormation}
    on:close={() => showPlanStatsModal = false}
  />
{/if}

<!-- ADD PLAN MODAL -->
{#if showAddPlanModal}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="modal-backdrop" on:click={() => showAddPlanModal = false}>
    <div class="modal-panel" on:click|stopPropagation>
      <h2>Add Alternate Plan</h2>
      <div class="add-plan-options">
        <button class="add-plan-option" on:click={() => confirmAddGamePlan(null)}>
          <span class="add-plan-option-title">Start empty</span>
          <span class="add-plan-option-sub">Blank plan with no steps</span>
        </button>
        {#each planMeta as plan}
          <button class="add-plan-option" on:click={() => confirmAddGamePlan(plan.id)}>
            <span class="add-plan-option-title">Copy from "{plan.name}"</span>
            <span class="add-plan-option-sub">{allPlanSteps[plan.id]?.length ?? 0} step{(allPlanSteps[plan.id]?.length ?? 0) === 1 ? '' : 's'}</span>
          </button>
        {/each}
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" on:click={() => showAddPlanModal = false}>Cancel</button>
      </div>
    </div>
  </div>
{/if}

<!-- SAVE LINEUP MODAL -->
{#if showSaveLineupModal}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="modal-backdrop" on:click={() => { showSaveLineupModal = false; saveLineupConflict = null; }}>
    <div class="modal-panel" on:click|stopPropagation>
      <h2>Save as Lineup</h2>
      {#if saveLineupConflict}
        <p class="text-muted small" style="margin-bottom:1rem;">
          A lineup named <strong style="color:#f8fafc;">"{saveLineupConflict.name}"</strong> already exists.
          Overwrite it, or go back and choose a different name.
        </p>
        <div class="modal-actions">
          <button class="btn-secondary" on:click={() => saveLineupConflict = null}>Choose Different Name</button>
          <button class="btn-primary" on:click={() => confirmSaveLineup(true)}>Overwrite</button>
        </div>
      {:else}
        <div class="form-group">
          <label for="save-lineup-name">Lineup Name</label>
          <input id="save-lineup-name" type="text" bind:value={saveLineupName} placeholder="e.g. First Half" />
        </div>
        <div class="modal-actions">
          <button class="btn-secondary" on:click={() => showSaveLineupModal = false}>Cancel</button>
          <button class="btn-primary" disabled={!saveLineupName.trim()} on:click={() => confirmSaveLineup(false)}>Save</button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<!-- PLAYER PICKER MODAL (mobile long-press / desktop right-click) -->
{#if showPickerModal && pickerCell}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="modal-backdrop" on:click={closePickerModal}>
    <div class="modal-panel picker-modal" on:click|stopPropagation>
      <div class="picker-header">
        <span class="picker-pos-label">{pickerCell.posName}</span>
        <span class="picker-step-label">Lineup {pickerCell.stepIdx + 1}{game.gamePlan[pickerCell.stepIdx]?.name ? ': ' + game.gamePlan[pickerCell.stepIdx].name : ''}</span>
      </div>
      <div class="picker-list">
        {#if game.gamePlan[pickerCell.stepIdx]?.players?.[pickerCell.posId]}
          <button class="picker-item picker-item-clear" on:click={() => pickerSelectPlayer(null)}>— clear —</button>
        {/if}
        {#each pickerPlayers as player}
          {@const isCurrent = game.gamePlan[pickerCell.stepIdx]?.players?.[pickerCell.posId] === player.id}
          {@const planEntry = playerPlan.find(p => p.id === player.id)}
          <button class="picker-item" class:picker-item-active={isCurrent} on:click={() => pickerSelectPlayer(player.id)}>
            <span class="picker-num">#{player.number}</span>
            <span class="picker-name">{player.name}</span>
            {#if player.currentPosName}
              {@const gc = getGroupColor(player.currentPosGroup)}
              <span class="picker-cur-pos" style="background:{gc.bg};color:{gc.text};">{player.currentPosName}</span>
            {/if}
            {#if isCurrent}<span class="picker-check">✓</span>{/if}
            <span class="picker-time" class:picker-time-zero={!planEntry?.activeMs}>{formatDuration(planEntry?.activeMs ?? 0)}</span>
          </button>
        {/each}
        {#if pickerPlayers.length === 0}
          <p class="picker-empty">No available players.</p>
        {/if}
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" on:click={closePickerModal}>Cancel</button>
      </div>
    </div>
  </div>
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

<!-- ADD EVENT MODAL -->
{#if showAddEventModal}
  <AddEventModal
    roster={availableRoster}
    history={game.history}
    {gameId}
    score={game.score}
    totalGameMs={game?.gameTimeStats?.totalMs ?? 0}
    formation={gameFormation}
    on:close={() => showAddEventModal = false}
    on:saved={(e) => { game.history = e.detail.history; game.score = e.detail.score; showAddEventModal = false; }}
  />
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

  @media (max-width: 799px) {
    .stats-panel-scroll { max-height: 340px; overflow-y: auto; }
  }

  .player-plan-section { border-top: 1px solid #1e293b; padding-top: 0.25rem; }

  .panel { background: #111827; border: 1px solid #334155; border-radius: 1rem; padding: 1.5rem; }
  h2 { margin-top: 0; color: #e2e8f0; border-bottom: 1px solid #1e293b; padding-bottom: 0.75rem; margin-bottom: 1rem;}

  /* Forms */
  .form-group { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1rem; }
  .form-group-inline { flex-direction: row; align-items: center; }
  label { color: #cbd5e1; font-weight: 500; font-size: 0.95rem;}
  select, textarea, input[type="number"] { background: #0f172a; border: 1px solid #334155; color: white; padding: 0.75rem; border-radius: 0.5rem; font-family: inherit; resize: vertical; }
  select:focus, textarea:focus, input[type="number"]:focus { border-color: #3b82f6; outline: none; }
  input[type="number"] { width: 6rem; }
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
  .stats-table td { padding: 0.15rem 0.5rem; border-bottom: 1px solid #1e293b; }
  .stats-table tr:last-child td { border-bottom: none; }
  .bar-row td { padding: 0; border-bottom: 1px solid #1e293b; }
  .bar-cell { padding: 0 0.5rem 0.35rem !important; }
  .player-color-bar { display: flex; height: 5px; border-radius: 3px; overflow: hidden; background: #0f172a; }
  .player-color-bar .bar-seg { flex-shrink: 0; height: 100%; }
  .bar-lineup-change { flex-shrink: 0; width: 2px; height: 100%; background: rgba(255,255,255,0.75); }

  /* Player Minutes panel header row */
  .panel-title-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; }
  .panel-title-row h2 { margin: 0; border: none; padding: 0; }
  .panel-title-right { display: flex; align-items: center; gap: 0.5rem; }
  .plan-controls { display: flex; gap: 0.5rem; margin-bottom: 0.75rem; }
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
  .plan-header-controls { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
  .plan-dirty-actions { display: flex; gap: 0.4rem; align-items: center; }
  .plan-save-action { padding: 0.35rem 0.85rem; font-size: 0.85rem; border-radius: 0.5rem; }

  /* Plan tabs */
  .plan-tabs-row { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.75rem; }
  .plan-tabs { display: flex; gap: 0.3rem; flex-wrap: wrap; flex: 1; }
  .plan-tab {
    background: #1e293b; border: 1px solid #334155; color: #94a3b8;
    padding: 0.15rem 0.75rem; border-radius: 0.4rem 0.4rem 0 0;
    font-size: 0.82rem; font-weight: 600; cursor: pointer; transition: background 0.15s, color 0.15s;
    align-self: flex-end;
  }
  .plan-tab:hover { background: #334155; color: #e2e8f0; }
  .plan-tab-sel { background: #334155; color: #f8fafc; border-bottom-color: #334155; font-size: 0.92rem; padding: 0.4rem 1rem; }
  .plan-tab-live { color: #34d399; }
  .plan-tab-live.plan-tab-sel { color: #34d399; }
  .plan-cur-controls {
    display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
    padding: 0.3rem 0.5rem; background: #1e293b; border: 1px solid #334155; border-radius: 0.4rem;
  }
  .plan-name-edit {
    background: transparent; border: none; border-bottom: 1px solid #475569;
    color: #f8fafc; font-size: 0.85rem; font-weight: 600; font-family: inherit;
    padding: 0.1rem 0.2rem; outline: none; width: 7rem;
  }
  .plan-name-edit:focus { border-bottom-color: #3b82f6; }
  .plan-set-active-btn { font-size: 0.78rem; padding: 0.2rem 0.5rem; }
  .plan-active-badge { color: #34d399; font-size: 0.78rem; font-weight: 700; white-space: nowrap; }
  .plan-delete-btn {
    background: transparent; border: none; color: #ef4444;
    font-size: 0.78rem; font-weight: 600; cursor: pointer; padding: 0.2rem 0.3rem; opacity: 0.7;
  }
  .plan-delete-btn:hover { opacity: 1; }

  /* Add plan modal */
  .add-plan-options { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 0.5rem; }
  .add-plan-option {
    display: flex; flex-direction: column; align-items: flex-start; gap: 0.2rem;
    background: #1e293b; border: 1px solid #334155; border-radius: 0.5rem;
    padding: 0.75rem 1rem; cursor: pointer; text-align: left; transition: background 0.15s;
  }
  .add-plan-option:hover { background: #2d3f55; border-color: #3b82f6; }
  .add-plan-option-title { color: #f8fafc; font-size: 0.95rem; font-weight: 600; }
  .add-plan-option-sub { color: #64748b; font-size: 0.8rem; }

  .plan-grid-wrap { overflow-x: auto; margin-bottom: 0.75rem; }
  .plan-grid { border-collapse: collapse; font-size: 0.88rem; color: #e2e8f0; width: max-content; }

  .plan-pos-th-sep { box-shadow: inset 2px 0 0 #334155; }
  .plan-pos-empty { border-left: 2px solid #334155; background: transparent; padding: 0; }
  .plan-cell-oos { background: #0a0f1a; cursor: default; border-left: 2px solid #334155; }
  .plan-cell-oos:hover { background: #0a0f1a; }

  .plan-pos-th {
    text-align: left; color: #94a3b8; font-weight: 600;
    padding: 0.5rem 0.5rem; border-bottom: 2px solid #334155;
    min-width: 6rem; vertical-align: bottom;
    position: sticky; left: 0; background: #111827; z-index: 2;
  }
  .plan-seg-form-sel { background: #0f172a; border: 1px solid #334155; color: #f8fafc; padding: 0.25rem 0.4rem; border-radius: 0.35rem; font-size: 0.78rem; outline: none; width: 100%; }
  .plan-seg-form-sel:focus { border-color: #3b82f6; }
  .plan-seg-form-ro { color: #94a3b8; font-size: 0.82rem; font-weight: 600; }
  .plan-no-form { color: #475569; font-size: 0.8rem; font-style: italic; text-align: center; padding: 0.5rem; }
  .plan-step-th {
    border-bottom: 2px solid #334155;
    padding: 0.4rem 0.35rem;
    width: 7.5rem;
    vertical-align: top;
  }
  .plan-step-hdr { display: flex; flex-direction: column; gap: 0.3rem; align-items: flex-start; }
  .plan-step-name-input {
    width: 100%; background: transparent; border: none; border-bottom: 1px solid #334155;
    color: #f8fafc; font-size: 0.82rem; font-weight: 600; font-family: inherit;
    padding: 0.1rem 0; outline: none;
  }
  .plan-step-name-input:focus { border-bottom-color: #3b82f6; }
  .plan-step-name-input::placeholder { color: #475569; font-weight: 400; }
  .plan-step-name-ro { color: #f8fafc; font-size: 0.82rem; font-weight: 600; display: block; }
  .plan-dur-row { display: flex; align-items: center; gap: 0.3rem; }
  .plan-dur-input { width: 3.2rem; background: #0f172a; border: 1px solid #334155; color: #f8fafc; padding: 0.25rem 0.4rem; border-radius: 0.35rem; font-size: 0.85rem; text-align: right; outline: none; text-align: left}
  .plan-dur-input:focus { border-color: #3b82f6; }
  .plan-dur-label { color: #64748b; font-size: 0.8rem; }
  .plan-dur-ro { color: #94a3b8; font-size: 0.82rem; }
  .load-lineup-sel { background: #0f172a; border: 1px solid #334155; color: #94a3b8; padding: 0.2rem 0.4rem; border-radius: 0.35rem; font-size: 0.78rem; outline: none; width: 100%; }
  .load-lineup-sel:focus { border-color: #3b82f6; }
  .plan-step-actions { display: flex; gap: 0.2rem; align-items: center; }
  .plan-mv-btn { background: #1e293b; border: 1px solid #334155; color: #94a3b8; width: 1.5rem; height: 1.5rem; border-radius: 0.3rem; cursor: pointer; font-size: 0.75rem; padding: 0; display: flex; align-items: center; justify-content: center; }
  .plan-mv-btn:disabled { opacity: 0.3; cursor: not-allowed; }
  .plan-mv-btn:not(:disabled):hover { background: #334155; }
  .plan-remove { background: transparent; border: none; color: #ef4444; font-size: 1.1rem; cursor: pointer; padding: 0 0.15rem; line-height: 1; opacity: 0.7; }
  .plan-remove:hover { opacity: 1; }

  .plan-pos-td {
    color: #cbd5e1; font-size: 0.88rem; padding: 0.45rem 0.75rem;
    border-bottom: 1px solid #1e293b; white-space: nowrap;
    position: sticky; left: 0; background: #111827; z-index: 1;
  }
  .plan-cell { padding: 0.2rem 0.4rem; border-bottom: 1px solid #1e293b; cursor: pointer; }
  .plan-cell:hover { background: #1e293b; }
  .plan-cell-nav { outline: 2px solid #3b82f6; outline-offset: -2px; background: #1e3a5f !important; }
  .plan-cell-subon { background: rgba(52, 211, 153, 0.08); }
  .plan-cell-subon:hover { background: rgba(52, 211, 153, 0.14); }
  .plan-cell-switched { background: rgba(245, 158, 11, 0.08); }
  .plan-cell-switched:hover { background: rgba(245, 158, 11, 0.14); }
  .plan-cell-val { display: block; font-size: 0.85rem; color: #e2e8f0; padding: 0.2rem 0.15rem; min-height: 1.4rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .plan-player-subon { color: #34d399; }
  .plan-player-switched { color: #f59e0b; }
  .plan-player-ro { color: #94a3b8; font-size: 0.85rem; }
  .plan-cell-input {
    width: 100%; background: transparent; border: none; outline: none;
    color: #f8fafc; font-size: 0.85rem; font-family: inherit;
    padding: 0.2rem 0.15rem; min-height: 1.4rem;
  }

  .plan-dropdown {
    position: fixed; z-index: 1000;
    background: #111827; border: 1px solid #334155; border-radius: 0.4rem;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    max-height: 220px; overflow-y: auto;
    margin-top: 2px;
  }
  .plan-drop-item {
    padding: 0.4rem 0.75rem; font-size: 0.88rem; color: #e2e8f0;
    cursor: pointer; white-space: nowrap;
  }
  .plan-drop-item:hover, .plan-drop-hi { background: #1e293b; }
  .plan-drop-clear { color: #475569; font-style: italic; }
  .plan-drop-empty { padding: 0.4rem 0.75rem; font-size: 0.85rem; color: #475569; }
  .plan-drop-pos { color: #475569; font-size: 0.8rem; margin-left: 0.4rem; }

  .plan-include-btn {
    width: 100%; background: #0f172a; border: 1px solid #334155;
    color: #34d399; font-size: 0.7rem; font-weight: 600;
    padding: 0.15rem 0.3rem; border-radius: 0.3rem; cursor: pointer;
    text-align: center; transition: background 0.15s, color 0.15s;
  }
  .plan-include-btn:hover { background: #1e293b; }
  .plan-include-btn.plan-include-off { color: #475569; border-color: #1e293b; }

  .plan-grand-total { text-align: right; color: #94a3b8; font-size: 0.85rem; }
  .plan-grand-total strong { color: #f8fafc; }

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
  .check-item-locked { cursor: default; opacity: 0.45; }
  .check-item-locked:hover { background: transparent; }
  .check-item input[type="checkbox"] { width: 1rem; height: 1rem; accent-color: #2563eb; flex-shrink: 0; }
  .check-name { flex: 1; color: #f8fafc; font-size: 0.95rem; }
  .check-number { color: #64748b; font-size: 0.85rem; }

  /* Player picker modal */
  .plan-cell { touch-action: manipulation; -webkit-touch-callout: none; user-select: none; }
  .picker-modal { padding: 1.25rem; max-width: 360px; }
  .picker-header { display: flex; align-items: baseline; gap: 0.6rem; margin-bottom: 0.75rem; }
  .picker-pos-label { font-size: 1.05rem; font-weight: 700; color: #f8fafc; }
  .picker-step-label { font-size: 0.82rem; color: #64748b; }
  .picker-list { display: flex; flex-direction: column; gap: 0.2rem; max-height: 55vh; overflow-y: auto; margin-bottom: 0.5rem; }
  .picker-item {
    display: flex; align-items: center; gap: 0.6rem;
    background: #1e293b; border: 1px solid #334155; border-radius: 0.5rem;
    color: #e2e8f0; font-size: 0.95rem; font-family: inherit;
    padding: 0.65rem 0.85rem; cursor: pointer; text-align: left;
    transition: background 0.1s;
  }
  .picker-item:hover, .picker-item:active { background: #2d3f55; }
  .picker-item-active { border-color: #3b82f6; background: #1e3a5f; }
  .picker-item-clear { color: #64748b; font-style: italic; background: transparent; border-color: #1e293b; }
  .picker-num { color: #64748b; font-size: 0.82rem; min-width: 2rem; }
  .picker-name { flex: 1; font-weight: 500; }
  .picker-cur-pos { font-size: 0.78rem; font-weight: 600; padding: 0.1rem 0.4rem; border-radius: 0.25rem; }
  .picker-time { color: #34d399; font-size: 0.82rem; font-variant-numeric: tabular-nums; margin-left: auto; }
  .picker-time-zero { color: #475569; }
  .picker-check { color: #34d399; font-size: 0.9rem; }
  .picker-empty { color: #475569; font-size: 0.9rem; text-align: center; padding: 1rem 0; }
</style>