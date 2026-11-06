import type { Allergy } from '@/features/triage';
import type { Order } from './types';

/**
 * The checks made as a prescription is written (#81): a medicine whose name matches an allergy
 * the patient has listed, and one already prescribed, in this prescription or another of the
 * encounter still in effect. They warn and ask once; they never refuse, as the doctor may know
 * better (a desensitised patient, a taper written as two lines).
 *
 * An allergy chosen from the allergen catalog (#380) carries `members`, the generic names it
 * covers (a drug class's members, or the one generic name of a medicine): it matches a medicine
 * when a word of the medicine's generic name or brand begins with a member, so "Penicillins"
 * matches amoxicillin. A food or other catalog entry covers no medicine. Free text is matched by
 * the words of names only: a substance word of four letters or more that begins a word of the
 * medicine's generic name or brand ("amoxicillin", "sulfa" in "sulfamethoxazole"); it knows no
 * drug classes.
 */

export interface LineToCheck {
  drugId: string;
  /** The generic name, or for a line carried over from a prescription its name as ordered. */
  genericName: string;
  brandName: string;
}

export interface LineWarnings {
  /** The allergies, as recorded, that the medicine's name matches. */
  allergies: string[];
  /** Another line of this prescription is the same medicine or generic name. */
  repeated: boolean;
  /** The names, as ordered, of lines of the encounter still in effect for the same medicine. */
  prescribed: string[];
}

const MIN_WORD = 4;

const words = (text: string) =>
  text
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** What matching needs of a recorded allergy. */
export interface AllergyLike {
  substance: string;
  /** Present when the allergy names a catalog entry or a medicine. */
  kind?: string | undefined;
  /** The generic names it covers, lower case. */
  members?: string[] | undefined;
}

const padded = (text: string) =>
  ` ${text
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}-]+/gu, ' ')
    .trim()}`;

/**
 * Whether a recorded allergy covers a medicine of these names: by the members of a coded
 * allergy, else by the words of the substance.
 */
export function allergyCovers(allergy: AllergyLike, names: string[]): boolean {
  if (allergy.kind === undefined) return matchesAllergy(allergy.substance, names);
  const haystacks = names.map(padded);
  return (allergy.members ?? []).some((member) => {
    const wanted = padded(member);
    return wanted.trim() !== '' && haystacks.some((each) => each.includes(wanted));
  });
}

/** Whether a substance the patient is allergic to is named in the medicine's names. */
export function matchesAllergy(substance: string, names: string[]): boolean {
  const named = names.flatMap(words).filter((word) => /\p{L}/u.test(word));
  return words(substance)
    .filter((word) => word.length >= MIN_WORD && /^\p{L}+$/u.test(word))
    .some((word) => named.some((each) => each.startsWith(word)));
}

/** Whether two names are of one generic: the same, or one is the other with more after it. */
export function sameGeneric(a: string, b: string): boolean {
  const left = a.trim().toLocaleLowerCase();
  const right = b.trim().toLocaleLowerCase();
  if (left === '' || right === '') return false;
  return left === right || left.startsWith(`${right} `) || right.startsWith(`${left} `);
}

const isSame = (line: LineToCheck, other: LineToCheck) =>
  line.drugId === other.drugId || sameGeneric(line.genericName, other.genericName);

/**
 * The warnings of each line. `standing` are the encounter's medication orders still in effect
 * (not cancelled, and not about to be cancelled by the revision being written).
 */
export function checkLines(
  lines: LineToCheck[],
  allergies: Allergy[],
  standing: Order[],
): LineWarnings[] {
  return lines.map((line, index) => {
    if (line.drugId === '') return { allergies: [], repeated: false, prescribed: [] };
    const names = [line.genericName, line.brandName].filter(Boolean);
    return {
      allergies: allergies
        .filter((allergy) => allergyCovers(allergy, names))
        .map((allergy) => allergy.substance),
      repeated: lines.some(
        (other, at) => at !== index && other.drugId !== '' && isSame(line, other),
      ),
      prescribed: standing
        .filter((order) =>
          isSame(line, {
            drugId: order.drugId ?? '',
            genericName: order.itemName ?? '',
            brandName: '',
          }),
        )
        .map((order) => order.itemName ?? ''),
    };
  });
}

export const hasWarnings = (warnings: LineWarnings) =>
  warnings.allergies.length > 0 || warnings.repeated || warnings.prescribed.length > 0;
