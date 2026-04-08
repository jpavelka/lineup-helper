<script>
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { doc, getDoc, setDoc, collection, query, where, getDocs, deleteDoc, updateDoc, writeBatch } from 'firebase/firestore';
  import { db } from '$lib/firebase/config';
  import { authStore } from '$lib/stores/authStore';
  import { generateUUID } from '$lib/utils.js';

  const teamId = $page.params.teamId;

  let team = { name: '', roster: [] };
  let lineups = [];
  let formations = [];
  let loading = true;
  let saveStatus = '';

  // New Player Form State
  let newPlayerName = '';
  let newPlayerNumber = '';

  // Accordion State
  let rosterOpen = true;
  let lineupsOpen = true;

  // Inline Edit State
  let editingPlayerId = null;
  let editName = '';
  let editNumber = '';

  onMount(async () => {
    if ($authStore.user) {
      await Promise.all([loadTeam(), loadLineups(), loadFormations()]);
    }
  });

  async function loadTeam() {
    try {
      const docRef = doc(db, 'teams', teamId);
      const docSnap = await getDoc(docRef);
      if (docSnap.exists()) {
        team = docSnap.data();
      } else {
        team = { name: 'Unnamed Team', ownerId: $authStore.user.uid, roster: [] };
        await saveTeamToDb(team);
      }
    } catch (error) {
      console.error("Error loading team:", error);
    } finally {
      loading = false;
    }
  }

  async function loadFormations() {
    try {
      const q = query(collection(db, 'formations'), where('ownerId', '==', $authStore.user.uid));
      const snap = await getDocs(q);
      formations = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(f => f.name).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
    } catch (error) {
      console.error("Error loading formations:", error);
    }
  }

  async function loadLineups() {
    try {
      const q = query(collection(db, 'lineups'), where('teamId', '==', teamId));
      const querySnapshot = await getDocs(q);
      lineups = querySnapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() }))
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
    } catch (error) {
      console.error("Error loading lineups:", error);
    }
  }

  let dragIndex = null;
  let dragOverIndex = null;

  function onDragStart(i) { dragIndex = i; }
  function onDragOver(i) { dragOverIndex = i; }

  async function commitReorder() {
    if (dragIndex === null || dragOverIndex === null || dragIndex === dragOverIndex) {
      dragIndex = null; dragOverIndex = null; return;
    }
    const reordered = [...lineups];
    const [moved] = reordered.splice(dragIndex, 1);
    reordered.splice(dragOverIndex, 0, moved);
    lineups = reordered;
    dragIndex = null; dragOverIndex = null;

    const batch = writeBatch(db);
    reordered.forEach((l, i) => batch.update(doc(db, 'lineups', l.id), { sortOrder: i }));
    await batch.commit();
  }

  function onDrop() { commitReorder(); }

  function onTouchStart(e, i) {
    dragIndex = i;
  }

  function onTouchMove(e) {
    e.preventDefault();
    const touch = e.touches[0];
    const el = document.elementFromPoint(touch.clientX, touch.clientY);
    const item = el?.closest('[data-lineup-index]');
    if (item) {
      const idx = parseInt(item.dataset.lineupIndex);
      if (!isNaN(idx)) dragOverIndex = idx;
    }
  }

  function onTouchEnd() { commitReorder(); }

  async function saveTeamToDb(dataToSave) {
    saveStatus = 'Saving...';
    try {
      const docRef = doc(db, 'teams', teamId);
      await setDoc(docRef, dataToSave, { merge: true });
      saveStatus = 'All changes saved.';
      setTimeout(() => saveStatus = '', 2000);
    } catch (error) {
      console.error("Error saving team:", error);
      saveStatus = 'Error saving data.';
    }
  }

  function updateTeamName(event) {
    team.name = event.target.value;
    saveTeamToDb(team);
  }

  function addPlayer() {
    if (!newPlayerName.trim()) return;
    const trimmed = newPlayerName.trim().toLowerCase();
    if ((team.roster || []).some(p => p.name.toLowerCase() === trimmed)) {
      alert(`A player named "${newPlayerName.trim()}" is already on the roster.`);
      return;
    }
    const newPlayer = {
      id: generateUUID(),
      name: newPlayerName.trim(),
      number: newPlayerNumber.trim() || '-',
    };
    team.roster = [...(team.roster || []), newPlayer];
    newPlayerName = '';
    newPlayerNumber = '';
    saveTeamToDb(team);
  }

  function removePlayer(playerId) {
    if (!confirm("Are you sure you want to remove this player?")) return;
    if (editingPlayerId === playerId) editingPlayerId = null;
    team.roster = team.roster.filter(p => p.id !== playerId);
    saveTeamToDb(team);
  }

  function startEdit(player) {
    editingPlayerId = player.id;
    editName = player.name;
    editNumber = player.number === '-' ? '' : player.number;
  }

  function cancelEdit() {
    editingPlayerId = null;
  }

  function saveEdit(playerId) {
    if (!editName.trim()) return;
    const trimmed = editName.trim().toLowerCase();
    if (team.roster.some(p => p.id !== playerId && p.name.toLowerCase() === trimmed)) {
      alert(`A player named "${editName.trim()}" is already on the roster.`);
      return;
    }
    team.roster = team.roster.map(p =>
      p.id === playerId ? { ...p, name: editName.trim(), number: editNumber.trim() || '-' } : p
    );
    editingPlayerId = null;
    saveTeamToDb(team);
  }

  async function deleteLineup(id) {
    if (!confirm("Delete this lineup?")) return;
    try {
      await deleteDoc(doc(db, 'lineups', id));
      lineups = lineups.filter(l => l.id !== id);
    } catch (error) {
      console.error("Error deleting lineup:", error);
    }
  }
