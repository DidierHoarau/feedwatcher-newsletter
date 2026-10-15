module.exports = {
  coverageProvider: "v8",
  moduleFileExtensions: ["ts", "js"],
  transform: {
    "^.+\\.(ts|tsx)$": [
      "@swc/jest",
      {
        jsc: {
          target: "es2015",
        },
      },
    ],
    // Several dependencies (uuid v14, htmlparser2) ship ESM-only .js files
    // while being required from CommonJS; transform them to CommonJS.
    "^.+\\.js$": [
      "@swc/jest",
      {
        jsc: {
          target: "es2015",
        },
      },
    ],
  },
  transformIgnorePatterns: [],
  testMatch: ["/**/src/**/*.spec.(ts|js)"],
  testEnvironment: "node",
};
