# Staff: module notes

What this module is and what was decided for it. The root `CLAUDE.md` holds the rules every module follows, and it wins where the two disagree. Keep this file current with the module.

## What exists

**Staff (web and API):** the list of active staff, deactivated staff and open invitations; inviting one person by email into a role, or several from a CSV file read in the browser (up to 200, checked row by row before anything is sent); deactivating with a question first, reactivating, signing someone out everywhere and sending an invitation again and withdrawing one, with the `staff:read`, `staff:invite` and `staff:manage` permissions (#59, and the API in #61). The web screen is behind the `staff` switch; the API is always on. Nobody acts on, or invites into, a role that holds more than their own. Changing a role belongs with role management.
