import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'dev-dist', 'coverage', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    files: ['scripts/**/*.mjs', '*.config.js', 'electron/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    // T003: the Electron shell is CommonJS (electron/package.json → commonjs) and runs in Node.
    files: ['electron/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off', // CJS main process — require() is correct here
    },
  },
  {
    // FR-009 boundary: the web app must not know about electron/. `electron/` may import the web
    // app; the reverse voids the reason Electron was chosen over Tauri and re-opens the Principle V
    // gate. (Layer-3 network import allow-list — T008a — is a follow-up.)
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [{ name: 'electron', message: 'src/ must not import from electron/ (FR-009).' }] },
      ],
    },
  },
);
