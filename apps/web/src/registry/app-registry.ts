import { features } from './features';
import { createRegistry } from './registry';

/** The registry the app runs with. Tests build their own with createRegistry. */
export const appRegistry = createRegistry(features);
