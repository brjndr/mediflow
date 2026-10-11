/**
 * The one part of the auth feature the app shell needs at once, kept apart from `index.ts` so that
 * importing it does not pull the pages (which load on demand) into the first load.
 */
export { RequireMfa } from './components/RequireMfa';
