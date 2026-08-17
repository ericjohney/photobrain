const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// Stub out native-only packages that cannot be bundled for web/Metro
config.resolver.resolveRequest = (context, moduleName, platform) => {
	if (moduleName === "@photobrain/image-processing") {
		return {
			filePath: path.resolve(
				monorepoRoot,
				"packages/image-processing/browser.js",
			),
			type: "sourceFile",
		};
	}
	return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
