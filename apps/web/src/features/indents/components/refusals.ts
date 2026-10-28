/** Refusals of an indent's steps, in words of their own. */
export const INDENT_REFUSED: Record<string, string> = {
  conflict: 'refused.conflict',
  indent_decided: 'refused.decided',
  indent_not_open: 'refused.notOpen',
  own_indent: 'refused.own',
  not_requester: 'refused.notRequester',
  indent_not_found: 'refused.gone',
  over_issue: 'refused.overIssue',
  insufficient_stock: 'refused.insufficient',
  batch_expired: 'refused.expired',
  unknown_location: 'refused.place',
  unknown_batch: 'refused.batch',
  validation_failed: 'refused.invalid',
};
