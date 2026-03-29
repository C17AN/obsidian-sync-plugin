import esbuild from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import process from "node:process";

const production = process.argv.includes("--production");
const outputDir = "dist";

const copyStaticFilesPlugin = {
	name: "copy-static-files",
	setup(build) {
		build.onEnd(async (result) => {
			if (result.errors.length > 0) {
				return;
			}

			await mkdir(outputDir, { recursive: true });
			await Promise.all([
				copyFile("manifest.json", `${outputDir}/manifest.json`),
				copyFile("styles.css", `${outputDir}/styles.css`),
				copyFile("versions.json", `${outputDir}/versions.json`),
			]);
		});
	},
};

const context = await esbuild.context({
	bundle: true,
	entryPoints: ["src/main.ts"],
	external: ["obsidian", "electron", "@codemirror/state", "@codemirror/view", "@codemirror/language", "@lezer/common"],
	format: "cjs",
	logLevel: "info",
	outfile: `${outputDir}/main.js`,
	platform: "browser",
	plugins: [copyStaticFilesPlugin],
	sourcemap: production ? false : "inline",
	target: "es2020",
	treeShaking: true,
});

if (production) {
	await context.rebuild();
	await context.dispose();
} else {
	await context.watch();
}
