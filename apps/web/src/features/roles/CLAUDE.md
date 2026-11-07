# Roles (web): module notes

The root `CLAUDE.md` holds the rules every module follows. The API side is `apps/api/src/features/roles/CLAUDE.md`.

## What exists

**The role list (RP-01, #133):** `/roles` lists the hospital's roles (built-in first, with the number of permissions and active members), adds a custom role by name, renames one and deletes one after a confirmation. Behind the `roles` switch and `role:read` (see) and `role:manage` (change). Desktop only (`DesktopOnly`).

**The permission matrix (RP-02, #134):** `/roles/:roleId`, opened from the `Permissions` row action. Every permission of `GET /permission-catalog` grouped by module, a checkbox each, and a scope list beside a held one only where the catalog gives more than `all` (`scopes`). Saved with `PUT /roles/{roleId}` (the whole set). Desktop only.

## Decided

- **The `roles` switch is a web switch only.** The roles API has no module flag (like staff), so a hospital sees the screen when the platform turns `roles` on; the API answers to the permissions alone.
- **Built-in roles are shown and protected:** Rename and Delete stay on the row but are `aria-disabled`. The server is the source of truth (409 `built_in_role`).
- **A new role starts with no permissions.** `POST /roles` needs the list, and the form sends an empty one. What a role may do is the permission matrix.
- **Server refusals** (`role_exists`, `built_in_role`, `role_in_use`, `role_not_allowed`, `role_not_found`) are mapped to messages in `RolesPage`. A role with members or invitations cannot be deleted; the list only shows active members, so the server may refuse a role that shows 0.
- **The invite form reads the roles from `GET /staff/roles`** (staff module, filtered to roles the inviter may give). Every change here invalidates that query through `invalidateStaffRoles`, exported from the staff module's `index.ts`, so a new custom role shows in the invite form at once.
- Roles are a short list, so it is not paged; the grid has no cursor.

### Matrix decisions (#134)

- **The server is the source of truth; the UI only avoids the obvious refusals.** Disabled (`aria-disabled`, still focusable, the reason as its description): a permission the caller does not hold, `role:manage` on the caller's own role, and everything when the role holds more than the caller or the caller lacks `role:manage`. Scopes offered never exceed the caller's own. `last_admin` cannot be known by the client (it depends on who holds what) and is shown from the 409.
- **No version on a role.** The API has no `version` or `If-Match` for `PUT /roles`. The editor works from a snapshot (`base`) with the edit over it (`draft`). Just before saving it reads the role again; when the grants differ from the snapshot nothing is sent: their change is taken, the permissions this person changed keep their value, one both changed shows "Saved by someone else: ...", and a second Save sends. A small window remains between that read and the PUT (last write wins); a server-side `expectedVersion` is a proposed follow-up.
- **Catalog scopes:** `PermissionDefinition.scopes` (API) lists the narrower scopes a permission's routes honour; only the appointment permissions declare them so far. The server does not refuse a scope the catalog does not list.
- **After every save the caller's policy is read again** (`useSaveGrants`), so editing one's own role shows at once; other open tabs follow at the policy refresh.
- Module headings are the feature id made readable; permission texts are the API's English descriptions.
