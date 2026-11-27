# Offboarding export: nobody can receive it

For operators. An offboarding hospital's export is every record it has, so its download link goes only to an **active member with an active account, not a platform admin, whose one role holds both `role:manage` and `patient:read` at scope `all`**. When nobody matches, the offboard question on the hospital's page warns, and "Email a download link" answers `export_has_no_recipient`.

Nothing is lost meanwhile: the export is still made and kept, and nothing is deleted by itself (a deletion needs a downloaded export or a waiver reference). The application has no repair for this on purpose: nobody can grant a permission they do not hold.

Running SQL against a deployed database (who holds the login, how to reach it) is **Waiting for #146**.

## Before offboarding (the warning)

Cancel the offboarding and ask the hospital to give one active member a role holding both permissions (its admin does this under Roles and Staff). If the hospital is suspended, its people cannot do that until it is reactivated. If the hospital cannot, offboard it and follow the steps below.

## 1. Get the request in writing

- A written request from the person the contract names as the hospital's authority, through a contact already on file, never only from the address that is to receive the export.
- It names **one staff member** (their sign-in email) who is to receive every record of the hospital.
- Open an issue or ticket with the hospital's id, the user's id and the request's reference number. No names, addresses or patient facts.
- A second platform operator checks the request and the chosen change before it is made.

If the hospital does not want the export, change no access: ask for its signed waiver and give the reference number in the deletion request.

## 2. Is there a way inside the application?

If the hospital has **no active manager at all** (no active member holds `role:manage` or `staff:manage`) and its `admin` role still holds both permissions: with the hospital's agreement, reactivate it, invite the named person as first admin, wait for them to accept, then offboard again. Reactivating reopens the hospital to its staff, cancels any deletion request and starts new dates and a new export. Otherwise go on.

## 3. Find out what is missing

The hospital must be **offboarding** before anything is changed by hand: it is closed, so the access you add serves only the export link. Never run these changes on an active or suspended hospital.

Connect with the owner login used for migrations (it must bypass row-level security, or every query below returns nothing) in `psql`:

```sql
\set ON_ERROR_STOP on
\set hospital '<hospital id>'
select status from tenants where id = :'hospital';  -- must be offboarding

-- The member the hospital named. Type the address at the prompt.
\prompt 'Sign-in email: ' email
select id as member, status as account, is_platform_admin
from users where email = lower(:'email') \gset
\echo :member :account :is_platform_admin

-- Their membership and role there.
select role_id as role, status as membership from memberships
where tenant_id = :'hospital' and user_id = :'member' \gset
\echo :role :membership

-- What their role holds of the two now: the state to go back to.
select permission, scope from role_permissions
where tenant_id = :'hospital' and role_id = :'role'
  and permission in ('role:manage', 'patient:read');

-- The roles that hold both permissions at scope all.
select role_id from role_permissions
where tenant_id = :'hospital' and scope = 'all' and permission in ('role:manage', 'patient:read')
group by role_id having count(*) = 2;

-- How many members each role has (a grant to a role reaches all of them).
select role_id, status, count(*) from memberships
where tenant_id = :'hospital' group by role_id, status order by role_id, status;
```

Write the results into the ticket (ids, role ids, permissions, scopes and statuses only), so the change can be undone.

Stop if the user is a platform admin, or has no membership of this hospital: neither is repaired here. A person who never joined the hospital is not added by hand.

## 4. Make the smallest change that works

Take **every** line that applies; a member may need two or three changes.

| What is wrong                                                               | Change  |
| --------------------------------------------------------------------------- | ------- |
| Their role lacks the permissions, another role holds both, hospital agrees  | B       |
| Their role lacks the permissions and B does not apply                       | C       |
| Their membership is `suspended` (also after B or C)                         | A       |
| Their **account** is `disabled` (also with any of the above; read the note) | Account |

An account is one for all hospitals, so enabling it opens every hospital the person belongs to. Find out why it was disabled and prefer another member. Enable it only if the hospital insists and the reason no longer holds.

Open a transaction, then run the changes that apply:

```sql
begin;
```

```sql
-- A: restore the membership.
update memberships set status = 'active', updated_at = now()
where tenant_id = :'hospital' and user_id = :'member';
```

```sql
-- B: move the member into a role that holds both.
update memberships set role_id = '<role id>', updated_at = now()
where tenant_id = :'hospital' and user_id = :'member';
```

```sql
-- C: grant both to the member's own role. Every member of that role gets them, so prefer a
-- member whose role has the fewest members.
insert into role_permissions (tenant_id, role_id, permission, scope)
values (:'hospital', :'role', 'role:manage', 'all'), (:'hospital', :'role', 'patient:read', 'all')
on conflict (tenant_id, role_id, permission) do update set scope = 'all';
```

```sql
-- Account.
update users set status = 'active', updated_at = now() where id = :'member';
```

## 5. Record it, check it, then commit

In the same transaction. Both trails are append-only. The actor is the operator's own platform admin user id. `changes` lists what ran; `before` is what step 3 showed (role, membership, account and the role's two grants), in ids and codes.

```sql
\set operator '<your user id>'
\set request '<ticket or request reference>'
\set changes '<A, B, C, account>'
\set before '<role, statuses, scopes>'

insert into platform_audit_log (actor_id, action, entity, entity_id, hospital_id, detail)
values (:'operator', 'hospital.access_repaired', 'membership_user', :'member', :'hospital',
        jsonb_build_object('changes', :'changes', 'before', :'before', 'reference', :'request'));
insert into audit_log (tenant_id, actor_id, action, entity, entity_id)
values (:'hospital', :'operator', 'access_repaired', 'membership_user', :'member');
-- With C, the role's access changed too.
insert into audit_log (tenant_id, actor_id, action, entity, entity_id)
select :'hospital', :'operator', 'access_repaired', 'role', :'role'
where position('C' in :'changes') > 0;

-- The named member, not just anybody: must answer t.
select count(*) = 1 as named_member_may_receive
from memberships m join users u on u.id = m.user_id
where m.tenant_id = :'hospital' and m.user_id = :'member' and m.status = 'active'
  and u.status = 'active' and not u.is_platform_admin
  and (select count(*) from role_permissions p
       where p.tenant_id = m.tenant_id and p.role_id = m.role_id and p.scope = 'all'
         and p.permission in ('role:manage', 'patient:read')) = 2;
```

Read the answer. Only if it is `t`, type `commit;`. Otherwise type `rollback;` and go back to step 3.

## 6. Send the export, undo, close

1. On the hospital's page, under Exports, "Email a download link" with the member's user id.
2. Check the platform trail shows `hospital.export_downloaded` by that user.
3. **Undo the change** once the export is downloaded, or when the link has expired (7 days) and the hospital has not asked for another. Undo it too before any reactivation, unless the hospital asks in writing to keep it. The link checks the access again when used, so never undo before the download you expect. Undo only what you changed, back to the noted state, in one transaction with the records of step 5 (`changes` = `undo`):

```sql
-- C: remove a grant that was not there before; restore the scope of one that was.
delete from role_permissions
where tenant_id = :'hospital' and role_id = :'role' and permission = '<permission you added>';
update role_permissions set scope = '<earlier scope>'
where tenant_id = :'hospital' and role_id = :'role' and permission = '<permission you widened>';
-- B: update memberships set role_id = '<earlier role id>' ...; A: set status = 'suspended';
-- Account: update users set status = 'disabled' ...
```

4. Close the ticket with what was changed and undone, by whom, who checked it and when.
