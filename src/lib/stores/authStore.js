import { writable } from 'svelte/store';

export const authStore = writable({
  user: null,
  loading: true // Starts true while Firebase checks credentials
});