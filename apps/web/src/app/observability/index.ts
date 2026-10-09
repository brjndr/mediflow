// Kept small on purpose: this is imported by error boundaries in the initial bundle. The SDK and
// the web-vitals library are loaded on demand by the start functions, from main.tsx.
export { reportError } from './error-reporting';
