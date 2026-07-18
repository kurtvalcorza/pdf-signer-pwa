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
      // T008a — layer-3 Node-network prohibition (contracts/network-policy.md). `webRequest` (layer 2)
      // cannot see the main process, so this is the only authoring-time guard there; layer 6 (the
      // monitored-network gate, T031a) is the actual proof.
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'layer 3: no network globals in electron/** (network-policy.md).' },
        { name: 'WebSocket', message: 'layer 3: no network globals in electron/**.' },
        { name: 'XMLHttpRequest', message: 'layer 3: no network globals in electron/**.' },
        { name: 'EventSource', message: 'layer 3: no network globals in electron/**.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          // Node network clients by require().
          selector:
            "CallExpression[callee.name='require'][arguments.0.value=/^(node:)?(http|https|net|dgram|tls)$/]",
          message: 'layer 3: no Node HTTP/socket client in electron/** (network-policy.md).',
        },
        {
          // IMPORT ALLOW-LIST, not a deny-list: electron/ may require only node: builtins, `electron`,
          // or a relative path. A deny-list is defeated by `import got from 'got'`; this stops any
          // third-party (network-capable) package at authoring time.
          selector:
            "CallExpression[callee.name='require'][arguments.0.value=/^(?!node:|electron$|\\.).+/]",
          message:
            'layer 3 allow-list: electron/ may require only node: builtins, `electron`, or relative paths.',
        },
        {
          // `electron`'s own network-capable exports: net (HTTP client) and autoUpdater (update feed).
          selector: "MemberExpression[property.name=/^(net|autoUpdater)$/]",
          message: 'layer 3: `electron.net` / `electron.autoUpdater` are banned (network-policy.md).',
        },
      ],
    },
  },
  {
    // The preload runs in the renderer, so it has DOM globals (it injects the desktop-only US3 chrome).
    files: ['electron/preload.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser },
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
        {
          paths: [{ name: 'electron', message: 'src/ must not import from electron/ (FR-009).' }],
          // Also block a relative path INTO the shell (e.g. `../electron/paths.js`), which would pull
          // CommonJS/Node-only desktop code into the web bundle.
          patterns: [
            { group: ['**/electron/*', '**/electron/**'], message: 'src/ must not import from electron/ (FR-009).' },
          ],
        },
      ],
    },
  },
);
