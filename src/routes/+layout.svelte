<script>
  import { onMount } from 'svelte';
  import { auth } from '$lib/firebase/config';
  import { onAuthStateChanged, signOut } from 'firebase/auth';
  import { authStore } from '$lib/stores/authStore';
  import { goto } from '$app/navigation';

  // Redirect on logout
  $: if (!$authStore.loading && !$authStore.user) {
    goto('/');
  }

  onMount(() => {
    // Listen for Firebase auth changes
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      authStore.set({
        user: user,
        loading: false
      });
    });

    // Cleanup listener on unmount
    return () => unsubscribe();
  });

  function handleLogout() {
    signOut(auth).catch(err => console.error("Logout error:", err));
  }
</script>

<!-- Global Styles (Preserving your original dark theme) -->
<style>
  :global(body) {
    margin: 0;
    background: #0f172a;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #f8fafc;
  }
  :global(*), :global(*::before), :global(*::after) {
    box-sizing: border-box;
  }
  
  .loading-screen {
    height: 100vh;
    display: flex;
    justify-content: center;
    align-items: center;
    font-size: 1.25rem;
    color: #94a3b8;
  }

  /* Global Navbar styles */
  nav {
    background: #111827;
    border-bottom: 1px solid #334155;
    padding: 1rem 2rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .nav-brand {
    font-size: 1.25rem;
    font-weight: 700;
    color: #e2e8f0;
    text-decoration: none;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .nav-logo {
    width: 1.5rem;
    height: 1.5rem;
  }

  .nav-links {
    display: flex;
    gap: 1rem;
    align-items: center;
  }

  .btn-logout {
    background: transparent;
    border: 1px solid #475569;
    color: #e2e8f0;
    padding: 0.4rem 0.8rem;
    border-radius: 0.5rem;
    cursor: pointer;
    font-size: 0.9rem;
  }

  .btn-logout:hover {
    background: #1e293b;
  }

  main {
    padding: 2rem;
    max-width: 1200px;
    margin: 0 auto;
  }
</style>

{#if $authStore.loading}
  <div class="loading-screen">
    Loading Lineup Helper...
  </div>
{:else}
  {#if $authStore.user}
    <!-- Top Navigation for Authenticated Users -->
    <nav>
      <a href="/" class="nav-brand">
        <img src="/favicon.svg" alt="" class="nav-logo" /> Lineup Pro
      </a>
      <div class="nav-links">
        <button class="btn-logout" on:click={handleLogout}>Log Out</button>
      </div>
    </nav>
  {/if}

  <main>
    <slot />
  </main>
{/if}