</script>

<svelte:head>
  <title>{team.name || 'Team Hub'} | Lineup Pro</title>
</svelte:head>

{#if loading}
  <div class="loading">Loading Team Data...</div>
{:else}
  <div class="team-hub">

    <!-- Team Header -->
    <header class="hub-header">
      <div class="title-group">
        <span class="muted">Team Hub /</span>
        <input
          type="text"
          class="team-name-input"
          value={team.name}
          on:change={updateTeamName}
          placeholder="Enter Team Name..."
        />
      </div>
      <div class="header-actions">
        <span class="save-status">{saveStatus}</span>
        <div class="default-formation-group">
          <label class="default-formation-label" for="default-formation">Default Formation</label>
          <select
            id="default-formation"
            class="default-formation-select"
            value={team.defaultFormationId || ''}
            on:change={(e) => { team.defaultFormationId = e.target.value || null; saveTeamToDb(team); }}
          >
            <option value="">-- None --</option>
            {#each formations as form}
              <option value={form.id}>{form.name}</option>
            {/each}
          </select>
        </div>
        <a href="/teams/{teamId}/schedule" class="btn-primary">View Schedule</a>
      </div>
    </header>

    <div class="grid-layout">

      <!-- Left Column: Roster -->
      <div class="panel roster-panel">
        <button class="accordion-header" on:click={() => rosterOpen = !rosterOpen}>
          <h2>Current Roster</h2>
          <div class="accordion-right">
            <span class="count-badge">{team.roster?.length || 0} Players</span>
            <span class="chevron" class:open={rosterOpen}>▼</span>
          </div>
        </button>

        {#if rosterOpen}
          <!-- Add Player Form -->
          <form on:submit|preventDefault={addPlayer} class="add-player-form">
            <div class="form-row">
              <input type="text" placeholder="Player Name" bind:value={newPlayerName} required />
              <input type="text" placeholder="#" bind:value={newPlayerNumber} class="number-input" />
              <button type="submit" class="btn-primary small">+ Add</button>
            </div>
          </form>

          <!-- Roster List -->
          {#if !team.roster || team.roster.length === 0}
            <div class="empty-state"><p>Your roster is empty. Add players using the form above.</p></div>
          {:else}
            <ul class="roster-list">
              {#each team.roster.sort((a, b) => a.name.localeCompare(b.name)) as player (player.id)}
                <li class="roster-item">
                  {#if editingPlayerId === player.id}
                    <div class="edit-row">
                      <input type="text" class="edit-name" bind:value={editName} placeholder="Player Name" required />
                      <input type="text" class="edit-number" bind:value={editNumber} placeholder="#" />
                      <div class="edit-actions">
                        <button class="btn-save" on:click={() => saveEdit(player.id)}>✓</button>
                        <button class="btn-cancel" on:click={cancelEdit}>✕</button>
                      </div>
                    </div>
                  {:else}
                    <div class="player-info">
                      <span class="player-number">{player.number}</span>
                      <span class="player-name">{player.name}</span>
                    </div>
                    <div class="player-controls">
                      <button class="btn-icon" on:click={() => startEdit(player)} title="Edit player">✎</button>
                      <button class="btn-remove" on:click={() => removePlayer(player.id)}>✕</button>
                    </div>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        {/if}
      </div>

      <!-- Right Column: Tactical Lineups -->
      <div class="panel">
        <button class="accordion-header" on:click={() => lineupsOpen = !lineupsOpen}>
          <h2>Tactical Lineups</h2>
          <div class="accordion-right">
            <a href="/teams/{teamId}/lineups/new" class="btn-primary small" on:click|stopPropagation>+ New</a>
            <span class="chevron" class:open={lineupsOpen}>▼</span>
          </div>
        </button>

        {#if lineupsOpen}
          <div class="lineup-list">
            {#each lineups as lineup, i}
              <!-- svelte-ignore a11y-no-static-element-interactions -->
              <div
                class="lineup-item"
                class:drag-over={dragOverIndex === i}
                draggable="true"
                data-lineup-index={i}
                on:dragstart={() => onDragStart(i)}
                on:dragover|preventDefault={() => onDragOver(i)}
                on:drop|preventDefault={onDrop}
                on:dragend={() => { dragIndex = null; dragOverIndex = null; }}
                on:touchstart|passive={(e) => onTouchStart(e, i)}
                on:touchmove={onTouchMove}
                on:touchend={onTouchEnd}
              >
                <span class="drag-handle" title="Drag to reorder">⠿</span>
                <div class="lineup-info">
                  <a href="/teams/{teamId}/lineups/{lineup.id}" class="lineup-link">
                    <span class="lineup-name">{lineup.name}</span>
                  </a>
                  <span class="muted small">{lineup.formationName || 'Custom Formation'}</span>
                </div>
                <div class="lineup-actions">
                  <a href="/teams/{teamId}/lineups/{lineup.id}" class="btn-icon">✎</a>
                  <button class="btn-icon danger" on:click={() => deleteLineup(lineup.id)}>✕</button>
                </div>
              </div>
            {/each}
            {#if lineups.length === 0}
              <div class="empty-state mini">No lineups yet.</div>
            {/if}
          </div>
        {/if}
      </div>

    </div>
  </div>
{/if}

<style>
  .loading {
    display: flex;
    justify-content: center;
    padding: 3rem;
    color: #94a3b8;
    font-size: 1.2rem;
  }

  .hub-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    flex-wrap: wrap;
    gap: 1rem;
    margin-bottom: 2rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid #334155;
  }

  .title-group {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .muted {
    color: #94a3b8;
    font-size: 0.9rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .team-name-input {
    background: transparent;
    border: none;
    color: #f8fafc;
    font-size: 2.5rem;
    font-weight: 700;
    padding: 0;
    width: 100%;
    outline: none;
    transition: color 0.2s;
  }
  .team-name-input:focus { color: #3b82f6; }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .default-formation-group {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .default-formation-label {
    color: #94a3b8;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .default-formation-select {
    background: #1e293b;
    border: 1px solid #334155;
    color: #f8fafc;
    padding: 0.5rem 0.75rem;
    border-radius: 0.5rem;
    font-size: 0.9rem;
    cursor: pointer;
    outline: none;
  }
  .default-formation-select:focus { border-color: #3b82f6; }

  .save-status {
    color: #10b981;
    font-size: 0.9rem;
    font-style: italic;
  }

  .grid-layout {
    display: grid;
    grid-template-columns: 1fr;
    gap: 1.5rem;
  }

  @media (max-width: 799px) {
    .lineup-list, .roster-list {
      max-height: 40vh;
      overflow-y: auto;
    }
  }

  @media (min-width: 800px) {
    .grid-layout {
      grid-template-columns: 350px 1fr;
      align-items: start;
    }
  }

  .panel {
    background: #111827;
    border: 1px solid #334155;
    border-radius: 1rem;
    padding: 1.5rem;
  }

  /* Accordion Header */
  .accordion-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    background: transparent;
    border: none;
    color: inherit;
    cursor: pointer;
    padding: 0;
    margin-bottom: 1.25rem;
    text-align: left;
  }

  .accordion-header h2 {
    margin: 0;
    font-size: 1.25rem;
    color: #e2e8f0;
  }

  .accordion-right {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .chevron {
    color: #94a3b8;
    font-size: 0.75rem;
    transition: transform 0.2s;
    display: inline-block;
  }
  .chevron.open { transform: rotate(0deg); }
  .chevron:not(.open) { transform: rotate(-90deg); }

  /* On wide screens, always show chevron but keep accordion functional */

  /* Lineup List */
  .lineup-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .lineup-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: #1e293b;
    border: 1px solid #334155;
    padding: 0.75rem 1rem;
    border-radius: 0.75rem;
    cursor: grab;
  }
  .lineup-item.drag-over { border-color: #3b82f6; background: rgba(59,130,246,0.1); }
  .drag-handle { color: #475569; font-size: 1.1rem; cursor: grab; flex-shrink: 0; }

  .lineup-info {
    display: flex;
    flex-direction: column;
  }

  .lineup-name {
    font-weight: 600;
  }

  .lineup-actions {
    display: flex;
    gap: 0.5rem;
    margin-left: auto;
  }

  /* Add Player Form */
  .add-player-form {
    margin-bottom: 1.25rem;
  }

  .form-row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .add-player-form input {
    background: #0f172a;
    border: 1px solid #334155;
    color: white;
    padding: 0.6rem 0.75rem;
    border-radius: 0.5rem;
    flex: 1;
    min-width: 0;
  }
  .add-player-form input:focus {
    outline: none;
    border-color: #3b82f6;
  }
  .number-input {
    width: 56px;
    flex: 0 0 56px;
    text-align: center;
  }

  /* Roster List */
  .count-badge {
    background: #1e293b;
    padding: 0.25rem 0.75rem;
    border-radius: 1rem;
    font-size: 0.85rem;
    color: #cbd5e1;
  }

  .empty-state {
    padding: 2rem;
    text-align: center;
    color: #64748b;
    background: #0f172a;
    border-radius: 0.5rem;
    border: 1px dashed #334155;
  }
  .empty-state p { margin: 0; }

  .roster-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .roster-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: #1e293b;
    border: 1px solid #334155;
    padding: 0.6rem 0.75rem;
    border-radius: 0.75rem;
    gap: 0.5rem;
  }

  .player-info {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .player-number {
    font-weight: 700;
    color: #94a3b8;
    width: 28px;
    text-align: right;
    font-size: 0.9rem;
  }

  .player-name {
    font-weight: 600;
    color: #f8fafc;
    font-size: 1rem;
  }

  .player-controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  /* Inline Edit Row */
  .edit-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
  }

  .edit-name {
    flex: 1;
    min-width: 0;
    background: #0f172a;
    border: 1px solid #3b82f6;
    color: white;
    padding: 0.4rem 0.6rem;
    border-radius: 0.4rem;
    font-size: 0.95rem;
  }

  .edit-number {
    width: 52px;
    flex: 0 0 52px;
    text-align: center;
    background: #0f172a;
    border: 1px solid #3b82f6;
    color: white;
    padding: 0.4rem 0.4rem;
    border-radius: 0.4rem;
    font-size: 0.95rem;
  }

  .edit-name:focus, .edit-number:focus {
    outline: none;
    border-color: #60a5fa;
  }

  .edit-actions {
    display: flex;
    gap: 0.35rem;
    flex-shrink: 0;
  }

  .btn-save {
    background: #10b981;
    color: white;
    border: none;
    width: 30px;
    height: 30px;
    border-radius: 0.4rem;
    cursor: pointer;
    font-size: 0.9rem;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .btn-save:hover { background: #059669; }

  .btn-cancel {
    background: #334155;
    color: #94a3b8;
    border: none;
    width: 30px;
    height: 30px;
    border-radius: 0.4rem;
    cursor: pointer;
    font-size: 0.9rem;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .btn-cancel:hover { background: #475569; }

  /* Shared Buttons */
  .btn-primary {
    background: #2563eb;
    color: white;
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 0.75rem;
    font-weight: 600;
    cursor: pointer;
    text-decoration: none;
    display: inline-block;
    text-align: center;
    transition: background 0.2s;
  }
  .btn-primary:hover { background: #1d4ed8; }

  .btn-primary.small {
    padding: 0.4rem 0.8rem;
    font-size: 0.85rem;
    border-radius: 0.5rem;
  }

  .btn-icon {
    background: #334155;
    color: white;
    border: none;
    width: 30px;
    height: 30px;
    border-radius: 0.5rem;
    display: flex;
    justify-content: center;
    align-items: center;
    cursor: pointer;
    text-decoration: none;
    font-size: 0.85rem;
    flex-shrink: 0;
  }
  .btn-icon:hover { background: #475569; }
  .btn-icon.danger { color: #ef4444; }

  .btn-remove {
    background: transparent;
    border: none;
    color: #ef4444;
    font-size: 1.1rem;
    cursor: pointer;
    padding: 0.2rem;
    line-height: 1;
    opacity: 0.6;
    flex-shrink: 0;
  }
  .btn-remove:hover { opacity: 1; }

  .small { font-size: 0.85rem; }

  .mini {
    padding: 1rem;
    font-size: 0.9rem;
    color: #64748b;
    text-align: center;
  }
  .lineup-link { text-decoration: none; color: inherit; display: block; width: fit-content; }
  .lineup-link:hover { color: #3b82f6; }
</style>
