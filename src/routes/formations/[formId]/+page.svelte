<script>
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { beforeNavigate } from '$app/navigation';
  import { doc, getDoc, updateDoc } from 'firebase/firestore';
  import { db } from '$lib/firebase/config';
  import { generateUUID } from '$lib/utils.js';
  import { getGroupColor } from '$lib/groupColors.js';

  const formId = $page.params.formId;

  let formation = null;
  let loading = true;
  let saveStatus = '';
  let hasUnsavedChanges = false;
  let editMode = 'list'; // 'field' or 'list'

  let draggedPos = null;

  onMount(async () => {
    await loadFormation();

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

  async function loadFormation() {
    try {
      const docSnap = await getDoc(doc(db, 'formations', formId));
      if (docSnap.exists()) {
        const data = docSnap.data();
        if (!data.groups) data.groups = ['GK', 'DEF', 'MID', 'FWD'];
        formation = data;
      }
    } catch (e) {
      console.error("Error loading formation:", e);
    } finally {
      loading = false;
    }
  }

  async function saveChanges() {
    saveStatus = 'Saving...';
    try {
      await updateDoc(doc(db, 'formations', formId), formation);
      saveStatus = 'All changes saved.';
      hasUnsavedChanges = false;
      setTimeout(() => saveStatus = '', 2000);
    } catch (e) {
      saveStatus = 'Error saving.';
      console.error("Save error:", e);
    }
  }

  function markChanged() {
    hasUnsavedChanges = true;
    saveStatus = 'Unsaved changes';
  }

  function startDrag(pos) {
    draggedPos = pos;
  }

  function onDrag(event) {
    if (!draggedPos) return;
    const rect = event.currentTarget.getBoundingClientRect();
    let x = ((event.clientX - rect.left) / rect.width) * 100;
    let y = ((event.clientY - rect.top) / rect.height) * 100;
    x = Math.max(0, Math.min(100, x));
    y = Math.max(0, Math.min(100, y));

    formation.positions = formation.positions.map(p => 
      p.id === draggedPos.id ? { ...p, x, y } : p
    );
    markChanged();
  }

  function stopDrag() {
    if (draggedPos) {
      draggedPos = null;
    }
  }

  function addPosition() {
    formation.positions = [...formation.positions, { 
      id: generateUUID(), name: 'NEW', group: formation.groups[0] || 'GK', x: 50, y: 50 
    }];
    markChanged();
  }

  function removePosition(id) {
    formation.positions = formation.positions.filter(p => p.id !== id);
    markChanged();
  }

  function addGroup() {
    formation.groups = [...formation.groups, 'NEW'];
    markChanged();
  }

  function removeGroup(index) {
    if (formation.groups.length <= 1) return;
    formation.groups = formation.groups.filter((_, i) => i !== index);
    markChanged();
  }
</script>

<svelte:window on:pointerup={stopDrag} />

<svelte:head>
  <title>Edit Formation | {formation?.name || ''}</title>
</svelte:head>

{#if loading}
  <p class="muted">Loading Formation Editor...</p>
{:else if formation}
  <div class="formation-builder">
    <header>
      <div class="title-group">
        <a href="/formations" class="back-link">← All Formations</a>
        <input class="name-input" bind:value={formation.name} on:input={markChanged} />
        <span class="pos-count muted">({formation.positions?.length || 0} positions)</span>
      </div>
      <div class="controls">
        <span class="save-status" class:unsaved={hasUnsavedChanges}>{saveStatus}</span>
        <div class="mode-toggle">
          <button class:active={editMode === 'list'} on:click={() => editMode = 'list'}>List View</button>
          <button class:active={editMode === 'field'} on:click={() => editMode = 'field'}>Field View</button>
        </div>
        <button class="btn-save" class:active={hasUnsavedChanges} on:click={saveChanges}>Save Changes</button>
      </div>
    </header>

    {#if editMode === 'field'}
      <div class="field-container" on:pointermove={onDrag}>
        <div class="field-lines">
          <div class="center-circle"></div>
          <div class="penalty-arc top"></div>
          <div class="penalty-arc bottom"></div>
          <div class="penalty-box top"></div>
          <div class="penalty-box bottom"></div>
          <div class="goal-box top"></div>
          <div class="goal-box bottom"></div>
        </div>

        {#each formation.positions as pos (pos.id)}
          {@const color = getGroupColor(pos.group)}
          <div
            class="position-node"
            class:dragging={draggedPos?.id === pos.id}
            style="left: {pos.x}%; top: {pos.y}%; background: {color.bg}; border-color: {color.bg};"
            on:pointerdown|preventDefault={() => startDrag(pos)}
          >
            <div class="node-label">{pos.name}</div>
            <div class="node-group">{pos.group}</div>
          </div>
        {/each}
      </div>
      <div class="field-actions">
        <button class="btn-secondary" on:click={addPosition}>+ Add Position</button>
      </div>
    {:else}
      <div class="list-view">
        <div class="section-container">
          <div class="groups-manager">
            <h4>Tactical Groups</h4>
            <div class="groups-grid">
              {#each formation.groups as group, i}
                {@const color = getGroupColor(group)}
                <div class="group-item" style="border-left: 3px solid {color.bg};">
                  <span class="group-swatch" style="background: {color.bg};"></span>
                  <input type="text" bind:value={formation.groups[i]} on:input={markChanged} />
                  <button class="btn-icon-danger" on:click={() => removeGroup(i)} title="Remove Group">✕</button>
                </div>
              {/each}
              <button class="btn-secondary small" on:click={addGroup}>+ Add Group</button>
            </div>
          </div>
        </div>

        <div class="section-container">
          <h4>Positions</h4>
          <table class="positions-table">
            <thead>
              <tr>
                <th>Pos Name</th>
                <th>Group</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {#each formation.positions as pos (pos.id)}
                <tr>
                  <td><input type="text" bind:value={pos.name} on:input={markChanged} /></td>
                  <td>
                    <div class="group-select-row">
                      <span class="group-swatch" style="background: {getGroupColor(pos.group).bg};"></span>
                      <select bind:value={pos.group} on:change={markChanged}>
                        {#each formation.groups as group}
                          <option value={group}>{group}</option>
                        {/each}
                      </select>
                    </div>
                  </td>
                  <td class="text-right">
                    <button class="btn-danger" on:click={() => removePosition(pos.id)}>x</button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
          <button class="btn-secondary" on:click={addPosition} style="margin-top: 1rem;">+ Add Position</button>
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .formation-builder { padding: 1rem; max-width: 800px; margin: 0 auto; color: white;}
  header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; flex-wrap: wrap; gap: 1rem;}
  .title-group { display: flex; flex-direction: column; gap: 0.25rem; }
  .back-link { color: #3b82f6; text-decoration: none; font-size: 0.9rem; }
  .name-input { background: transparent; border: none; color: white; font-size: 1.75rem; font-weight: bold; padding: 0; flex: 1; min-width: 200px; }
  .name-input:focus { outline: none; border-bottom: 1px solid #334155; }
  
  .pos-count { font-size: 0.9rem; font-weight: normal; }
  
  .controls { display: flex; align-items: center; gap: 1.5rem; flex-wrap: wrap; }
  .save-status { font-size: 0.85rem; color: #10b981; font-style: italic; }
  .save-status.unsaved { color: #fbbf24; }
  
  .mode-toggle { display: flex; background: #1e293b; border-radius: 0.5rem; padding: 0.25rem; }
  .mode-toggle button { background: transparent; border: none; color: #94a3b8; padding: 0.4rem 0.8rem; border-radius: 0.35rem; cursor: pointer; font-size: 0.9rem; font-weight: 500; }
  .mode-toggle button.active { background: #334155; color: white; }

  .btn-save { background: #334155; color: #94a3b8; border: none; padding: 0.6rem 1.2rem; border-radius: 0.5rem; cursor: pointer; font-weight: 600; transition: all 0.2s; }
  .btn-save.active { background: #2563eb; color: white; }
  
  .btn-secondary { background: #334155; color: white; border: none; padding: 0.6rem 1.2rem; border-radius: 0.5rem; cursor: pointer; font-weight: 600; }
  .btn-secondary.small { padding: 0.4rem 0.8rem; font-size: 0.85rem; }
  .btn-danger { background: #7f1d1d; color: #fecaca; border: none; padding: 0.3rem 0.6rem; border-radius: 0.35rem; cursor: pointer; font-size: 0.85rem; }
  .btn-icon-danger { background: transparent; border: none; color: #ef4444; font-size: 1.1rem; cursor: pointer; opacity: 0.6; }
  .btn-icon-danger:hover { opacity: 1; }

  .section-container { background: #111827; border: 1px solid #334155; border-radius: 1rem; padding: 1.5rem; margin-bottom: 1.5rem; }
  h4 { margin: 0 0 1rem 0; color: #94a3b8; font-size: 0.9rem; text-transform: uppercase; letter-spacing: 0.05em; }

  /* Groups Manager */
  .groups-grid { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; }
  .group-item { display: flex; align-items: center; background: #1e293b; border: 1px solid #334155; border-radius: 0.5rem; padding-left: 0.5rem; overflow: hidden; }
  .group-item input { background: transparent; border: none; color: white; padding: 0.4rem 0; font-size: 0.9rem; width: 80px; text-align: center; }
  .group-item input:focus { outline: none; }
  .group-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .group-select-row { display: flex; align-items: center; gap: 0.5rem; }

  /* Field styles */
  .field-container { position: relative; width: 100%; max-width: 400px; margin: 0 auto; aspect-ratio: 2 / 3; background: #166534; border: 3px solid #fff; border-radius: 8px; overflow: hidden; touch-action: none; }
  .field-lines { position: absolute; inset: 0; pointer-events: none; }
  .field-lines::before { content: ''; position: absolute; top: 50%; left: 0; right: 0; height: 2px; background: white; }
  .center-circle { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 25%; aspect-ratio: 1; border: 2px solid white; border-radius: 50%; }
  .penalty-box { position: absolute; width: 50%; height: 15%; border: 2px solid white; left: 25%; }
  .penalty-box.top { top: 0; border-top: none; }
  .penalty-box.bottom { bottom: 0; border-bottom: none; }
  .goal-box { position: absolute; width: 25%; height: 5%; border: 2px solid white; left: 37.5%; }
  .goal-box.top { top: 0; border-top: none; }
  .goal-box.bottom { bottom: 0; border-bottom: none; }
  .penalty-arc { position: absolute; width: 25%; aspect-ratio: 1; border: 2px solid white; border-radius: 50%; left: 37.5%; }
  .penalty-arc.top { top: 11%; transform: translateY(-50%); clip-path: inset(74% 0 0 0); }
  .penalty-arc.bottom { bottom: 11%; transform: translateY(50%); clip-path: inset(0 0 74% 0); }
  
  .position-node { position: absolute; transform: translate(-50%, -50%); background: #334155; border: 2px solid #94a3b8; color: white; width: 2.5rem; height: 2.5rem; border-radius: 50%; display: flex; flex-direction: column; justify-content: center; align-items: center; cursor: grab; user-select: none; box-shadow: 0 4px 6px rgba(0,0,0,0.3); transition: transform 0.1s, box-shadow 0.1s, background 0.2s; }
  .position-node.dragging { cursor: grabbing; transform: translate(-50%, -50%) scale(1.1); box-shadow: 0 10px 15px rgba(0,0,0,0.5); z-index: 10; border-color: #3b82f6; }
  .node-label { font-weight: bold; font-size: 0.8rem; }
  .node-group { font-size: 0.55rem; color: #cbd5e1; }
  .field-actions { display: flex; justify-content: center; margin-top: 1.5rem; }

  /* List styles */
  .positions-table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; }
  .positions-table th { text-align: left; padding: 0.75rem; border-bottom: 1px solid #334155; color: #94a3b8; font-size: 0.9rem; }
  .positions-table td { padding: 0.75rem; border-bottom: 1px solid #1e293b; }
  .positions-table input[type="text"] { background: #0f172a; border: 1px solid #334155; color: white; padding: 0.4rem 0.6rem; border-radius: 0.35rem; width: 100%; }
  .positions-table select { background: #0f172a; border: 1px solid #334155; color: white; padding: 0.4rem 0.6rem; border-radius: 0.35rem; width: 100%; }
  .text-right { text-align: right; }
  .muted { color: #64748b; font-size: 0.85rem; }
</style>