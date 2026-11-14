interface Parsed {
  abo: 'A' | 'B' | 'AB' | 'O';
  positive: boolean;
}

function parse(group: string): Parsed {
  return {
    abo: group.slice(0, -1) as Parsed['abo'],
    positive: group.endsWith('+'),
  };
}

/** Which recipient ABO groups a donor ABO group may give red cells to. */
const RED_CELLS_TO: Record<Parsed['abo'], readonly Parsed['abo'][]> = {
  O: ['O', 'A', 'B', 'AB'],
  A: ['A', 'AB'],
  B: ['B', 'AB'],
  AB: ['AB'],
};

/**
 * Whether a unit of `unitGroup` and `component` may be given to a patient of `patientGroup`.
 *
 * Red cells and whole blood follow the red cell rule: the donor's cells must not carry an antigen
 * the patient lacks, and Rh negative patients get Rh negative cells. Plasma, platelets and
 * cryoprecipitate follow the plasma rule, the red cell rule turned around (the donor's plasma must
 * not carry an antibody against the patient's cells), and Rh is not looked at. A cross-match is
 * still made: this only refuses what can never be compatible.
 */
export function isCompatible(unitGroup: string, patientGroup: string, component: string): boolean {
  const unit = parse(unitGroup);
  const patient = parse(patientGroup);
  if (component === 'red_cells' || component === 'whole_blood') {
    if (!RED_CELLS_TO[unit.abo].includes(patient.abo)) return false;
    return !unit.positive || patient.positive;
  }
  return RED_CELLS_TO[patient.abo].includes(unit.abo);
}
