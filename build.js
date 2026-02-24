/**
 * Build production-ready bundle: sources -> dist/
 * Usage: npm run build
 */

const fs = require("fs");
const path = require("path");

const root = __dirname;
const dist = path.join(root, "dist");

async function run() {
  const terser = require("terser");
  const CleanCSS = require("clean-css");

  if (!fs.existsSync(dist)) fs.mkdirSync(dist, { recursive: true });
  if (!fs.existsSync(path.join(dist, "css"))) fs.mkdirSync(path.join(dist, "css"), { recursive: true });
  if (!fs.existsSync(path.join(dist, "js"))) fs.mkdirSync(path.join(dist, "js"), { recursive: true });

  // Minify script.js -> dist/script.min.js
  const scriptJs = fs.readFileSync(path.join(root, "script.js"), "utf8");
  const scriptMin = await terser.minify(scriptJs, { compress: true, mangle: true });
  if (scriptMin.error) throw scriptMin.error;
  fs.writeFileSync(path.join(dist, "script.min.js"), scriptMin.code);

  // Minify styles.css -> dist/styles.min.css
  const stylesCss = fs.readFileSync(path.join(root, "styles.css"), "utf8");
  const stylesMin = new CleanCSS({}).minify(stylesCss);
  if (stylesMin.errors.length) throw new Error(stylesMin.errors.join("; "));
  fs.writeFileSync(path.join(dist, "styles.min.css"), stylesMin.styles);

  // Minify css/loading-states.css -> dist/css/loading-states.min.css
  const loadingCss = fs.readFileSync(path.join(root, "css", "loading-states.css"), "utf8");
  const loadingMin = new CleanCSS({}).minify(loadingCss);
  if (loadingMin.errors.length) throw new Error(loadingMin.errors.join("; "));
  fs.writeFileSync(path.join(dist, "css", "loading-states.min.css"), loadingMin.styles);

  // Copy js/utils.js -> dist/js/utils.js
  fs.copyFileSync(path.join(root, "js", "utils.js"), path.join(dist, "js", "utils.js"));

  // Copy index.html to dist/, replace asset paths with .min versions
  let indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
  indexHtml = indexHtml
    .replace(/script\.js/g, "script.min.js")
    .replace(/styles\.css\?v=[^"]+"/g, "styles.min.css?v=1.0\"")
    .replace(/styles\.css/g, "styles.min.css")
    .replace(/css\/loading-states\.css\?v=[^"]+"/g, "css/loading-states.min.css?v=1.0\"")
    .replace(/css\/loading-states\.css/g, "css/loading-states.min.css");
  fs.writeFileSync(path.join(dist, "index.html"), indexHtml);

  console.log("Build complete: dist/index.html, script.min.js, styles.min.css, css/loading-states.min.css, js/utils.js");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
