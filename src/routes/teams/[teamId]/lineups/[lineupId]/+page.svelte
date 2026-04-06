<script>
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { beforeNavigate } from '$app/navigation';
  import { doc, getDoc, updateDoc, collection, query, where, getDocs } from 'firebase/firestore';
  import { db } from '$lib/firebase/config';
  import { authStore } from '$lib/stores/authStore';
  import { getGroupColor } from '$lib/groupColors.js';

  const teamId = $page.params.teamId;
  const lineupId = $page.params.lineupId;

  let lineup = null;
  let team = null;
  let formation = null;
  let loading = true;
  let saveStatus = '';
  let hasUnsavedChanges = false;

  let selectedItem = null; // { type: 'slot'|'bench', id: string }
  let pitchView = false;
  let showCompareModal = false;
  let selectedComparePos = null; // posId being edited in compare modal
  let otherLineups = []; // all saved lineups for this team except the current one
  let selectedLineupIds = new Set();

  onMount(async () => {
    if ($authStore.user) {
      await loadData();
    }

    const handleBeforeUnload = (e) => {
      if (hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  });

  beforeNavigate(({ cancel }) => {
    if (hasUnsavedChanges) {
      if (!confirm('You have unsaved changes. Are you sure you want to leave?')) {
        cancel();
      }
    }
  });

  async function loadData() {
    try {
      const lineupSnap = await getDoc(doc(db, 'lineups', lineupId));
      if (!lineupSnap.exists()) return;
      lineup = { id: lineupSnap.id, ...lineupSnap.data() };

      const teamSnap = await getDoc(doc(db, 'teams', teamId));
      team = teamSnap.data();

      const formSnap = await getDoc(doc(db, 'formations', lineup.formationId));
      formation = formSnap.data();

      const q = query(collection(db, 'lineups'), where('teamId', '==', teamId));
      const lineupSnaps = await getDocs(q);
      otherLineups = lineupSnaps.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(l => l.id !== lineupId);
      selectedLineupIds = new Set(otherLineups.map(l => l.id));
    } catch (e) {
      console.error("Error loading data:", e);
    } finally {
      loading = false;
    }
  }

  function markChanged() {
    hasUnsavedChanges = true;
    saveStatus = 'Unsaved changes';
  }

  async function saveLineup() {
    saveStatus = 'Saving...';
    try {
      await updateDoc(doc(db, 'lineups', lineupId), {
        players: lineup.players,
        name: lineup.name
      });
      saveStatus = 'All changes saved.';
      hasUnsavedChanges = false;
      setTimeout(() => {
        if (!hasUnsavedChanges) saveStatus = '';
      }, 2000);
    } catch (e) {
      console.error("Error saving lineup:", e);
      saveStatus = 'Error saving.';
    }
  }

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
    let newPlayers = { ...lineup.players };

    if (!payload) {
      if (targetType === 'slot') {
        newPlayers[targetId] = null;
      } else {
        return;
      }
    } else if (payload.type === 'bench' && targetType === 'slot') {
      newPlayers[targetId] = payload.id;
    } 
    else if (payload.type === 'slot' && targetType === 'bench') {
      newPlayers[payload.id] = null; // Clearing slot if dropped on bench
    }
    else if (payload.type === 'slot' && targetType === 'slot') {
      const temp = newPlayers[payload.id];
      newPlayers[payload.id] = newPlayers[targetId];
      newPlayers[targetId] = temp;
    } 

    lineup.players = newPlayers;
    selectedItem = null;
    markChanged();
  }

  function getPlayerName(playerId) {
    if (!playerId) return null;
    const player = team.roster.find(p => p.id === playerId);
    return player ? player.name : 'Unknown';
  }

  $: activePlayerIds = Object.values(lineup?.players || {}).filter(id => id !== null);
  $: benchPlayers = team?.roster.filter(p => !activePlayerIds.includes(p.id)) || [];

  // Comparison: per-player appearance counts across selected lineups + current
  $: selectedOtherLineups = otherLineups.filter(l => selectedLineupIds.has(l.id));
  $: totalLineupCount = selectedOtherLineups.length + 1; // selected others + this one
  $: playerAppearances = (team?.roster || []).map(player => {
    const appearsIn = selectedOtherLineups.filter(l => Object.values(l.players || {}).includes(player.id));
    const inCurrent = activePlayerIds.includes(player.id);
    const count = appearsIn.length + (inCurrent ? 1 : 0);
    return { ...player, count, appearsIn, inCurrent };
  }).sort((a, b) => a.count - b.count || a.name.localeCompare(b.name));

  function toggleLineup(id) {
    if (selectedLineupIds.has(id)) selectedLineupIds.delete(id);
    else selectedLineupIds.add(id);
    selectedLineupIds = selectedLineupIds; // trigger reactivity
  }

  // All lineups in compare order: current first, then selected others
  $: compareLineups = lineup
    ? [{ id: lineupId, name: lineup.name, players: lineup.players }, ...selectedOtherLineups]
    : [];

</script>

<svelte:head>
  <title>Edit Lineup | Lineup Pro</title>
</svelte:head>

{#if loading}
  <div class="loading">Loading Lineup Editor...</div>
{:else if lineup}
  <div class="lineup-editor">
    <header class="editor-header">
      <div class="title-group">
        <a href="/teams/{teamId}" class="back-link">← Back to Team</a>
        <div class="name-edit">
          <input type="text" bind:value={lineup.name} on:input={markChanged} />
          <span class="formation-name muted">{lineup.formationName}</span>
        </div>
      </div>
      <div class="header-actions">
        <span class="save-status" class:unsaved={hasUnsavedChanges}>{saveStatus}</span>
        <button class="btn-compare" on:click={() => showCompareModal = true}>Compare Lineups</button>
        <button class="btn-save" class:active={hasUnsavedChanges} on:click={saveLineup}>Save Changes</button>
      </div>
    </header>

    <div class="editor-layout">
      <!-- Pitch Area -->
      <div class="panel pitch-panel">
        <div class="panel-header">
          <h2>On Field</h2>
          <div class="panel-header-right">
            <span class="count">{activePlayerIds.length} / {formation.positions.length}</span>
            <div class="view-toggle">
              <button class:active={!pitchView} on:click={() => pitchView = false}>List</button>
              <button class:active={pitchView} on:click={() => pitchView = true}>Field</button>
            </div>
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
              {#each formation.positions as pos}
                {@const color = getGroupColor(pos.group)}
                <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
                <div
                  class="field-pos"
                  class:selected={selectedItem?.type === 'slot' && selectedItem?.id === pos.id}
                  class:empty={!lineup.players[pos.id]}
                  style="left: {pos.x}%; top: {pos.y}%;"
                  on:click|stopPropagation={() => handleSlotClick(pos.id)}
                >
                  <div class="field-node" style="background: {color.bg}; border-color: {color.bg};">{pos.name}</div>
                  <div class="field-node-label">{lineup.players[pos.id] ? getPlayerName(lineup.players[pos.id]) : '—'}</div>
                </div>
              {/each}
            </div>
          </div>
        {:else}
          <div class="slots-grid">
            {#each formation.positions as pos}
              {@const color = getGroupColor(pos.group)}
              <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
              <div
                class="slot-card"
                class:selected={selectedItem?.type === 'slot' && selectedItem?.id === pos.id}
                class:empty={!lineup.players[pos.id]}
                on:click={() => handleSlotClick(pos.id)}
              >
                <div class="pos-badge" style="background: {color.bg}; color: {color.text};">{pos.name}</div>

                <div class="player-info">
                  {#if lineup.players[pos.id]}
                    <span class="player-name">{getPlayerName(lineup.players[pos.id])}</span>
                  {:else}
                    <span class="placeholder">Select a player...</span>
                  {/if}
                </div>

                {#if lineup.players[pos.id]}
                  <button class="btn-remove" on:click|stopPropagation={() => executeSwap('slot', pos.id)}>✕</button>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Bench Area -->
      <div class="panel bench-panel">
        <div class="panel-header">
          <h2>Roster</h2>
          <span class="count">{benchPlayers.length} Available</span>
        </div>

        <div class="bench-list">
          {#each benchPlayers.sort((a,b) => a.name.localeCompare(b.name)) as player}
            <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
            <div 
              class="bench-card"
              class:selected={selectedItem?.type === 'bench' && selectedItem?.id === player.id}
              on:click={() => handleBenchClick(player.id)}
            >
              <span class="player-number">{player.number}</span>
              <span class="player-name">{player.name}</span>
            </div>
          {/each}

          {#if benchPlayers.length === 0 && activePlayerIds.length === 0}
             <div class="empty-state">
               No players in roster.
             </div>
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}

<!-- COMPARE PLAYERS MODAL -->
{#if showCompareModal}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="modal-backdrop" on:click={() => { showCompareModal = false; selectedComparePos = null; }}>
    <div class="compare-modal" on:click|stopPropagation>
      <div class="compare-modal-header">
        <div>
          <h2>Lineup Comparison</h2>
          <p class="compare-subtitle">{totalLineupCount} lineup{totalLineupCount !== 1 ? 's' : ''} selected</p>
        </div>
        <button class="btn-close" on:click={() => { showCompareModal = false; selectedComparePos = null; }}">✕</button>
      </div>

      {#if otherLineups.length > 0}
        <div class="lineup-selector">
          <div class="selector-row">
            <span class="selector-label">Include lineups:</span>
            <div class="selector-quick">
              <button on:click={() => { selectedLineupIds = new Set(otherLineups.map(l => l.id)); }}>All</button>
              <button on:click={() => { selectedLineupIds = new Set(); }}>None</button>
            </div>
          </div>
          <div class="lineup-chips">
            <span class="lineup-chip current-chip">{lineup.name}</span>
            {#each otherLineups as l}
              <button
                class="lineup-chip"
                class:selected={selectedLineupIds.has(l.id)}
                on:click={() => toggleLineup(l.id)}
              >{l.name}</button>
            {/each}
          </div>
        </div>
      {/if}

      <div class="compare-body">

        <!-- Position comparison table -->
        {#if compareLineups.length > 1}
          <div class="compare-section-heading">Position Comparison</div>
          <div class="pos-table-wrap">
            <table class="pos-table">
              <thead>
                <tr>
                  <th class="pos-th">Position</th>
                  {#each compareLineups as l}
                    <th class="lineup-th" class:current-th={l.id === lineupId}>{l.name}</th>
                  {/each}
                </tr>
              </thead>
              <tbody>
                {#each formation.positions as pos}
                  {@const color = getGroupColor(pos.group)}
                  {@const currentPlayerId = lineup.players?.[pos.id] ?? null}
                  <tr>
                    <td class="pos-name-cell">
                      <span class="pos-badge-sm" style="background:{color.bg};color:{color.text};">{pos.name}</span>
                    </td>
                    {#each compareLineups as l}
                      {@const pid = l.players?.[pos.id] ?? null}
                      {@const name = getPlayerName(pid)}
                      {#if l.id === lineupId}
                        <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
                        <td
                          class="player-cell current-col"
                          class:pos-selected={selectedComparePos === pos.id}
                          on:click={() => selectedComparePos = selectedComparePos === pos.id ? null : pos.id}
                        >{name ?? '—'}</td>
                      {:else}
                        <td
                          class="player-cell"
                          class:cell-match={pid && pid === currentPlayerId}
                          class:cell-empty={!pid}
                        >{name ?? '—'}</td>
                      {/if}
                    {/each}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}

        <!-- Player appearances -->
        <div class="compare-section-heading">
          {#if selectedComparePos}
            {@const selPos = formation.positions.find(p => p.id === selectedComparePos)}
            {@const color = getGroupColor(selPos?.group)}
            <span>Assign to <span class="pos-badge-sm" style="background:{color.bg};color:{color.text};">{selPos?.name}</span> — pick a player below</span>
            <button class="btn-cancel-assign" on:click={() => selectedComparePos = null}>cancel</button>
          {:else}
            Player Lineup Appearances <span class="heading-hint">(click a position above to reassign)</span>
          {/if}
        </div>
        <div class="compare-list">
          {#each playerAppearances as player}
            <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
            <div
              class="compare-row"
              class:in-current={player.inCurrent}
              class:assignable={selectedComparePos !== null}
              on:click={() => {
                if (selectedComparePos) {
                  lineup.players = { ...lineup.players, [selectedComparePos]: player.id };
                  markChanged();
                  selectedComparePos = null;
                }
              }}
            >
              <div class="compare-player-info">
                <span class="compare-num">#{player.number}</span>
                <span class="compare-name">{player.name}</span>
                {#if player.inCurrent}
                  <span class="current-tag">this lineup</span>
                {/if}
              </div>
              <div class="compare-right">
                <div class="compare-bar-wrap">
                  <div class="compare-bar-track">
                    <div
                      class="compare-bar-fill"
                      class:full={player.count === totalLineupCount}
                      style="width: {totalLineupCount > 0 ? (player.count / totalLineupCount) * 100 : 0}%"
                    ></div>
                  </div>
                  <span class="compare-fraction">{player.count}/{totalLineupCount}</span>
                </div>
                {#if player.appearsIn.length > 0}
                  <div class="compare-lineup-names">
                    {player.appearsIn.map(l => l.name).join(' · ')}
                    {#if player.inCurrent} · {lineup.name}{/if}
                  </div>
                {:else if player.inCurrent}
                  <div class="compare-lineup-names">{lineup.name}</div>
                {/if}
              </div>
            </div>
          {/each}

          {#if playerAppearances.length === 0}
            <p class="compare-empty">No players in roster.</p>
          {/if}
        </div>

      </div>
    </div>
  </div>
{/if}

<style>
  .loading { padding: 3rem; text-align: center; color: #94a3b8; }

  .lineup-editor { padding: 1rem; max-width: 1200px; margin: 0 auto; }

  .editor-header {
    display: flex; justify-content: space-between; align-items: flex-end;
    margin-bottom: 2rem; border-bottom: 1px solid #334155; padding-bottom: 1rem;
  }

  .back-link { color: #3b82f6; text-decoration: none; font-size: 0.9rem; margin-bottom: 0.5rem; display: block; }
  
  .name-edit { display: flex; flex-direction: column; gap: 0.25rem; }
  .name-edit input {
    background: transparent; border: none; color: white; font-size: 2rem; font-weight: 700;
    padding: 0; outline: none; border-bottom: 2px solid transparent; transition: border 0.2s;
  }
  .name-edit input:focus { border-color: #3b82f6; }

  .formation-name { font-size: 1rem; font-weight: 500; }
  
  .header-actions { display: flex; align-items: center; gap: 1rem; }
  @media (max-width: 899px) {
    .editor-header { flex-direction: column; align-items: stretch; }
    .header-actions { width: 100%; justify-content: flex-end; }
  }
  .save-status { color: #10b981; font-size: 0.85rem; font-style: italic; }
  .save-status.unsaved { color: #fbbf24; }

  .btn-save { 
    background: #334155; color: #94a3b8; border: none; padding: 0.6rem 1.2rem; 
    border-radius: 0.5rem; cursor: pointer; font-weight: 600; transition: all 0.2s; 
  }
  .btn-save.active { background: #2563eb; color: white; }
  .btn-save.active:hover { background: #1d4ed8; }

  .editor-layout { 
    display: flex;
    flex-direction: column;
    gap: 1rem;
    height: calc(100vh - 180px);
  }

  .panel { 
    background: #111827; 
    border: 1px solid #334155; 
    border-radius: 0.75rem; 
    padding: 1rem; 
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* Give the pitch panel slightly more weight if needed, or equal */
  .pitch-panel { flex: 1.2; }
  .bench-panel { flex: 1; }

  .panel-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; }
  h2 { margin: 0; font-size: 0.9rem; color: #cbd5e1; text-transform: uppercase; letter-spacing: 0.05em; }
  .count { background: #1e293b; padding: 0.15rem 0.5rem; border-radius: 1rem; font-size: 0.7rem; color: #94a3b8; }

  .slots-grid, .bench-list { 
    overflow-y: auto; 
    flex: 1;
    padding-right: 0.25rem;
  }

  /* Custom Scrollbar */
  .slots-grid::-webkit-scrollbar, .bench-list::-webkit-scrollbar { width: 4px; }
  .slots-grid::-webkit-scrollbar-track, .bench-list::-webkit-scrollbar-track { background: #0f172a; }
  .slots-grid::-webkit-scrollbar-thumb, .bench-list::-webkit-scrollbar-thumb { background: #334155; border-radius: 2px; }

  .slots-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 0.5rem; }
  
  .slot-card {
    background: #1e293b; border: 2px solid transparent; border-radius: 0.5rem; padding: 0.5rem 0.75rem;
    cursor: pointer; position: relative; display: flex; gap: 1rem;
    transition: all 0.2s;
  }
  .slot-card.empty { background: #0f172a; border: 1px dashed #334155; }
  .slot-card.selected { border-color: #3b82f6; background: rgba(59, 130, 246, 0.1); }
  
  .pos-badge { background: #334155; padding: 0.1rem 0.4rem; border-radius: 0.25rem; font-weight: bold; font-size: 0.75rem; min-width: 40px; text-align: center; color: #94a3b8; }
  
  .player-info { font-weight: 600; color: #3b82f6; font-size: 0.9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .placeholder { color: #475569; font-weight: normal; font-size: 0.75rem; }

  .btn-remove {
    position: absolute; top: 0.35rem; right: 0.35rem; background: transparent; border: none;
    color: #ef4444; font-size: 0.8rem; cursor: pointer; opacity: 0.6;
  }
  .btn-remove:hover { opacity: 1; }

  /* Bench Styles */
  .bench-list { display: flex; flex-direction: column; gap: 0.35rem; }
  .bench-card {
    display: flex; align-items: center; gap: 0.5rem; background: #1e293b; border: 2px solid transparent;
    padding: 0.45rem 0.75rem; border-radius: 0.5rem; cursor: pointer; transition: all 0.2s;
  }
  .bench-card:hover { background: #334155; }
  .bench-card.selected { border-color: #3b82f6; background: rgba(59, 130, 246, 0.1); }
  
  .player-number { font-weight: 700; color: #94a3b8; width: 18px; font-size: 0.8rem; }
  .player-name { flex: 1; font-weight: 600; color: #f8fafc; font-size: 0.85rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  @media (min-width: 900px) { 
    .editor-layout { display: grid; grid-template-columns: 1.5fr 1fr; gap: 1.5rem; height: auto; } 
    .pitch-panel, .bench-panel { flex: none; height: auto; }
    .slots-grid, .bench-list { overflow-y: visible; height: auto; }
    .slots-grid { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }
    .panel { padding: 1.5rem; overflow: visible; }
    h2 { font-size: 1.25rem; }
    .pos-badge { font-size: 0.9rem; padding: 0.25rem 0.5rem; }
    .player-info { font-size: 1.1rem; }
  }

  .muted { color: #64748b; }
  .empty-state { text-align: center; color: #64748b; padding: 2rem; }

  /* Panel header extras */
  .panel-header-right { display: flex; align-items: center; gap: 0.5rem; }
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

  @media (min-width: 900px) {
    .field-container { max-width: 320px; }
    .field-node { width: 2.6rem; height: 2.6rem; font-size: 0.7rem; }
    .field-node-label { font-size: 0.65rem; max-width: 4.5rem; }
  }

  /* Compare button */
  .btn-compare { background: #1e293b; border: 1px solid #334155; color: #cbd5e1; padding: 0.6rem 1rem; border-radius: 0.5rem; cursor: pointer; font-weight: 600; font-size: 0.9rem; transition: all 0.2s; }
  .btn-compare:hover { background: #334155; }

  /* Compare modal */
  .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.75); display: flex; justify-content: center; align-items: center; z-index: 50; padding: 1rem; }
  .compare-modal { background: #111827; border: 1px solid #334155; border-radius: 1rem; width: 100%; max-width: 560px; max-height: 85vh; display: flex; flex-direction: column; overflow: hidden; }

  .compare-modal-header { display: flex; justify-content: space-between; align-items: flex-start; padding: 1.5rem 1.5rem 1rem; border-bottom: 1px solid #1e293b; flex-shrink: 0; }

  /* Lineup selector */
  .lineup-selector { padding: 0.85rem 1.5rem; border-bottom: 1px solid #1e293b; flex-shrink: 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .selector-row { display: flex; align-items: center; justify-content: space-between; }
  .selector-label { font-size: 0.8rem; color: #64748b; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
  .selector-quick { display: flex; gap: 0.35rem; }
  .selector-quick button { background: transparent; border: 1px solid #334155; color: #94a3b8; padding: 0.15rem 0.55rem; border-radius: 0.3rem; cursor: pointer; font-size: 0.75rem; font-weight: 600; }
  .selector-quick button:hover { background: #1e293b; color: #f8fafc; }
  .lineup-chips { display: flex; flex-wrap: wrap; gap: 0.4rem; }
  .lineup-chip { background: #1e293b; border: 1px solid #334155; color: #64748b; padding: 0.25rem 0.65rem; border-radius: 1rem; font-size: 0.8rem; font-weight: 600; cursor: pointer; transition: all 0.15s; }
  .lineup-chip.selected { background: #1e3a5f; border-color: #3b82f6; color: #93c5fd; }
  .lineup-chip.current-chip { border-color: #1d4ed8; color: #93c5fd; background: #1e3a5f; cursor: default; }
  .lineup-chip:not(.current-chip):hover { border-color: #475569; color: #cbd5e1; }
  .compare-modal-header h2 { margin: 0 0 0.25rem 0; font-size: 1.15rem; color: #f8fafc; }
  .compare-subtitle { margin: 0; font-size: 0.82rem; color: #64748b; }
  .btn-close { background: transparent; border: none; color: #64748b; font-size: 1.1rem; cursor: pointer; padding: 0.25rem; line-height: 1; flex-shrink: 0; }
  .btn-close:hover { color: #f8fafc; }


  .compare-row { background: #0f172a; border: 1px solid #1e293b; border-radius: 0.6rem; padding: 0.65rem 0.85rem; display: flex; flex-direction: column; gap: 0.35rem; transition: border-color 0.15s; }
  .compare-row.in-current { border-color: #2563eb; background: rgba(37, 99, 235, 0.06); }

  .compare-player-info { display: flex; align-items: center; gap: 0.5rem; }
  .compare-num { color: #64748b; font-size: 0.8rem; font-weight: 700; width: 2rem; flex-shrink: 0; }
  .compare-name { color: #f8fafc; font-weight: 600; font-size: 0.95rem; flex: 1; }
  .current-tag { background: #1d4ed8; color: #bfdbfe; font-size: 0.7rem; font-weight: 700; padding: 0.1rem 0.45rem; border-radius: 1rem; text-transform: uppercase; letter-spacing: 0.04em; flex-shrink: 0; }

  .compare-right { display: flex; flex-direction: column; gap: 0.2rem; }
  .compare-bar-wrap { display: flex; align-items: center; gap: 0.6rem; }
  .compare-bar-track { flex: 1; height: 6px; background: #1e293b; border-radius: 3px; overflow: hidden; }
  .compare-bar-fill { height: 100%; background: #3b82f6; border-radius: 3px; transition: width 0.3s; min-width: 0; }
  .compare-bar-fill.full { background: #10b981; }
  .compare-fraction { font-size: 0.78rem; font-weight: 700; color: #94a3b8; width: 2.5rem; text-align: right; flex-shrink: 0; }

  .compare-lineup-names { font-size: 0.75rem; color: #475569; padding-left: 0.1rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .compare-empty { color: #475569; text-align: center; padding: 2rem; margin: 0; }

  /* Compare body + section headings */
  .compare-body { overflow-y: auto; flex: 1; }
  .compare-body::-webkit-scrollbar { width: 4px; }
  .compare-body::-webkit-scrollbar-thumb { background: #334155; border-radius: 2px; }
  .compare-section-heading { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: #475569; font-weight: 700; padding: 0.75rem 1.5rem 0.35rem; }

  /* Position comparison table */
  .pos-table-wrap { overflow-x: auto; padding: 0 1.5rem 1rem; }
  .pos-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  .pos-th { text-align: left; padding: 0.35rem 0.5rem; color: #64748b; font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; white-space: nowrap; border-bottom: 1px solid #1e293b; }
  .lineup-th { text-align: left; padding: 0.35rem 0.5rem; color: #94a3b8; font-size: 0.75rem; font-weight: 600; white-space: nowrap; border-bottom: 1px solid #1e293b; min-width: 90px; }
  .current-th { color: #93c5fd; }
  .pos-name-cell { padding: 0.3rem 0.5rem; white-space: nowrap; }
  .pos-badge-sm { font-size: 0.72rem; font-weight: 700; padding: 0.12rem 0.45rem; border-radius: 0.3rem; }
  .player-cell { padding: 0.3rem 0.5rem; color: #94a3b8; font-size: 0.82rem; white-space: nowrap; }
  .player-cell.current-col { color: #f8fafc; font-weight: 600; cursor: pointer; }
  .player-cell.current-col:hover { background: rgba(255,255,255,0.05); }
  .player-cell.pos-selected { background: rgba(59,130,246,0.2) !important; color: #93c5fd !important; outline: 1px solid #3b82f6; }
  .compare-row.assignable { cursor: pointer; }
  .compare-row.assignable:hover { background: #1e293b; border-color: #3b82f6; }
  .compare-section-heading { display: flex; align-items: center; gap: 0.5rem; }
  .heading-hint { color: #334155; font-size: 0.65rem; font-weight: 400; text-transform: none; letter-spacing: 0; }
  .btn-cancel-assign { background: transparent; border: 1px solid #475569; color: #94a3b8; font-size: 0.65rem; padding: 0.1rem 0.4rem; border-radius: 0.25rem; cursor: pointer; margin-left: auto; }
  .player-cell.cell-match { background: rgba(16, 185, 129, 0.1); color: #34d399; font-weight: 600; }
  .player-cell.cell-empty { color: #334155; }
  .pos-table tbody tr:hover td { background: rgba(255,255,255,0.02); }

  /* Adjust compare-list to not scroll independently (compare-body handles scrolling) */
  .compare-list { padding: 0.5rem 1.5rem 1.5rem; display: flex; flex-direction: column; gap: 0.5rem; }
</style>