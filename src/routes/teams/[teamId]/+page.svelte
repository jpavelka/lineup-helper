<script>
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { doc, getDoc, setDoc } from 'firebase/firestore';
  import { db } from '$lib/firebase/config';
  import { authStore } from '$lib/stores/authStore';

  const teamId = $page.params.teamId;
  const POS_GROUPS = ['GK', 'DEF', 'MID', 'FWD'];

  let team = { name: '', roster: [] };
  let loading = true;
  let saveStatus = '';

  // New Player Form State
  let newPlayerName = '';
  let newPlayerNumber = '';

  onMount(async () => {
    // If not logged in, wait for the auth store to figure it out, 
    // the layout will handle redirect/showing login.
    if ($authStore.user) {
      await loadTeam();
    }
  });

  async function loadTeam() {
    try {
      const docRef = doc(db, 'teams', teamId);
      const docSnap = await getDoc(docRef);

      if (docSnap.exists()) {
        team = docSnap.data();
      } else {
        // Initialize a new team if it doesn't exist
        team = { 
          name: 'Unnamed Team', 
          ownerId: $authStore.user.uid, 
          roster: [] 
        };
        await saveTeamToDb(team);
      }
    } catch (error) {
      console.error("Error loading team:", error);
    } finally {
      loading = false;
    }
  }

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

    const newPlayer = {
      id: crypto.randomUUID(), // Generate a unique ID for the player
      name: newPlayerName.trim(),
      number: newPlayerNumber.trim() || '-',
      preferredGroups: []
    };

    team.roster = [...(team.roster || []), newPlayer];
    newPlayerName = '';
    newPlayerNumber = '';
    
    saveTeamToDb(team);
  }

  function removePlayer(playerId) {
    if (!confirm("Are you sure you want to remove this player?")) return;
    team.roster = team.roster.filter(p => p.id !== playerId);
    saveTeamToDb(team);
  }

  function toggleTendency(playerId, group) {
    team.roster = team.roster.map(p => {
      if (p.id === playerId) {
        const groups = p.preferredGroups || [];
        if (groups.includes(group)) {
          return { ...p, preferredGroups: groups.filter(g => g !== group) };
        } else {
          return { ...p, preferredGroups: [...groups, group] };
        }
      }
      return p;
    });
    saveTeamToDb(team);
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
        <a href="/teams/{teamId}/schedule" class="btn-primary">View Schedule</a>
      </div>
    </header>

    <div class="grid-layout">
      <!-- Left Column: Add Player Form -->
      <div class="panel add-player-panel">
        <h2>Add to Roster</h2>
        <form on:submit|preventDefault={addPlayer} class="add-player-form">
          <div class="form-row">
            <input 
              type="text" 
              placeholder="Player Name (e.g. Messi)" 
              bind:value={newPlayerName} 
              required
            />
            <input 
              type="text" 
              placeholder="#" 
              bind:value={newPlayerNumber} 
              class="number-input"
            />
          </div>
          <button type="submit" class="btn-primary w-full">+ Add Player</button>
        </form>
      </div>

      <!-- Right Column: Roster Management -->
      <div class="panel roster-panel">
        <div class="roster-header">
          <h2>Current Roster</h2>
          <span class="count-badge">{team.roster?.length || 0} Players</span>
        </div>

        {#if !team.roster || team.roster.length === 0}
          <div class="empty-state">
            <p>Your roster is empty. Add players using the form.</p>
          </div>
        {:else}
          <ul class="roster-list">
            {#each team.roster.sort((a,b) => a.name.localeCompare(b.name)) as player (player.id)}
              <li class="roster-item">
                
                <div class="player-info">
                  <span class="player-number">{player.number}</span>
                  <span class="player-name">{player.name}</span>
                </div>

                <div class="player-controls">
                  <!-- Tendency Tags -->
                  <div class="tendency-group">
                    {#each POS_GROUPS as group}
                      <button 
                        class="tendency-tag {player.preferredGroups?.includes(group) ? 'active' : ''}"
                        on:click={() => toggleTendency(player.id, group)}
                        title="Toggle {group} tendency"
                      >
                        {group}
                      </button>
                    {/each}
                  </div>

                  <button class="btn-remove" on:click={() => removePlayer(player.id)}>✕</button>
                </div>

              </li>
            {/each}
          </ul>
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
  .team-name-input:focus {
    color: #3b82f6;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

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

  @media (min-width: 800px) {
    .grid-layout {
      grid-template-columns: 300px 1fr;
      align-items: start;
    }
  }

  .panel {
    background: #111827;
    border: 1px solid #334155;
    border-radius: 1rem;
    padding: 1.5rem;
  }

  h2 {
    margin-top: 0;
    margin-bottom: 1.25rem;
    font-size: 1.25rem;
    color: #e2e8f0;
  }

  /* Add Player Form */
  .form-row {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  .add-player-form input {
    background: #0f172a;
    border: 1px solid #334155;
    color: white;
    padding: 0.75rem;
    border-radius: 0.5rem;
  }
  .add-player-form input:focus {
    outline: none;
    border-color: #3b82f6;
  }
  .number-input {
    width: 60px;
    text-align: center;
  }

  .w-full {
    width: 100%;
  }

  /* Roster List */
  .roster-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.25rem;
  }
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

  .roster-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .roster-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 1rem;
    background: #1e293b;
    border: 1px solid #334155;
    padding: 0.75rem 1rem;
    border-radius: 0.75rem;
  }

  .player-info {
    display: flex;
    align-items: center;
    gap: 1rem;
    min-width: 150px;
  }

  .player-number {
    font-weight: 700;
    color: #94a3b8;
    width: 25px;
  }

  .player-name {
    font-weight: 600;
    color: #f8fafc;
    font-size: 1.1rem;
  }

  .player-controls {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  /* Tendency Tags */
  .tendency-group {
    display: flex;
    gap: 0.25rem;
    background: #0f172a;
    padding: 0.25rem;
    border-radius: 0.5rem;
  }

  .tendency-tag {
    background: transparent;
    border: none;
    color: #64748b;
    font-size: 0.75rem;
    font-weight: 700;
    padding: 0.25rem 0.5rem;
    border-radius: 0.25rem;
    cursor: pointer;
    transition: all 0.2s;
  }

  .tendency-tag:hover {
    color: #cbd5e1;
    background: #334155;
  }

  .tendency-tag.active {
    background: #3b82f6;
    color: white;
  }

  /* Buttons */
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

  .btn-remove {
    background: transparent;
    border: none;
    color: #ef4444;
    font-size: 1.2rem;
    cursor: pointer;
    padding: 0.25rem;
    line-height: 1;
    opacity: 0.7;
  }
  .btn-remove:hover {
    opacity: 1;
  }
</style>