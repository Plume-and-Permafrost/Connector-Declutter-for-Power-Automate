// Settings for Mozilla's web-ext tool (npm run firefox / build:firefox).
// It works from dist/firefox, which scripts/build-firefox.js stages from src/
// and manifest.firefox.json. build:chrome reuses web-ext only to zip, and points
// it at dist/chrome on the command line instead.
export default {
  sourceDir: 'dist/firefox',
  artifactsDir: 'web-ext-artifacts',
  build: { overwriteDest: true },
  run: { startUrl: ['https://make.powerautomate.com/'] }
};
