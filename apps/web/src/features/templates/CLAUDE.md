# Document templates: module notes

What this module is and what was decided for it. The root `CLAUDE.md` holds the rules every module follows, and it wins where the two disagree. Keep this file current with the module.

## What exists

**Document templates (web and API):** each hospital's own texts for a prescription, a clinical note, a consent form and a discharge summary, written in the rich text editor, with placeholders (`{{patient.name}}`) put in from a list, a preview with made-up values, and versions (#67, and the API in #303). Behind the `templates` switch and the `template:read`, `template:manage` and `template:redact` permissions. Desktop-only. Decided for now: versions are append-only, so every save of a changed name or text is a new version, nothing saved is changed or removed, and a document made from a template will record the version it used; because of that a conflict loses nothing (the other person's version stays in the history) and saving again makes yours the newest; each kind of template knows a fixed list of placeholders, and one it does not know is refused by the screen and the server (`features/templates/placeholders.ts`, which the mock shares); a placeholder sits in one run of text; a value is filled in as text, never markup; a template is a blank form and holds no patient data, which a hint under the fields says, and what is typed there by mistake is removed by a redaction (below); an archived template takes no new version until it is restored; the kind never changes, and a name is one template of its kind. The clinical modules fill a template with `fillPlaceholders` from `@/features/templates` and check the result with `placeholdersIn` before a document is final: a placeholder with no value is left as written, to be seen. The shared rich text editor gained `insertable`, a list of fixed texts to put in at the cursor.

## Redaction (#292, decided on 2026-10-13)

The one change ever made to a saved version. Someone with `template:redact` (the hospital admin by default; it is not part of `template:manage`) removes the name and the text of one older version, from the version history. The version stays in the list, marked, with who saved it and when, and who redacted it, when and why. It cannot be undone, and the screen says so before it asks.

- **The reason is chosen from a list** (a patient's details, someone's personal details, something confidential, another reason), never typed: a typed reason could repeat what is being removed. This was Claude's choice within the decision; the decision itself said only "why" is kept.
- **The newest version is not redacted.** It is the template as it is used: a corrected version is saved first (an archived template is restored to do that), and the one before it is then redacted. The button is disabled for the newest version and for one already redacted.
- **What the browser read of a version is dropped when one is redacted,** at once, not at the next refresh.
- **A document made from the version keeps its own text.** That is the clinical module's copy (M7), and removing it is that module's question.
- **Reading a version is not audited.** A template is meant to hold no patient data. The redaction is.

## The API

Described in `apps/api/CLAUDE.md`, under Document templates. Where it differs from the mock: a `kind` sent with a save is not read (the mock used to refuse it, and no longer does); whoever changes a template needs `template:read` as well; a template has at most 500 versions; the name is tidied (runs of spaces made one) and may hold no control characters; and a repeat of `POST /templates` with the same key is answered with the template as it is then, not as it was.
