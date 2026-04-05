<script>
  import { onMount } from 'svelte';
  import { collection, query, where, getDocs, addDoc, doc, deleteDoc } from 'firebase/firestore';
  import { db } from '$lib/firebase/config';
  import { authStore } from '$lib/stores/authStore';
  import { goto } from '$app/navigation';
  import { generateUUID } from '$lib/utils.js';

  let formations = [];
  let loading = true;

  onMount(async () => {
    if ($authStore.user) {
      await loadFormations();
    }
  });

  async function loadFormations() {
    loading = true;
    try {
      const q = query(collection(db, 'formations'), where('ownerId', '==', $authStore.user.uid));
      const querySnapshot = await getDocs(q);
      formations = querySnapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() }))
        .filter(f => f.name); // Filter out any corrupt/unnamed formations
    } catch (e) {
      console.error("Error loading formations:", e);
    } finally {
      loading = false;
    }
  }

  async function createNewFormation() {
    try {
      // Create a default 4-4-2 formation
      const newFormationRef = await addDoc(collection(db, 'formations'), {
        name: 'New Formation',
        ownerId: $authStore.user.uid,
        groups: ['GK', 'DEF', 'MID', 'FWD'],
        positions: [
          { id: generateUUID(), name: 'GK', group: 'GK', x: 50, y: 92 },
          { id: generateUUID(), name: 'RB', group: 'DEF', x: 85, y: 75 },
          { id: generateUUID(), name: 'RCB', group: 'DEF', x: 60, y: 80 },
          { id: generateUUID(), name: 'LCB', group: 'DEF', x: 40, y: 80 },
          { id: generateUUID(), name: 'LB', group: 'DEF', x: 15, y: 75 },
          { id: generateUUID(), name: 'RM', group: 'MID', x: 80, y: 50 },
          { id: generateUUID(), name: 'RCM', group: 'MID', x: 60, y: 55 },
          { id: generateUUID(), name: 'LCM', group: 'MID', x: 40, y: 55 },
          { id: generateUUID(), name: 'LM', group: 'MID', x: 20, y: 50 },
          { id: generateUUID(), name: 'RS', group: 'FWD', x: 60, y: 25 },
          { id: generateUUID(), name: 'LS', group: 'FWD', x: 40, y: 25 },
        ]
      });
      goto(`/formations/${newFormationRef.id}`);
    } catch (e) {
      console.error("Error creating formation:", e);
    }
  }

  async function deleteFormation(formId, formName) {
    if (!confirm(`Are you sure you want to delete the formation "${formName}"?`)) return;
    try {
      await deleteDoc(doc(db, 'formations', formId));
      formations = formations.filter(f => f.id !== formId);
    } catch (e) {
      console.error("Error deleting formation:", e);
    }
  }
</script>

<svelte:head>
  <title>My Formations</title>
</svelte:head>

<div class="formations-page">
  <header class="page-header">
    <h1>My Formations</h1>
    <button class="btn-primary" on:click={createNewFormation}>+ Create Formation</button>
  </header>

  {#if loading}
    <p class="muted">Loading formations...</p>
  {:else}
    <div class="grid-layout">
      {#each formations as form}
        <div class="formation-card">
          <button class="btn-delete-card" on:click={() => deleteFormation(form.id, form.name)}>✕</button>
          <a href="/formations/{form.id}" class="formation-link">
            <h3>{form.name}</h3>
          </a>
          <p class="muted">{form.positions?.length || 0} Positions</p>
          <a href="/formations/{form.id}" class="btn-secondary">Edit</a>
        </div>
      {/each}

      {#if formations.length === 0}
        <div class="formation-card empty-state">
          <p class="muted">You haven't created any formations yet.</p>
          <button class="btn-primary" on:click={createNewFormation}>Create Your First Formation</button>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .page-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #334155; padding-bottom: 1rem; margin-bottom: 2rem; }
  h1 { margin: 0; }
  .muted { color: #94a3b8; }
  .grid-layout { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 1.5rem; }

  .formation-card {
    position: relative;
    background: #111827; border: 1px solid #334155; border-radius: 1rem;
    padding: 1.5rem; display: flex; flex-direction: column; gap: 0.5rem;
  }
  .formation-card h3 { margin: 0 0 0.25rem 0; font-size: 1.25rem; }
  .formation-card a { margin-top: 1rem; text-align: center; text-decoration: none; }
  .empty-state { border-style: dashed; align-items: center; text-align: center; }

  .btn-primary { background: #2563eb; color: white; border: none; padding: 0.75rem 1.25rem; border-radius: 0.5rem; font-weight: 600; cursor: pointer; }
  .btn-secondary { background: #334155; color: white; border: none; padding: 0.75rem 1.25rem; border-radius: 0.5rem; font-weight: 600; cursor: pointer; }
  .btn-delete-card {
    position: absolute; top: 0.5rem; right: 0.5rem; background: transparent; border: none;
    color: #ef4444; font-size: 1.25rem; cursor: pointer; opacity: 0.5; transition: opacity 0.2s;
  }
  .btn-delete-card:hover { opacity: 1; }

  .formation-link { text-decoration: none; color: inherit; display: block; width: fit-content; }
  .formation-link:hover h3 { color: #3b82f6; }
</style>