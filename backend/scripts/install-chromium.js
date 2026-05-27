const { spawnSync } = require("child_process");

const isRender = process.env.RENDER === "true" || process.env.RENDER === "1";

if (!isRender) {
  process.exit(0);
}

const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(
  npxCommand,
  ["puppeteer", "browsers", "install", "chrome"],
  {
    stdio: "inherit",
    shell: false,
  },
);

if (result.error) {
  // eslint-disable-next-line no-console
  console.error("Failed to install Puppeteer browser:", result.error);
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
