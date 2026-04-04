<script>
  import { auth, db } from '$lib/firebase/config';
  import { 
    signInWithEmailAndPassword, 
    createUserWithEmailAndPassword, 
    GoogleAuthProvider, 
    signInWithRedirect 
  } from 'firebase/auth';
  // ADDED deleteDoc and doc here:
  import { collection, query, where, getDocs, addDoc, deleteDoc, doc } from 'firebase/firestore';
  import { authStore } from '$lib/stores/authStore';
  import { goto } from '$app/navigation';

  // Auth Form State
  let email = '';
  let password = '';
  let isRegistering = false;
  let authError = '';

  // Dashboard State
  let teams = [];
  let loadingTeams = true;

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
      await signInWithRedirect(auth, provider);
    } catch (error) {
      authError = error.message.replace('Firebase: ', '');
    }
  }

  // --- Dashboard Functions ---
  $: if ($authStore.user) {
    loadUserTeams();
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

  // NEW FUNCTION: Delete Team
  async function deleteTeam(teamId, teamName) {
    const isConfirmed = confirm(`Are you sure you want to delete "${teamName}"? This will permanently remove the team and roster.`);
    if (!isConfirmed) return;

    try {
      // Delete from Firestore
      await deleteDoc(doc(db, 'teams', teamId));
      
      // Remove from local UI state reactively
      teams = teams.filter(t => t.id !== teamId);
    } catch (error) {
      console.error("Error deleting team:", error);
      alert("Failed to delete team.");
    }
  }
</script>

<svelte:head>
  <title>Lineup Helper Pro</title>
</svelte:head>

{#if !$authStore.user}
  <!-- ... (KEEP YOUR EXISTING UNAUTHENTICATED HERO/LOGIN VIEW HERE) ... -->
  <!-- ... (I omitted it here for brevity, keep the div class="hero-container" stuff) ... -->
  
{:else}
  <!-- AUTHENTICATED VIEW: COACH DASHBOARD -->
  <div class="dashboard">
    <header class="dash-header">
      <h1>Coach Dashboard</h1>
      <button class="btn-primary" on:click={createNewTeam}>+ Create New Team</button>
    </header>

    <section class="teams-section">
      <h2>My Teams</h2>
      
      {#if loadingTeams}
        <p class="muted">Loading your teams...</p>
      {:else}
        <div class="grid-layout">
          {#each teams as team}
            <div class="team-card"><button 
                class="btn-delete-card" 
                on:click={() => deleteTeam(team.id, team.name)}
                title="Delete Team"
              >
                ✕
              </button>
              <h3>{team.name}</h3>
              <p class="muted">{team.roster?.length || 0} Players on Roster</p>
              <div class="team-actions">
                <a href="/teams/{team.id}" class="btn-secondary">Manage Team</a>
                <a href="/teams/{team.id}/schedule" class="btn-secondary">Schedule</a>
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

    <section class="quick-actions-section">
      <h2>Quick Actions</h2>
      <div class="grid-layout">
        <a href="/formations" class="quick-action-card">
          <div class="icon">⚽</div>
          <div class="details">
            <h3>Global Formations</h3>
            <p>Build and edit tactical formations (e.g., 4-3-3, 3-5-2) to use across all your teams.</p>
          </div>
        </a>
      </div>
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

  .teams-section, .quick-actions-section {
    margin-bottom: 3rem;
  }

  .grid-layout {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 1.5rem;
    margin-top: 1.5rem;
  }

  .team-card {
    background: #111827;
    border: 1px solid #334155;
    border-radius: 1rem;
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .team-card h3 { margin: 0; font-size: 1.25rem; }
  .muted { color: #94a3b8; margin: 0; }

  .team-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: auto;
  }

  .quick-action-card {
    background: #111827;
    border: 1px solid #334155;
    border-radius: 1rem;
    padding: 1.5rem;
    display: flex;
    gap: 1rem;
    text-decoration: none;
    color: inherit;
    transition: transform 0.2s, border-color 0.2s;
  }

  .quick-action-card:hover {
    transform: translateY(-2px);
    border-color: #3b82f6;
  }

  .quick-action-card .icon {
    font-size: 2rem;
  }

  .quick-action-card h3 { margin: 0 0 0.25rem 0; color: #3b82f6;}
  .quick-action-card p { margin: 0; color: #94a3b8; font-size: 0.9rem; line-height: 1.4;}

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
  .team-card {
    /* Make sure team-card has position: relative to anchor the delete button */
    position: relative; 
    background: #111827;
    border: 1px solid #334155;
    border-radius: 1rem;
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  /* NEW: Delete Button Styles */
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
</style>