import { z } from 'zod';
import { toMinor } from '@/features/services';
import { api, requireData } from '@/shared/api';
import { PLAIN_TEXT } from '@/shared/utils/text';
import { documentNames } from './coverage-schemas';
import type {
  ClaimAction,
  ClaimActionKind,
  ClaimAging,
  ClaimCreate,
  ClaimDetail,
  ClaimPage,
  ClaimStatus,
} from './types';

// Claims (IN-04, #184): a claim is prepared for a visit from its saved split, sent to the payer,
// answered, and paid or written off. The server owns the state machine and says in `allowedActions`
// what can be done now; the screen offers those and nothing else.

export const CLAIM_PAGE_SIZE = 25;

export const CLAIM_STATUSES = [
  'draft',
  'submitted',
  'query',
  'approved',
  'rejected',
  'settled',
  'written_off',
  'cancelled',
] as const satisfies readonly ClaimStatus[];

export const CLAIM_ACTIONS = [
  'submit',
  'raise_query',
  'reply',
  'approve',
  'reject',
  'settle',
  'write_off',
  'cancel',
] as const satisfies readonly ClaimActionKind[];

/** The permission each action needs, besides `claim:read`. */
export function actionPermission(action: ClaimActionKind): 'claim:manage' | 'claim:writeoff' {
  return action === 'write_off' ? 'claim:writeoff' : 'claim:manage';
}

