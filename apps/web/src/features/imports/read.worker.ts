import { parseCsv } from '@/shared/utils/csv';

// Reads a file's text off the page's thread, so a file of twenty thousand rows does not freeze
// the screen. It is given the text and answers the rows; it keeps nothing.
self.onmessage = (event: MessageEvent<string>) => {
  self.postMessage(parseCsv(event.data));
};
