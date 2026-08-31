import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { initPwa } from '../lib/pwa.svelte';
import { probeCapabilities } from '../lib/settings.svelte';
import '../lib/skins.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('#app missing in mobile.html');

const app = mount(App, { target });
initPwa();
probeCapabilities();

export default app;
