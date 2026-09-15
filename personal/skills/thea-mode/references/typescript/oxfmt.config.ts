import { defineConfig } from "oxfmt";

export default defineConfig({
	ignorePatterns: [],
	sortImports: true,
	sortPackageJson: {
		sortScripts: true,
	},
	sortTailwindcss: {
		functions: ["tv"],
	},
});
