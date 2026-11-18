import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { WeftSystem } from './weft.js';

// Outside a headset, say plainly how to play (the scene still animates behind it).
void (
  navigator.xr
    ? navigator.xr.isSessionSupported('immersive-vr').catch(() => false)
    : Promise.resolve(false)
).then((ok) => {
    if (ok) return;
    const note = document.createElement('div');
    note.className = 'weft-note';
    note.innerHTML =
      '<strong>Weft</strong><span>Weave music with your hands.</span><span class="dim">Open this page in the Meta Quest Browser, press Enter XR and play with hand tracking.</span>';
    document.body.appendChild(note);
  });

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  world.registerSystem(WeftSystem);
  if (import.meta.env.DEV && location.search.includes('demo')) {
    void import('./demo.js');
  }
});
