import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const ROLE_COMPARISON =
  'Never compare role names. Use usePermission, <Can> or manifest requires (CLAUDE.md).';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/node_modules/**',
      'packages/contract/src/generated/**',
      'apps/web/public/mockServiceWorker.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      'jsx-a11y': jsxA11y,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Never persist state (and never PHI) to browser storage. See CLAUDE.md Security and Privacy.
      'no-restricted-globals': [
        'error',
        { name: 'localStorage', message: 'No browser storage. Keep state in memory (CLAUDE.md).' },
        {
          name: 'sessionStorage',
          message: 'No browser storage. Keep state in memory (CLAUDE.md).',
        },
      ],
      // App code logs through shared/lib/logger, which cannot carry patient data.
      'no-console': 'error',
      // Access is decided by permissions, never by role names (CLAUDE.md Extensibility and Access Control).
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'BinaryExpression[operator=/^[!=]==?$/]:matches([left.name=/^role(Id|Name)?$/i], [right.name=/^role(Id|Name)?$/i], [left.property.name=/^role(Id|Name)?$/i], [right.property.name=/^role(Id|Name)?$/i], [left.object.name="BuiltInRoles"], [right.object.name="BuiltInRoles"])',
          message: ROLE_COMPARISON,
        },
        {
          selector:
            'SwitchStatement:matches([discriminant.name=/^role(Id|Name)?$/i], [discriminant.property.name=/^role(Id|Name)?$/i])',
          message: ROLE_COMPARISON,
        },
      ],
    },
  },
  {
    files: ['apps/web/src/**/*.test.{ts,tsx}', 'apps/web/src/test/**', 'apps/web/e2e/**'],
    languageOptions: { globals: { ...globals.node, ...globals.vitest } },
  },
  prettier,
);
