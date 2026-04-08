<script>
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { collection, query, where, getDocs, addDoc } from 'firebase/firestore';
  import { db } from '$lib/firebase/config';
  import { authStore } from '$lib/stores/authStore';

  const teamId = $page.params.teamId;

  let name = '';
  let selectedFormationId = '';
  let formations = [];
  let existingLineupNames = [];
  let existingMaxSortOrder = -1;
  let loading = true;
  let saving = false;

  $: duplicateName = name.trim() && existingLineupNames.some(n => n.toLowerCase() === name.trim().toLowerCase());

  onMount(async () => {
    if ($authStore.user) {
      await loadFormations();
    }
  });

  async function loadFormations() {
    try {
      const [formSnap, lineupSnap] = await Promise.all([
        getDocs(query(collection(db, 'formations'), where('ownerId', '==', $authStore.user.uid))),
        getDocs(query(collection(db, 'lineups'), where('teamId', '==', teamId)))
      ]);
      formations = formSnap.docs
        .map(doc => ({ id: doc.id, ...doc.data() }))
        .filter(f => f.name)
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
      const existingLineups = lineupSnap.docs.map(d => d.data());
      existingLineupNames = existingLineups.map(d => d.name).filter(Boolean);
      existingMaxSortOrder = existingLineups.reduce((max, l) => Math.max(max, l.sortOrder ?? 0), -1);

      if (formations.length > 0) {
        selectedFormationId = formations[0].id;
      }
    } catch (e) {
      console.error("Error loading formations:", e);
    } finally {
      loading = false;
    }
  }

  async function createLineup() {
    if (!name.trim() || !selectedFormationId || duplicateName) return;
    
    saving = true;
    const formation = formations.find(f => f.id === selectedFormationId);
    
    try {
      const docRef = await addDoc(collection(db, 'lineups'), {
        name: name.trim(),
        teamId: teamId,
        formationId: selectedFormationId,
        formationName: formation.name,
        players: {},
        ownerId: $authStore.user.uid,
        createdAt: Date.now(),
        sortOrder: existingMaxSortOrder + 1
      });
      
      goto(`/teams/${teamId}/lineups/${docRef.id}`);
    } catch (e) {
      console.error("Error creating lineup:", e);
      saving = false;
    }
  }
</script>

<svelte:head>
  <title>New Lineup | Lineup Pro</title>
</svelte:head>

<div class="new-lineup-page">
  <header class="page-header">
    <a href="/teams/{teamId}" class="back-link">← Back to Team</a>
    <h1>Create Tactical Lineup</h1>
  </header>

  {#if loading}
    <p class="muted">Loading formations...</p>
  {:else if formations.length === 0}
    <div class="empty-state">
      <p>You need to create a formation first.</p>
      <a href="/formations" class="btn-primary">Manage Formations</a>
    </div>
  {:else}
    <form on:submit|preventDefault={createLineup} class="create-form">
      <div class="form-group">
        <label for="lineup-name">Lineup Name</label>
        <input
          id="lineup-name"
          type="text"
          bind:value={name}
          placeholder="e.g. Starting XI - 4-4-2"
          required
          class:input-error={duplicateName}
        />
        {#if duplicateName}
          <span class="field-error">A lineup with this name already exists</span>
        {/if}
      </div>

      <div class="form-group">
        <label for="formation-select">Base Formation</label>
        <select id="formation-select" bind:value={selectedFormationId}>
          {#each formations as form}
            <option value={form.id}>{form.name} ({form.positions?.length || 0} positions)</option>
          {/each}
        </select>
      </div>

      <div class="actions">
        <button type="submit" class="btn-primary" disabled={saving || !!duplicateName}>
          {saving ? 'Creating...' : 'Continue to Assignment'}
        </button>
      </div>
    </form>
  {/if}
</div>

<style>
  .new-lineup-page {
    max-width: 600px;
    margin: 2rem auto;
    padding: 0 1rem;
  }

  .page-header {
    margin-bottom: 2rem;
  }

  .back-link {
    color: #3b82f6;
    text-decoration: none;
    font-size: 0.9rem;
    display: block;
    margin-bottom: 0.5rem;
  }

  h1 {
    margin: 0;
    color: #f8fafc;
  }

  .create-form {
    background: #111827;
    border: 1px solid #334155;
    padding: 2rem;
    border-radius: 1rem;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  label {
    color: #94a3b8;
    font-size: 0.9rem;
    font-weight: 600;
  }

  input, select {
    background: #0f172a;
    border: 1px solid #334155;
    color: white;
    padding: 0.75rem;
    border-radius: 0.5rem;
    font-size: 1rem;
  }

  input:focus, select:focus {
    outline: none;
    border-color: #3b82f6;
  }

  input.input-error { border-color: #ef4444; }
  .field-error { font-size: 0.85rem; color: #ef4444; }

  .actions {
    margin-top: 1rem;
  }

  .btn-primary {
    background: #2563eb;
    color: white;
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 0.5rem;
    font-weight: 600;
    cursor: pointer;
    width: 100%;
  }

  .btn-primary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .muted {
    color: #94a3b8;
  }

  .empty-state {
    text-align: center;
    padding: 3rem;
    background: #111827;
    border: 1px dashed #334155;
    border-radius: 1rem;
  }
</style>