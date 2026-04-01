const fs = require("fs");
let devEnv = {};
if (fs.existsSync("./env-dev.js")) {
  devEnv = require("./env-dev");
}

module.exports = {
  apps: [
    {
      name: "feedwatcher-newsletter-server",
      cwd: "feedwatcher-newsletter-server",
      script: "npm",
      args: "run dev",
      autorestart: false,
      env_development: {
        ...devEnv,
        DEV_MODE: "true",
        DATA_DIR: "../data",
      },
    },
  ],
};
