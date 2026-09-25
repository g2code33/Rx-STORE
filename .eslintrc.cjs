module.exports = {
  root: true,
  env: { browser: true, node: true, es2022: true },
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
  plugins: ['@typescript-eslint', 'react-hooks'],
  ignorePatterns: ['dist/', 'dist-electron/', 'release/', 'android/', 'node_modules/', 'sdk/dist/', 'sdk/build-src/', 'sdk/sample-app/'],
  rules: {
    'react-hooks/rules-of-hooks': 'error'
  }
};
