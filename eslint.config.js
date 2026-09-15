// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        // `const { omitMe, ...rest } = obj` is the idiomatic way to drop a key.
        // Without this the discarded binding is reported as unused.
        ignoreRestSiblings: true,
      }],
      'no-console': 'error', // structured logging via pino only
    },
  },
  { ignores: ['dist/**', 'coverage/**'] },
);
