<script>
  import { auth, db } from '$lib/firebase/config';
  import { 
    signInWithEmailAndPassword, 
    createUserWithEmailAndPassword, 
    GoogleAuthProvider, 
    signInWithPopup
  } from 'firebase/auth';
  import { collection, query, where, getDocs, addDoc, deleteDoc, doc, writeBatch } from 'firebase/firestore';
  import { authStore } from '$lib/stores/authStore';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { generateUUID } from '$lib/utils.js';

  // Auth Form State
  let email = '';
  let password = '';
  let isRegistering = false;
  let authError = '';

  // Dashboard State
  let teams = [];
  let loadingTeams = true;
  let formations = [];
  let loadingFormations = true;

  // --- Auth Functions ---
  async function handleEmailAuth(e) {
    e.preventDefault();
    authError = '';
    try {
      if (isRegistering) {
        await createUserWithEmailAndPassword(auth, email, password);
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
    } catch (error) {
      authError = error.message.replace('Firebase: ', '');
    }
  }

  async function handleGoogleLogin() {
    authError = '';
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error("Google login error:", error);
      authError = error.message.replace('Firebase: ', '');
    }
  }

  // --- Dashboard Functions ---
  $: if ($authStore.user) {
    loadUserTeams();
    loadFormations();
  }

  async function loadUserTeams() {
    loadingTeams = true;
    try {
      const q = query(
        collection(db, 'teams'), 
        where('ownerId', '==', $authStore.user.uid)
      );
      const querySnapshot = await getDocs(q);
      teams = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (e) {
      console.error("Error loading teams:", e);
    } finally {
      loadingTeams = false;
    }
  }

  async function createNewTeam() {
    try {
      const newTeamRef = await addDoc(collection(db, 'teams'), {
        name: 'New Team',
        ownerId: $authStore.user.uid,
        roster: []
      });
      goto(`/teams/${newTeamRef.id}`);
    } catch (e) {
      console.error("Error creating team:", e);
      alert("Failed to create a new team.");
    }
  }

  async function loadFormations() {
    loadingFormations = true;
    try {
      const q = query(collection(db, 'formations'), where('ownerId', '==', $authStore.user.uid));
      const snap = await getDocs(q);
      formations = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(f => f.name)
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
    } catch (e) {
      console.error("Error loading formations:", e);
    } finally {
      loadingFormations = false;
    }
  }

  async function createNewFormation() {
    try {
      const ref = await addDoc(collection(db, 'formations'), {
        name: 'New Formation',
        ownerId: $authStore.user.uid,
        groups: ['GK', 'DEF', 'MID', 'FWD'],
        positions: [
          { id: generateUUID(), name: 'GK',  group: 'GK',  x: 50, y: 92 },
          { id: generateUUID(), name: 'RB',  group: 'DEF', x: 85, y: 75 },
          { id: generateUUID(), name: 'RCB', group: 'DEF', x: 60, y: 80 },
          { id: generateUUID(), name: 'LCB', group: 'DEF', x: 40, y: 80 },
          { id: generateUUID(), name: 'LB',  group: 'DEF', x: 15, y: 75 },
          { id: generateUUID(), name: 'RM',  group: 'MID', x: 80, y: 50 },
          { id: generateUUID(), name: 'RCM', group: 'MID', x: 60, y: 55 },
          { id: generateUUID(), name: 'LCM', group: 'MID', x: 40, y: 55 },
          { id: generateUUID(), name: 'LM',  group: 'MID', x: 20, y: 50 },
          { id: generateUUID(), name: 'RS',  group: 'FWD', x: 60, y: 25 },
          { id: generateUUID(), name: 'LS',  group: 'FWD', x: 40, y: 25 },
        ]
      });
      goto(`/formations/${ref.id}`);
    } catch (e) {
      console.error("Error creating formation:", e);
    }
  }

  async function moveFormation(index, dir) {
    const newIndex = index + dir;
    if (newIndex < 0 || newIndex >= formations.length) return;
    const updated = [...formations];
    [updated[index], updated[newIndex]] = [updated[newIndex], updated[index]];
    formations = updated;
    const batch = writeBatch(db);
    formations.forEach((f, i) => batch.update(doc(db, 'formations', f.id), { sortOrder: i }));
    await batch.commit();
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

  async function deleteTeam(teamId, teamName) {
    const isConfirmed = confirm(`Are you sure you want to delete "${teamName}"? This will permanently remove the team and roster.`);
    if (!isConfirmed) return;

    try {
      await deleteDoc(doc(db, 'teams', teamId));
      teams = teams.filter(t => t.id !== teamId);
    } catch (error) {
      console.error("Error deleting team:", error);
      alert("Failed to delete team.");
    }
  }
</script>

<svelte:head>
  <title>Lineup Pro | Coach Dashboard</title>
</svelte:head>

{#if !$authStore.user}
  <div class="hero-container">
    <div class="hero-text">
      <h1>Coach Smarter,<br>Not Harder.</h1>
      <p>The ultimate game-day companion for soccer coaches. Manage rosters, track live player minutes, and design tactical formations with ease.</p>
    </div>

    <div class="auth-card">
      <h2>{isRegistering ? 'Create Coach Account' : 'Coach Login'}</h2>
      
      {#if authError}
        <div class="error-msg">{authError}</div>
      {/if}

      <button class="btn-google" on:click={handleGoogleLogin}>
        <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/layout/google.svg" alt="" width="18">
        Continue with Google
      </button>

      <div class="divider"><span>OR</span></div>

      <form on:submit={handleEmailAuth}>
        <div class="form-group">
          <label for="email">Email Address</label>
          <input type="email" id="email" bind:value={email} required placeholder="coach@team.com" />
        </div>
        <div class="form-group">
          <label for="password">Password</label>
          <input type="password" id="password" bind:value={password} required placeholder="••••••••" />
        </div>
        <button type="submit" class="btn-primary" style="width: 100%; margin-top: 1rem;">
          {isRegistering ? 'Sign Up' : 'Sign In'}
        </button>
      </form>

      <div class="toggle-auth">
        {isRegistering ? 'Already have an account?' : "Don't have an account?"}
        <button class="btn-link" on:click={() => isRegistering = !isRegistering}>
          {isRegistering ? 'Log In' : 'Create One'}
        </button>
      </div>
    </div>
  </div>
{:else}
  <div class="dashboard">
    <header class="dash-header">
      <h1>Coach Dashboard</h1>
    </header>

    <section class="teams-section" id="teams-section">
      <header class="section-header">
        <h2>My Teams</h2>
        <button class="btn-primary" on:click={createNewTeam}>+ Create New Team</button>
      </header>
      
      {#if loadingTeams}
        <p class="muted">Loading your teams...</p>
      {:else}
        <div class="grid-layout">
          {#each teams as team}
            <div class="team-card">
              <button 
                class="btn-delete-card" 
                on:click={() => deleteTeam(team.id, team.name)}
                title="Delete Team"
              >
                ✕
              </button>
              <a href="/teams/{team.id}" class="team-link">
                <h3>{team.name}</h3>
              </a>
              <p class="muted">{team.roster?.length || 0} Players on Roster</p>
              <div class="team-actions">
                <a href="/teams/{team.id}" class="btn-secondary">Manage Team</a>
                <a href="/teams/{team.id}/schedule" class="btn-secondary">Schedule</a>
                <a href="/teams/{team.id}/stats" class="btn-secondary">Season Stats</a>
                <a href="/teams/{team.id}/playingTime" class="btn-secondary">Playing Time</a>
              </div>
            </div>
          {/each}
          
          {#if teams.length === 0}
            <div class="team-card empty-teams" style="text-align: center; justify-content: center; border-style: dashed;">
              <p class="muted">You don't have any teams yet.</p>
              <button class="btn-primary" style="margin-top: 1rem;" on:click={createNewTeam}>
                Create Your First Team
              </button>
            </div>
          {/if}
        </div>
      {/if}
    </section>

    <section class="formations-section" id="formations-section">
      <header class="section-header">
        <h2>My Formations</h2>
        <button class="btn-primary" on:click={createNewFormation}>+ Create Formation</button>
      </header>

      {#if loadingFormations}
        <p class="muted">Loading formations...</p>
      {:else}
        <div class="grid-layout">
          {#each formations as form, i}
            <div class="formation-card">
              <button class="btn-delete-card" on:click={() => deleteFormation(form.id, form.name)}>✕</button>
              <div class="reorder-btns">
                <button class="btn-reorder" disabled={i === 0} on:click={() => moveFormation(i, -1)} title="Move up">▲</button>
                <button class="btn-reorder" disabled={i === formations.length - 1} on:click={() => moveFormation(i, 1)} title="Move down">▼</button>
              </div>
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
    </section>
  </div>
{/if}

<style>
  /* --- Login/Hero Styles --- */
  .hero-container {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 4rem;
    min-height: 80vh;
  }

  .hero-text {
    flex: 1;
    min-width: 300px;
    max-width: 500px;
  }

  .hero-text h1 {
    font-size: clamp(2.5rem, 5vw, 4rem);
    margin-bottom: 1rem;
    line-height: 1.1;
    background: linear-gradient(to right, #3b82f6, #06b6d4);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .hero-text p {
    font-size: 1.1rem;
    color: #94a3b8;
    line-height: 1.6;
  }

  .auth-card {
    background: #111827;
    border: 1px solid #334155;
    padding: 2.5rem;
    border-radius: 1.5rem;
    width: 100%;
    max-width: 400px;
    box-shadow: 0 20px 40px rgba(0,0,0,0.4);
  }

  .auth-card h2 {
    margin-top: 0;
    margin-bottom: 1.5rem;
    text-align: center;
  }

  .btn-google {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    background: white;
    color: #1e293b;
    border: none;
    padding: 0.75rem;
    border-radius: 0.75rem;
    font-weight: 600;
    font-size: 1rem;
    cursor: pointer;
    transition: background 0.2s;
  }

  .btn-google:hover { background: #f1f5f9; }

  .divider {
    display: flex;
    align-items: center;
    text-align: center;
    margin: 1.5rem 0;
    color: #64748b;
    font-size: 0.85rem;
  }
  .divider::before, .divider::after {
    content: '';
    flex: 1;
    border-bottom: 1px solid #334155;
  }
  .divider span { padding: 0 1rem; }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  .form-group label {
    font-size: 0.9rem;
    color: #cbd5e1;
  }

  .form-group input {
    padding: 0.75rem;
    border-radius: 0.75rem;
    border: 1px solid #334155;
    background: #0f172a;
    color: white;
    font-size: 1rem;
  }
  .form-group input:focus {
    outline: none;
    border-color: #3b82f6;
  }

  .error-msg {
    background: rgba(239, 68, 68, 0.1);
    color: #ef4444;
    padding: 0.75rem;
    border-radius: 0.5rem;
    font-size: 0.9rem;
    margin-bottom: 1rem;
    text-align: center;
  }

  .toggle-auth {
    margin-top: 1.5rem;
    text-align: center;
    font-size: 0.9rem;
    color: #94a3b8;
  }

  .btn-link {
    background: none;
    border: none;
    color: #3b82f6;
    cursor: pointer;
    font-weight: 600;
  }
  .btn-link:hover { text-decoration: underline; }

  /* --- Dashboard Styles --- */
  .dash-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 2.5rem;
    flex-wrap: wrap;
    gap: 1rem;
  }

  .dash-header h1 { margin: 0; }

  .teams-section, .formations-section {
    margin-bottom: 3rem;
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
  }
  .section-header h2 { margin: 0; }

  .grid-layout {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 1.5rem;
    margin-top: 1.5rem;
  }

  .team-card {
    position: relative;
    background: #111827;
    border: 1px solid #334155;
    border-radius: 1rem;
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .team-card h3 { margin: 0; font-size: 1.25rem; }
  .team-link { text-decoration: none; color: inherit; display: block; width: fit-content; }
  .team-link:hover h3 { color: #3b82f6; }
  .muted { color: #94a3b8; margin: 0; }

  .team-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
    margin-top: auto;
  }

  .btn-delete-card {
    position: absolute;
    top: 1rem;
    right: 1rem;
    background: transparent;
    border: none;
    color: #ef4444;
    font-size: 1.25rem;
    cursor: pointer;
    opacity: 0.5;
    transition: opacity 0.2s;
    padding: 0.25rem;
    line-height: 1;
  }

  .btn-delete-card:hover {
    opacity: 1;
  }

  .formation-card {
    position: relative;
    background: #111827;
    border: 1px solid #334155;
    border-radius: 1rem;
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .formation-card h3 { margin: 0 0 0.25rem 0; font-size: 1.25rem; }
  .formation-card .btn-secondary { margin-top: auto; text-align: center; text-decoration: none; }
  .empty-state { border-style: dashed; align-items: center; text-align: center; }

  .formation-link { text-decoration: none; color: inherit; display: block; width: fit-content; }
  .formation-link:hover h3 { color: #3b82f6; }

  .reorder-btns {
    position: absolute;
    top: 0.5rem;
    left: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  .btn-reorder {
    background: transparent;
    border: none;
    color: #64748b;
    font-size: 0.6rem;
    padding: 0.1rem 0.3rem;
    cursor: pointer;
    line-height: 1;
    border-radius: 0.2rem;
    transition: color 0.15s;
  }
  .btn-reorder:hover:not(:disabled) { color: #cbd5e1; }
  .btn-reorder:disabled { opacity: 0.2; cursor: default; }

  /* Shared Buttons */
  .btn-primary {
    background: #2563eb;
    color: white;
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 0.75rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s;
  }
  .btn-primary:hover { background: #1d4ed8; }

  .btn-secondary {
    background: #334155;
    color: white;
    border: none;
    padding: 0.5rem 1rem;
    border-radius: 0.5rem;
    font-size: 0.9rem;
    cursor: pointer;
    text-decoration: none;
    text-align: center;
    flex: 1;
  }
  .btn-secondary:hover { background: #475569; }
</style>