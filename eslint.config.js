// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

// Package boundaries are enforced here so agents (and humans) can't blur them:
//  - packages/contracts is ISOMORPHIC: it ships to the browser, so no Node or server deps.
//  - apps/web must never import backend-only code.
const serverOnly = [
  { name: '@app/server-kit', message: 'server-kit is backend-only.' },
  { name: 'express', message: 'Backend-only dependency.' },
  { name: 'knex', message: 'Backend-only dependency.' },
  { name: 'pg', message: 'Backend-only dependency.' },
];
const serverOnlyPatterns = [
  { group: ['node:*', '@app/server-kit/*'], message: 'Backend-only import.' },
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/routeTree.gen.ts',
      'infra/k8s/generated/**',
      'templates/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['scripts/**/*.mjs', '*.js'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['packages/contracts/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: serverOnly, patterns: serverOnlyPatterns }],
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-restricted-imports': ['error', { paths: serverOnly, patterns: serverOnlyPatterns }],
    },
  },
);
