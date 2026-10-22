// ESLint flat config for the IHG Guest Search monorepo.
// Custom guard rails (see design.md "Testing strategy" -> Static):
//   - BFF: no console logging; use the pino logger (Req 26.5, 22).
//   - BFF SOAP adapter: no string-built XML (Req 26.5, 7).
//   - Web components: no hard-coded hex colours; use brand tokens (Req 23.1).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Matches CSS hex colours: #rgb, #rgba, #rrggbb, #rrggbbaa.
const HEX_COLOUR = String.raw`/#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/`;
const HEX_MESSAGE =
  'Hex colour literals are not allowed in components. Use a Tailwind brand token (for example bg-primary, text-navy) instead (Req 23.1).';
const XML_MESSAGE =
  'Do not build XML with strings in soap/. Use xmlbuilder2 with namespace URIs from contract.ts (Req 26.5).';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/.vitest/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
  },
  {
    // Node CLI scripts run outside the TS build; declare the Node globals they use.
    files: ['scripts/**/*.{mjs,ts}'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
  },
  {
    files: ['apps/bff/**/*.{ts,js,mjs,cjs}'],
    rules: {
      'no-console': 'error',
    },
  },
  {
    files: ['apps/bff/src/soap/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TemplateLiteral:has(TemplateElement[value.raw=/</])',
          message: XML_MESSAGE,
        },
        {
          selector: "BinaryExpression[operator='+']:has(Literal[value=/</])",
          message: XML_MESSAGE,
        },
        {
          selector: "AssignmentExpression[operator='+=']:has(Literal[value=/</])",
          message: XML_MESSAGE,
        },
      ],
    },
  },
  {
    files: ['apps/web/src/**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: `Literal[value=${HEX_COLOUR}]`, message: HEX_MESSAGE },
        { selector: `TemplateElement[value.raw=${HEX_COLOUR}]`, message: HEX_MESSAGE },
        { selector: `JSXText[value=${HEX_COLOUR}]`, message: HEX_MESSAGE },
      ],
    },
  },
);
