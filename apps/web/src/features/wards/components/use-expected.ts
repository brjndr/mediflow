import { useState } from 'react';

/**
 * The version a save is made from: the one the form opened with. After a conflict it moves to
 * the newest version once that has arrived, so saving again is a decision made on what the other
 * person saved, and only what was changed in the form is sent.
 */
export function useExpectedVersion(opened: number, latest: number | undefined) {
  const [expected, setExpected] = useState(opened);
  const [conflicted, setConflicted] = useState(false);
  if (conflicted && latest !== undefined && latest !== expected) {
    setExpected(latest);
    setConflicted(false);
  }
  return { expected, conflict: () => setConflicted(true) };
}
