# Staff: module notes

What this module is and what was decided for it. The root `CLAUDE.md` holds the rules every module follows, and it wins where the two disagree. Keep this file current with the module.

## What exists

**Staff (web and API):** the list of active staff, deactivated staff and open invitations; inviting one person by email into a role, or several from a CSV file read in the browser (up to 200, checked row by row before anything is sent); deactivating with a question first, reactivating, signing someone out everywhere and sending an invitation again and withdrawing one, with the `staff:read`, `staff:invite` and `staff:manage` permissions (#59, and the API in #61). The web screen is behind the `staff` switch; the API is always on. Nobody acts on, or invites into, a role that holds more than their own. Changing a role belongs with role management.

**Email status of an invitation (#349):** the invited view has an Email status column (Sent, Being sent, Could not be sent: a word first, an icon beside it) that is also a card line on a phone. A failed one is also announced in a status region that is always on the page. Send again calls `POST /invites/{inviteId}/resend` through `useResendInvite` with an Idempotency-Key made per press, and refreshes the lists; it replaced re-posting the invitation, which sent no status and replaced the invite. The mock gives the sample hospital three invitations, one of each status.

**Staff search (#594):** `StaffSearch` (on `ServerSearch`, exported) finds an active member by name or email through `useStaffSearch`, for pickers in other features (the duty roster). `useStaffOptions` (first 100) remains for the housekeeping assignee, which still has the 100 limit: proposed follow-up.
