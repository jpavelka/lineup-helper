<script>
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { 
    collection, query, where, getDocs, addDoc, doc, updateDoc, deleteDoc, getDoc 
  } from 'firebase/firestore';
  import { db } from '$lib/firebase/config';
  import { authStore } from '$lib/stores/authStore';

  const teamId = $page.params.teamId;

  let team = null;
  let games = [];
  let loading = true;

  // Modal State
  let showModal = false;
  let editingGame = null;

  onMount(async () => {
    if ($authStore.user) {
      await loadData();
    }
  });

  async function loadData() {
    loading = true;
    try {
      // 1. Load Team (we need the master roster to select available players)
      const teamSnap = await getDoc(doc(db, 'teams', teamId));
      if (teamSnap.exists()) {
        team = { id: teamSnap.id, ...teamSnap.data() };
      }

      // 2. Load Games for this team
      const q = query(collection(db, 'games'), where('teamId', '==', teamId));
      const querySnapshot = await getDocs(q);
      
      games = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      
      // Sort by date ascending
      games.sort((a, b) => new Date(a.date) - new Date(b.date));
    } catch (error) {
      console.error("Error loading schedule data:", error);
    } finally {
      loading = false;
    }
  }

  function openCreateModal() {
    // Default: all current roster players are available
    const allPlayerIds = team?.roster?.map(p => p.id) || [];
    
    editingGame = {
      teamId: teamId,
      opponent: '',
      date: new Date().toISOString().slice(0, 16), // current datetime for datetime-local input
      location: '',
      status: 'scheduled',
      availablePlayers: allPlayerIds
    };
    showModal = true;
  }

  function openEditModal(game) {
    editingGame = JSON.parse(JSON.stringify(game)); // Deep copy to prevent live unsaved edits
    // Ensure availablePlayers array exists
    if (!editingGame.availablePlayers) editingGame.availablePlayers = [];
    showModal = true;
  }

  function togglePlayerAvailability(playerId) {
    const isAvail = editingGame.availablePlayers.includes(playerId);
    if (isAvail) {
      editingGame.availablePlayers = editingGame.availablePlayers.filter(id => id !== playerId);
    } else {
      editingGame.availablePlayers = [...editingGame.availablePlayers, playerId];
    }
  }

  async function saveGame() {
    try {
      if (editingGame.id) {
        // Update existing
        const gameRef = doc(db, 'games', editingGame.id);
        await updateDoc(gameRef, editingGame);
        games = games.map(g => g.id === editingGame.id ? editingGame : g);
      } else {
        // Create new
        const docRef = await addDoc(collection(db, 'games'), editingGame);
        games = [...games, { ...editingGame, id: docRef.id }];
        // Re-sort
        games.sort((a, b) => new Date(a.date) - new Date(b.date));
      }
      showModal = false;
      editingGame = null;
    } catch (error) {
      console.error("Error saving game:", error);
      alert("Failed to save the game.");
    }
  }

  async function deleteGame(gameId) {
    if (!confirm("Are you sure you want to delete this game? This cannot be undone.")) return;
    
    try {
      await deleteDoc(doc(db, 'games', gameId));
      games = games.filter(g => g.id !== gameId);
    } catch (error) {
      console.error("Error deleting game:", error);
    }
  }

  function formatDate(dateString) {
    if (!dateString) return 'TBD';
    const d = new Date(dateString);
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
</script>

<svelte:head>
  <title>Schedule | {team?.name || 'Team'}</title>
</svelte:head>

{#if loading}
  <div class="loading">Loading Schedule...</div>
{:else}
  <div class="schedule-page">
    
    <header class="page-header">
      <div class="title-group">
        <a href="/teams/{teamId}" class="back-link">← Back to Team Hub</a>
        <h1>{team?.name} Schedule</h1>
      </div>
      <button class="btn-primary" on:click={openCreateModal}>+ Add Game</button>
    </header>

    <div class="games-list">
      {#each games as game}
        <div class="game-card">
          <div class="game-info">
            <div class="date-badge">
              <span class="month">{new Date(game.date).toLocaleDateString(undefined, { month: 'short' })}</span>
              <span class="day">{new Date(game.date).getDate()}</span>
            </div>
            <div class="details">
              <h3>vs. {game.opponent || 'TBD'}</h3>
              <p class="muted">
                📍 {game.location || 'Location TBD'} • ⏰ {new Date(game.date).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit'})}
              </p>
              <p class="availability-status">
                {game.availablePlayers?.length || 0} / {team.roster?.length || 0} Players Available
              </p>
            </div>
          </div>
          
          <div class="game-actions">
            <!-- This button will eventually link to the Live Tracker / Game Planner -->
            <a href="/games/{game.id}" class="btn-primary">Game Dashboard</a>
            <button class="btn-secondary" on:click={() => openEditModal(game)}>Edit Game</button>
            <button class="btn-danger" on:click={() => deleteGame(game.id)}>Delete</button>
          </div>
        </div>
      {/each}

      {#if games.length === 0}
        <div class="empty-state">
          No games scheduled yet. Click "+ Add Game" to start your season.
        </div>
      {/if}
    </div>
  </div>
{/if}

<!-- CREATE / EDIT MODAL -->
{#if showModal}
  <div class="modal-backdrop" on:click={() => showModal = false}>
    <div class="modal-panel" on:click|stopPropagation>
      <h2>{editingGame.id ? 'Edit Game' : 'Create New Game'}</h2>
      
      <div class="form-columns">
        <!-- Game Details -->
        <div class="form-section">
          <h3>Match Details</h3>
          <div class="form-group">
            <label>Opponent</label>
            <input type="text" bind:value={editingGame.opponent} placeholder="e.g. Red Bulls" />
          </div>
          <div class="form-group">
            <label>Date & Time</label>
            <input type="datetime-local" bind:value={editingGame.date} />
          </div>
          <div class="form-group">
            <label>Location</label>
            <input type="text" bind:value={editingGame.location} placeholder="e.g. Field 4" />
          </div>
        </div>

        <!-- Roster Availability -->
        <div class="form-section roster-section">
          <h3>Available Players</h3>
          <p class="muted small">Uncheck players who will miss this game.</p>
          <div class="roster-checklist">
            {#each team?.roster?.sort((a,b) => a.name.localeCompare(b.name)) || [] as player}
              <label class="check-item">
                <input 
                  type="checkbox" 
                  checked={editingGame.availablePlayers.includes(player.id)}
                  on:change={() => togglePlayerAvailability(player.id)}
                />
                <span class="player-name">{player.name}</span>
                <span class="player-number">#{player.number}</span>
              </label>
            {/each}
          </div>
        </div>
      </div>

      <div class="modal-actions">
        <button class="btn-secondary" on:click={() => showModal = false}>Cancel</button>
        <button class="btn-primary" on:click={saveGame}>Save Game</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .loading {
    padding: 3rem;
    text-align: center;
    color: #94a3b8;
  }

  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    border-bottom: 1px solid #334155;
    padding-bottom: 1rem;
    margin-bottom: 2rem;
  }

  .back-link {
    color: #3b82f6;
    text-decoration: none;
    font-size: 0.9rem;
    margin-bottom: 0.5rem;
    display: inline-block;
  }
  .back-link:hover { text-decoration: underline; }

  h1 { margin: 0; font-size: 2rem; color: #f8fafc; }

  /* Games List */
  .games-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .game-card {
    background: #111827;
    border: 1px solid #334155;
    border-radius: 1rem;
    padding: 1.5rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 1.5rem;
  }

  .game-info {
    display: flex;
    gap: 1.5rem;
    align-items: center;
  }

  .date-badge {
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 0.75rem;
    padding: 0.5rem 1rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    min-width: 70px;
  }

  .date-badge .month {
    color: #ef4444;
    font-weight: 700;
    font-size: 0.85rem;
    text-transform: uppercase;
  }
  
  .date-badge .day {
    color: #f8fafc;
    font-size: 1.5rem;
    font-weight: 700;
  }

  .details h3 { margin: 0 0 0.25rem 0; font-size: 1.25rem; color: #e2e8f0; }
  .details .muted { margin: 0; color: #94a3b8; font-size: 0.95rem; }
  .availability-status {
    margin: 0.5rem 0 0 0;
    font-size: 0.85rem;
    color: #10b981;
    font-weight: 600;
  }

  .game-actions {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .empty-state {
    text-align: center;
    padding: 3rem;
    background: #111827;
    border: 1px dashed #334155;
    border-radius: 1rem;
    color: #94a3b8;
  }

  /* Modal Styles */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.75);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 50;
    padding: 1rem;
  }

  .modal-panel {
    background: #111827;
    border: 1px solid #334155;
    border-radius: 1rem;
    padding: 2rem;
    width: 100%;
    max-width: 700px;
    max-height: 90vh;
    overflow-y: auto;
  }

  .form-columns {
    display: grid;
    grid-template-columns: 1fr;
    gap: 2rem;
    margin-bottom: 2rem;
  }
  @media (min-width: 600px) {
    .form-columns { grid-template-columns: 1fr 1fr; }
  }

  .form-group {
    margin-bottom: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  
  .form-group label { color: #cbd5e1; font-size: 0.9rem; }
  .form-group input {
    background: #0f172a;
    border: 1px solid #334155;
    color: white;
    padding: 0.75rem;
    border-radius: 0.5rem;
  }
  .form-group input:focus { border-color: #3b82f6; outline: none; }

  /* Roster Checklist inside Modal */
  .roster-checklist {
    background: #0f172a;
    border: 1px solid #334155;
    border-radius: 0.5rem;
    padding: 0.5rem;
    max-height: 250px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-top: 0.5rem;
  }

  .check-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem;
    cursor: pointer;
    border-radius: 0.25rem;
  }
  .check-item:hover { background: #1e293b; }
  .check-item input[type="checkbox"] { width: 1.1rem; height: 1.1rem; accent-color: #2563eb; }
  .check-item .player-name { flex: 1; color: #f8fafc; }
  .check-item .player-number { color: #64748b; font-size: 0.85rem; }

  .small { font-size: 0.85rem; margin-top: 0; }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 1rem;
    padding-top: 1rem;
    border-top: 1px solid #334155;
  }

  /* Buttons */
  .btn-primary {
    background: #2563eb; color: white; border: none; padding: 0.75rem 1.25rem;
    border-radius: 0.5rem; cursor: pointer; font-weight: 600; text-decoration: none;
  }
  .btn-primary:hover { background: #1d4ed8; }
  
  .btn-secondary {
    background: #334155; color: white; border: none; padding: 0.75rem 1.25rem;
    border-radius: 0.5rem; cursor: pointer; font-weight: 600;
  }
  .btn-secondary:hover { background: #475569; }

  .btn-danger {
    background: transparent; border: 1px solid #ef4444; color: #ef4444;
    padding: 0.75rem 1.25rem; border-radius: 0.5rem; cursor: pointer; font-weight: 600;
  }
  .btn-danger:hover { background: #ef4444; color: white; }
</style>