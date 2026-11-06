/**
 * Checks an uploaded file for malware, behind an interface so a real engine (ClamAV over its
 * socket, a cloud scanning service) replaces the built-in check as a configuration change.
 */
export interface MalwareScanner {
  /** `clean`, or the name of what was found (a code: letters, digits and `. _ : -`). */
  scan(data: Buffer): Promise<{ clean: true } | { clean: false; signature: string }>;
}

/** The industry's harmless test file, which every engine reports (eicar.org). */
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/**
 * Finds only the EICAR test file. It stands in until an engine is connected, so the whole path
 * (hold, scan, block) is exercised; it is not protection by itself.
 */
export class TestSignatureScanner implements MalwareScanner {
  async scan(data: Buffer) {
    return data.includes(EICAR)
      ? { clean: false as const, signature: 'Eicar-Test-Signature' }
      : { clean: true as const };
  }
}
