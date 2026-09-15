import { defineConfig } from "oxlint";

export default defineConfig({
	categories: {
		correctness: "error",
		pedantic: "error",
		perf: "error",
		restriction: "error",
		style: "error",
		suspicious: "error",
	},
	env: {
		builtin: true,
	},
	globals: {},
	options: {
		reportUnusedDisableDirectives: "warn",
		typeAware: true,
		typeCheck: true,
	},
	overrides: [
		{
			files: ["src/**/*"],
			rules: {
				"import/no-default-export": "error",
				"import/prefer-default-export": "off",
				"node/no-process-env": "error",
			},
		},
		{
			files: ["tests/**/*"],
			rules: {
				"eslint/max-lines": "off",
				"eslint/max-lines-per-function": "off",
			},
		},
		{
			files: ["src/server.ts"],
			rules: {
				"import/no-default-export": "off",
			},
		},
	],
	plugins: [
		"eslint",
		"import",
		"jsx-a11y",
		"node",
		"oxc",
		"promise",
		"react",
		"react-perf",
		"typescript",
		"unicorn",
	],
	rules: {
		"eslint/array-callback-return": ["error", { allowImplicit: true }],
		"eslint/capitalized-comments": "off",
		"eslint/default-case": "off",
		"eslint/func-style": "off",
		"eslint/id-length": [
			"error",
			{
				checkGeneric: false,
				properties: "never",
			},
		],
		"eslint/init-declarations": "off",
		"eslint/max-lines": [
			"warn",
			{
				skipBlankLines: true,
				skipComments: true,
			},
		],
		"eslint/max-lines-per-function": [
			"warn",
			{
				skipBlankLines: true,
				skipComments: true,
			},
		],
		"eslint/max-params": "off",
		"eslint/max-statements": "off",
		"eslint/no-console": "off",
		"eslint/no-continue": "off",
		"eslint/no-duplicate-imports": [
			"error",
			{
				allowSeparateTypeImports: true,
			},
		],
		"eslint/no-magic-numbers": "off",
		"eslint/no-ternary": "off",
		"eslint/no-undefined": "off",
		"eslint/no-useless-return": ["off"],
		"eslint/no-void": ["error", { allowAsStatement: true }],
		"eslint/one-var": "off",
		"eslint/require-await": "off",
		"eslint/sort-imports": "off",
		"import/max-dependencies": ["warn", { ignoreTypeImports: true }],
		"import/no-default-export": "off",
		"import/no-named-export": "off",
		"import/no-unassigned-import": ["error", { allow: ["**/*.css"] }],
		"import/prefer-default-export": ["error", { target: "any" }],
		"node/no-process-env": "off",
		"oxc/no-async-await": "off",
		"oxc/no-optional-chaining": "off",
		"oxc/no-rest-spread-properties": "off",
		"react/jsx-filename-extension": [
			"error",
			{
				extensions: ["jsx", "tsx"],
			},
		],
		"react/no-multi-comp": "off",
		"react/react-in-jsx-scope": "off",
		"typescript/consistent-return": "off",
		"typescript/explicit-function-return-type": "off",
		"typescript/explicit-module-boundary-types": "off",
		"typescript/prefer-readonly-parameter-types": "off",
		"typescript/strict-boolean-expressions": "off",
		"unicorn/no-useless-undefined": ["error", { checkArguments: false }],
		"unicorn/number-literal-case": "off",
	},
});
