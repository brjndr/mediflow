/**
 * The registry of a hospital's data (#960): every table that carries `tenant_id`, and what the
 * offboarding export does with it. `tenant-data.test.ts` reads the database and fails when a table
 * with `tenant_id` is in neither list, or a name here no longer exists, so a new tenant table
 * cannot ship without a decision about its export (and, in #961, its deletion).
 */

/** What the export does with a table that holds more than rows. */
export interface TableTreatment {
  /** Columns left out: credentials that are of no use to the hospital and unsafe to hand over. */
  omit?: string[];
  /** The column that names a file in the file store: the file goes into the archive as it is. */
  fileKey?: string;
}

/** Exported in full: every row and every column, as a CSV. */
export const EXPORTED_PLAIN: readonly string[] = [
  'account_event_settings',
  'admission_settings',
  'admissions',
  'allergy_list_versions',
  'allergy_lists',
  'ambulance_trip_crew',
  'ambulance_trips',
  'ambulances',
  'appointments',
  'audit_log',
  'bed_assignments',
  'bed_categories',
  'bed_reservations',
  'beds',
  'billing_settings',
  'blood_collections',
  'blood_crossmatches',
  'blood_donors',
  'blood_screenings',
  'blood_unit_events',
  'blood_unit_recalls',
  'blood_units',
  'care_plan_tasks',
  'care_plans',
  'cash_register_sessions',
  'certificate_counters',
  'certificate_formats',
  'charges',
  'claim_counters',
  'claim_receipts',
  'claim_events',
  'claims',
  'cleaning_tasks',
  'clinical_notes',
  'code_favourites',
  'consent_withdrawals',
  'consent_witnesses',
  'coverage_splits',
  'credit_accounts',
  'credit_bills',
  'credit_counters',
  'credit_notes',
  'credit_receipt_allocations',
  'credit_receipts',
  'departments',
  'deposit_applications',
  'deposit_refunds',
  'deposits',
  'diagnosis_codings',
  'discharge_clearances',
  'discharge_plans',
  'discharge_summaries',
  'discharge_summary_addenda',
  'dispense_lines',
  'dispense_return_lines',
  'dispense_returns',
  'dispenses',
  'doctor_favourite_drugs',
  'doctor_hours',
  'doctors',
  'document_legal_holds',
  'document_retention_rules',
  'drugs',
  'encounter_diagnoses',
  'encounters',
  'er_case_links',
  'er_counters',
  'er_encounters',
  'er_medico_legal',
  'er_notes',
  'follow_ups',
  'goods_receipt_lines',
  'goods_receipts',
  'imaging_report_addenda',
  'imaging_reports',
  'imaging_studies',
  'import_problems',
  'import_rows',
  'inventory_counters',
  'invoice_counters',
  'invoice_lines',
  'invoices',
  'lab_accession_counters',
  'lab_result_acknowledgements',
  'lab_results',
  'lab_samples',
  'lab_test_components',
  'lab_test_ranges',
  'lab_tests',
  'mar_entries',
  'memberships',
  'orders',
  'ot_anaesthesia',
  'ot_bookings',
  'ot_checklist_steps',
  'ot_consumable_returns',
  'ot_consumables',
  'ot_fitness',
  'ot_note_addenda',
  'ot_notes',
  'ot_recovery_notes',
  'ot_rooms',
  'package_items',
  'patient_blood_groups',
  'patient_certificates',
  'patient_consents',
  'patient_merges',
  'patient_mrn_counters',
  'patient_policies',
  'patient_settings',
  'patients',
  'payer_plan_services',
  'payer_plans',
  'payers',
  'payments',
  'pharmacy_sale_lines',
  'pharmacy_sale_return_lines',
  'pharmacy_sale_returns',
  'pharmacy_sales',
  'pre_auths',
  'prescription_set_lines',
  'prescription_sets',
  'prescriptions',
  'price_lists',
  'progress_note_versions',
  'progress_notes',
  'purchase_order_lines',
  'purchase_orders',
  'purchase_return_lines',
  'purchase_returns',
  'purchasing_counters',
  'queue_counters',
  'queue_tokens',
  'rate_agreement_rates',
  'rate_agreements',
  'record_assignments',
  'record_correction_requests',
  'record_requests',
  'referrals',
  'report_settings',
  'role_default_grants',
  'role_permissions',
  'roles',
  'rooms',
  'roster_leave_allowances',
  'roster_leaves',
  'roster_settings',
  'roster_shift_templates',
  'roster_shifts',
  'service_prices',
  'services',
  'stay_bill_estimates',
  'stock_adjustments',
  'stock_balances',
  'stock_batches',
  'stock_expiry_notices',
  'stock_indent_lines',
  'stock_indents',
  'stock_issue_lines',
  'stock_issues',
  'stock_ledger',
  'stock_locations',
  'suppliers',
  'tax_rates',
  'template_versions',
  'templates',
  'tenant_features',
  'transfusion_reaction_updates',
  'transfusion_reactions',
  'vital_ranges',
  'vitals',
  'ward_fluids',
  'ward_stock_requests',
  'ward_vitals',
  'wards',
];

/** Exported with a treatment. */
export const EXPORTED_SPECIAL: Readonly<Record<string, TableTreatment>> = {
  // A pending invite's hash only matches a link that has been withdrawn with the hospital.
  invites: { omit: ['token_hash'] },
  import_batches: { omit: ['claim_token'] },
  // Stored files, each put in the archive beside the table that names it.
  report_runs: { fileKey: 'file_key' },
  imaging_images: { fileKey: 'file_key' },
  patient_documents: { fileKey: 'file_key' },
};

/** Not exported, with the reason: nothing here is the hospital's record. */
export const NOT_EXPORTED: Readonly<Record<string, string>> = {
  outbox: 'The queue of events to send; the app role cannot read it and it holds no record.',
  idempotency_keys: 'Request keys kept for a day, with hashes of requests.',
};

/** Every table the export reads, in the order it writes them. */
export const exportedTables = (): string[] =>
  [...EXPORTED_PLAIN, ...Object.keys(EXPORTED_SPECIAL)].sort();

export const treatmentOf = (table: string): TableTreatment => EXPORTED_SPECIAL[table] ?? {};

/** Every table the deletion removes rows from: the exported ones and those that are not. */
export const deletedTables = (): string[] =>
  [...exportedTables(), ...Object.keys(NOT_EXPORTED)].sort();

/**
 * The tables in the order to delete them (#961): a table after every table that has a foreign key
 * to it, so a child goes before its parent. Read from the catalog, so a new reference is followed
 * without a list to keep. A cycle (none today) leaves its tables at the end in name order, which
 * the deletion tolerates because it turns constraint triggers off for its own transaction.
 */
export function deletionOrder(
  tables: readonly string[],
  references: readonly { child: string; parent: string }[],
): string[] {
  const set = new Set(tables);
  const childrenLeft = new Map<string, Set<string>>(tables.map((t) => [t, new Set<string>()]));
  for (const { child, parent } of references) {
    if (child !== parent && set.has(child) && set.has(parent)) childrenLeft.get(parent)?.add(child);
  }
  const order: string[] = [];
  const remaining = new Set([...tables].sort());
  for (;;) {
    const ready = [...remaining].filter((t) => (childrenLeft.get(t)?.size ?? 0) === 0);
    if (ready.length === 0) break;
    for (const table of ready) {
      order.push(table);
      remaining.delete(table);
      for (const set of childrenLeft.values()) set.delete(table);
    }
  }
  return [...order, ...remaining];
}
