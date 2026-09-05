/**
 * Safe filesystem helpers for operational reports.
 */
const fs = require("fs");
const path = require("path");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Write via temp file + rename to reduce partial-write risk. */
function atomicWriteFile(targetPath, contents, encoding = "utf8") {
  ensureDir(path.dirname(targetPath));
  const tmp = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, contents, encoding);
  fs.renameSync(tmp, targetPath);
}

function readTextIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf8");
}

function reportsRoot(cwd = process.cwd()) {
  return path.join(cwd, "reports");
}

module.exports = {
  ensureDir,
  atomicWriteFile,
  readTextIfExists,
  reportsRoot,
};