const minor = z.number().int().min(0);
const claimShape = {
  id: z.string(),
  number: z.string(),
  patientId: z.string(),
  encounterId: z.string(),
  policyId: z.string(),
  payerId: z.string(),
  payerName: z.string(),
  policyNumber: z.string(),
  claimedMinor: minor,
  approvedMinor: minor.optional(),
  receivedMinor: minor,
  writtenOffMinor: minor,
  outstandingMinor: minor,
  status: z.enum(CLAIM_STATUSES),
  referenceNumber: z.string().optional(),
  openQuery: z.string().optional(),
  documents: z.array(z.string()),
  createdAt: z.string(),
  submittedAt: z.string().optional(),
  decidedAt: z.string().optional(),
  version: z.number().int().min(1),
};
const claimSchema = z.object(claimShape);
const detailSchema: z.ZodType<ClaimDetail> = z.object({
  ...claimShape,
  events: z.array(
    z.object({
      at: z.string(),
      action: z.enum(['create', ...CLAIM_ACTIONS]),
      toStatus: z.enum(CLAIM_STATUSES),
      amountMinor: minor.optional(),
      note: z.string().optional(),
    }),
  ),
  allowedActions: z.array(z.enum(CLAIM_ACTIONS)),
});
const pageSchema: z.ZodType<ClaimPage> = z.object({
  items: z.array(claimSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().min(0).optional(),
});
const buckets = z.array(minor).length(4);
const agingSchema: z.ZodType<ClaimAging> = z.object({
  asOf: z.string(),
  rows: z.array(
    z.object({
      payerId: z.string(),
      payerName: z.string(),
      claims: minor,
      buckets,
      outstandingMinor: minor,
    }),
  ),
  totals: z.object({ claims: minor, buckets, outstandingMinor: minor }),
});

export async function fetchClaims(
  { cursor, limit, status }: { cursor?: string; limit: number; status: ClaimStatus | '' },
  signal?: AbortSignal,
): Promise<ClaimPage> {
  const result = await api.GET('/claims', {
    params: { query: { cursor, limit, status: status || undefined } },
    signal,
  });
  return pageSchema.parse(requireData(result));
}

export async function fetchClaim(claimId: string, signal?: AbortSignal): Promise<ClaimDetail> {
  const result = await api.GET('/claims/{claimId}', { params: { path: { claimId } }, signal });
  return detailSchema.parse(requireData(result));
}

export async function fetchClaimAging(signal?: AbortSignal): Promise<ClaimAging> {
  const result = await api.GET('/claims/aging', { signal });
  return agingSchema.parse(requireData(result));
}

export async function createClaim(
  encounterId: string,
  body: ClaimCreate,
  key: string,
): Promise<ClaimDetail> {
  const result = await api.POST('/encounters/{encounterId}/claims', {
    params: { path: { encounterId }, header: { 'idempotency-key': key } },
    body,
  });
  return detailSchema.parse(requireData(result));
}

export async function actOnClaim(claimId: string, body: ClaimAction): Promise<ClaimDetail> {
  const result = await api.POST('/claims/{claimId}/actions', {
    params: { path: { claimId } },
    body,
  });
  return detailSchema.parse(requireData(result));
}

// Forms. A free-text field adds the plain-text rule the API refuses on; money is typed in the
// hospital's currency and read on its digits.

const plain = (max: number) =>
  z.string().trim().max(max).regex(PLAIN_TEXT, 'validation.plain_text');

const documentsField = z
  .string()
  .max(2200)
  .refine((value) => {
    const names = documentNames(value);
    return names.length <= 20 && names.every((n) => n.length <= 100 && PLAIN_TEXT.test(n));
  }, 'validation.invalid_format');

export const packetFormSchema = z.object({ documents: documentsField, note: plain(500) });
export type PacketFormValues = z.infer<typeof packetFormSchema>;

export function toClaimCreate(values: PacketFormValues): ClaimCreate {
  return {
    documents: documentNames(values.documents),
    ...(values.note ? { note: values.note } : {}),
  };
}

/** The fields an action asks for. The note is the question, the reply or the reason. */
export const ACTION_FIELDS: Record<
  ClaimActionKind,
  {
    note: 'none' | 'optional' | 'required';
    amount?: 'approved' | 'received';
    documents?: boolean;
    reference?: boolean;
  }
> = {
  submit: { note: 'none', reference: true },
  raise_query: { note: 'required' },
  reply: { note: 'required', documents: true },
  approve: { note: 'optional', amount: 'approved', reference: true },
  reject: { note: 'required', reference: true },
  settle: { note: 'optional', amount: 'received', reference: true },
  write_off: { note: 'required' },
  cancel: { note: 'optional' },
};

export const actionFormSchema = (digits: number, action: ClaimActionKind, limitMinor?: number) => {
  const fields = ACTION_FIELDS[action];
  return z
    .object({
      note: plain(500),
      amount: z.string().trim(),
      referenceNumber: plain(60),
      documents: documentsField,
    })
    .superRefine((values, context) => {
      if (fields.note === 'required' && values.note === '') {
        context.addIssue({ code: 'custom', path: ['note'], message: 'validation.required' });
      }
      if (fields.amount !== undefined) {
        const parsed = values.amount === '' ? null : toMinor(values.amount, digits);
        if (parsed === null) {
          context.addIssue({
            code: 'custom',
            path: ['amount'],
            message: values.amount === '' ? 'validation.required' : 'validation.invalid_format',
          });
        } else if (fields.amount === 'received' && parsed < 1) {
          context.addIssue({ code: 'custom', path: ['amount'], message: 'validation.required' });
        } else if (limitMinor !== undefined && parsed > limitMinor) {
          context.addIssue({
            code: 'custom',
            path: ['amount'],
            message:
              fields.amount === 'approved'
                ? 'insurance:claims.errors.overClaimed'
                : 'insurance:claims.errors.overApproved',
          });
        }
      }
    });
};
export type ActionFormValues = z.infer<ReturnType<typeof actionFormSchema>>;

export function toClaimAction(
  action: ClaimActionKind,
  values: ActionFormValues,
  digits: number,
  version: number,
): ClaimAction {
  const fields = ACTION_FIELDS[action];
  const minorAmount = values.amount === '' ? null : toMinor(values.amount, digits);
  const documents = documentNames(values.documents);
  return {
    version,
    action,
    ...(values.note ? { note: values.note } : {}),
    ...(fields.amount === 'approved' && minorAmount !== null ? { approvedMinor: minorAmount } : {}),
    ...(fields.amount === 'received' && minorAmount !== null ? { receivedMinor: minorAmount } : {}),
    ...(fields.reference && values.referenceNumber
      ? { referenceNumber: values.referenceNumber }
      : {}),
    ...(fields.documents && documents.length > 0 ? { documents } : {}),
  };
}
