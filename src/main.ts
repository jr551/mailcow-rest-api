import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { initPwa } from './lib/pwa.svelte';
// Apply persisted skin before App mounts so users never see a flash of the
// default palette.
import './lib/skins.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('#app missing in index.html');

const app = mount(App, { target });
initPwa();

export default app;
