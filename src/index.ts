import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { WeftSystem } from './weft.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  world.registerSystem(WeftSystem);
  if (import.meta.env.DEV && location.search.includes('demo')) {
    void import('./demo.js');
  }
});
