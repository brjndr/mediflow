import { ESLint } from 'eslint';

/**
 * Guards the rule itself: comparing role names must fail `pnpm lint`, so access can only be
 * decided through permissions. If this test fails, the lint rule was removed or weakened.
 */
// Tests run from apps/web. ESLint finds the root eslint.config.js by walking up from the file.
const eslint = new ESLint();

async function roleErrors(code: string): Promise<number> {
  const [result] = await eslint.lintText(code, {
    filePath: 'src/features/sample/Sample.tsx',
  });
  return (result?.messages ?? []).filter(
    (message) =>
      message.ruleId === 'no-restricted-syntax' && message.message.includes('role names'),
  ).length;
}

describe('role-name comparisons are a lint error', () => {
  it.each([
    ["export const a = (user: { role: string }) => user.role === 'doctor';"],
    ["export const b = (m: { roleId: string }) => m.roleId !== 'admin';"],
    ["export const c = (roleId: string) => 'nurse' == roleId;"],
    [
      "const BuiltInRoles = { Admin: 'admin' };\nexport const d = (x: string) => x === BuiltInRoles.Admin;",
    ],
    [
      "export function e(policy: { roleId: string }) {\n  switch (policy.roleId) {\n    case 'doctor':\n      return 1;\n    default:\n      return 0;\n  }\n}",
    ],
  ])(
    'flags %s',
    async (code) => {
      expect(await roleErrors(code)).toBeGreaterThan(0);
    },
    60_000,
  );

  it('allows permission checks and using a role id as data', async () => {
    const code = [
      "import { usePermission } from '@/access';",
      'export function useCanRefund() {',
      "  return usePermission('billing:refund');",
      '}',
      'export const label = (m: { roleId: string; tenantId: string }, active: string) =>',
      '  m.tenantId === active ? m.roleId : undefined;',
    ].join('\n');
    expect(await roleErrors(code)).toBe(0);
  }, 60_000);
});
