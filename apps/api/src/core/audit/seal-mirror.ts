import {
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type ServerSideEncryption,
} from '@aws-sdk/client-s3';

/**
 * Write-once copies of the audit seals (#1092). The seals in the database let someone with the
 * whole database remove a tail of a chain, change the rows and have the job seal them again; a
 * copy in a bucket the database owner cannot rewrite exposes that, because `audit.seal-verify`
 * compares the two.
 *
 * Each copy is one object whose key says everything the comparison needs, so verifying lists keys
 * and reads no bodies: `seals/<hospital id>/<xid_from>-<xid_to>-<seal hex>` (the platform chain
 * is under the nil id). The body repeats it with the row count and the seal before, for a person.
 */

export interface MirroredSeal {
  tenantId: string;
  xidFrom: string;
  xidTo: string;
  seal: string;
  prevSeal: string | null;
  rowCount: number;
}

/** What a listing says about a copy. */
export type MirrorEntry = Pick<MirroredSeal, 'xidFrom' | 'xidTo' | 'seal'>;

export interface SealMirror {
  /** Writes a copy that cannot be changed or removed until its retention ends. */
  put(seal: MirroredSeal): Promise<void>;
  /** Every copy of one chain. */
  list(tenantId: string): Promise<MirrorEntry[]>;
  /** The hospitals (and the platform) that have copies. */
  tenants(): Promise<string[]>;
}

const PAD = 20;
const PREFIX = 'seals/';

export const sealKeyOf = (seal: Pick<MirroredSeal, 'tenantId' | 'xidFrom' | 'xidTo' | 'seal'>) =>
  `${PREFIX}${seal.tenantId}/${seal.xidFrom.padStart(PAD, '0')}-${seal.xidTo.padStart(PAD, '0')}-${seal.seal}`;

const KEY = new RegExp(`^${PREFIX}[0-9a-f-]{36}/(\\d{${PAD}})-(\\d{${PAD}})-([0-9a-f]{64})$`);

function entryOf(key: string): MirrorEntry | null {
  const found = KEY.exec(key);
  if (!found) return null;
  return {
    xidFrom: found[1]!.replace(/^0+(?=\d)/, ''),
    xidTo: found[2]!.replace(/^0+(?=\d)/, ''),
    seal: found[3]!,
  };
}

/** Kept in memory, for tests. */
export class MemorySealMirror implements SealMirror {
  readonly objects = new Map<string, MirroredSeal>();
  failNext = false;

  async put(seal: MirroredSeal): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('mirror_unavailable');
    }
    this.objects.set(sealKeyOf(seal), seal);
  }

  async list(tenantId: string): Promise<MirrorEntry[]> {
    return [...this.objects.entries()]
      .filter(([, seal]) => seal.tenantId === tenantId)
      .map(([key]) => entryOf(key)!);
  }

  async tenants(): Promise<string[]> {
    return [...new Set([...this.objects.values()].map((seal) => seal.tenantId))];
  }
}

export interface S3SealMirrorOptions {
  /** A bucket created with Object Lock enabled. */
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  serverSideEncryption?: ServerSideEncryption;
  /** How long a copy is locked, in months, in compliance mode (nobody can shorten or lift it). */
  retentionMonths: number;
}

/** Copies in an S3 bucket with Object Lock, each locked in compliance mode. */
export class S3SealMirror implements SealMirror {
  private readonly client: S3Client;

  constructor(
    private readonly options: S3SealMirrorOptions,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.client = new S3Client({
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: options.endpoint !== undefined,
      credentials:
        options.accessKeyId && options.secretAccessKey
          ? { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey }
          : undefined,
    });
  }

  async put(seal: MirroredSeal): Promise<void> {
    const until = this.now();
    until.setUTCMonth(until.getUTCMonth() + this.options.retentionMonths);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: sealKeyOf(seal),
        Body: JSON.stringify({
          tenantId: seal.tenantId,
          xidFrom: seal.xidFrom,
          xidTo: seal.xidTo,
          rowCount: seal.rowCount,
          seal: seal.seal,
          prevSeal: seal.prevSeal,
        }),
        ContentType: 'application/json',
        ServerSideEncryption: this.options.serverSideEncryption,
        ObjectLockMode: 'COMPLIANCE',
        ObjectLockRetainUntilDate: until,
      }),
    );
  }

  async list(tenantId: string): Promise<MirrorEntry[]> {
    const found: MirrorEntry[] = [];
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.options.bucket,
          Prefix: `${PREFIX}${tenantId}/`,
          ContinuationToken: token,
        }),
      );
      for (const object of page.Contents ?? []) {
        const entry = object.Key ? entryOf(object.Key) : null;
        if (entry) found.push(entry);
      }
      token = page.NextContinuationToken;
    } while (token);
    return found;
  }

  async tenants(): Promise<string[]> {
    const found: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.options.bucket,
          Prefix: PREFIX,
          Delimiter: '/',
          ContinuationToken: token,
        }),
      );
      for (const prefix of page.CommonPrefixes ?? []) {
        const id = prefix.Prefix?.slice(PREFIX.length, -1);
        if (id) found.push(id);
      }
      token = page.NextContinuationToken;
    } while (token);
    return found;
  }
}

/**
 * Copies seals just written. A failure on one does not stop the others; the seals whose copy
 * failed are returned so the job can say so (`audit.seal-verify` reports a seal with no copy as
 * `mirror_missing` once the copy is overdue).
 */
export async function copySeals(
  mirror: SealMirror,
  seals: readonly MirroredSeal[],
): Promise<MirroredSeal[]> {
  const failed: MirroredSeal[] = [];
  for (const seal of seals) {
    try {
      await mirror.put(seal);
    } catch {
      failed.push(seal);
    }
  }
  return failed;
}
