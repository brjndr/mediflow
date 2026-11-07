# Roles (web): module notes

The root `CLAUDE.md` holds the rules every module follows. The API side is `apps/api/src/features/roles/CLAUDE.md`.

## What exists

**The role list (RP-01, #133):** `/roles` lists the hospital's roles (built-in first, with the number of permissions and active members), adds a custom role by name, renames one and deletes one after a confirmation. Behind the `roles` switch and `role:read` (see) and `role:manage` (change). Desktop only (`DesktopOnly`).

## Decided

- **The `roles` switch is a web switch only.** The roles API has no module flag (like staff), so a hospital sees the screen when the platform turns `roles` on; the API answers to the permissions alone.
- **Built-in roles are shown and protected:** Rename and Delete stay on the row but are `aria-disabled`. The server is the source of truth (409 `built_in_role`).
- **A new role starts with no permissions.** `POST /roles` needs the list, and the form sends an empty one. What a role may do is the permission matrix (#134), which uses `GET /permission-catalog` and `PUT /roles/{roleId}`; neither is used here.
- **Server refusals** (`role_exists`, `built_in_role`, `role_in_use`, `role_not_allowed`, `role_not_found`) are mapped to messages in `RolesPage`. A role with members or invitations cannot be deleted; the list only shows active members, so the server may refuse a role that shows 0.
- **The invite form reads the roles from `GET /staff/roles`** (staff module, filtered to roles the inviter may give). Every change here invalidates that query through `invalidateStaffRoles`, exported from the staff module's `index.ts`, so a new custom role shows in the invite form at once.
- Roles are a short list, so it is not paged; the grid has no cursor.
