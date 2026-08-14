/** Refresh the vendored payment-channels IDL from its pinned source revision. */

import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Source = {
  repository: string;
  revision: string;
  path: string;
  gitBlob: string;
};

const repositoryDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const packageDir = path.join(
  repositoryDir,
  "typescript",
  "packages",
  "mechanisms",
  "svm",
);
const metadataPath = path.join(
  packageDir,
  "idl",
  "payment-channels.source.json",
);
const idlPath = path.join(packageDir, "idl", "payment-channels.json");
const source = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as Source;
const url = `https://raw.githubusercontent.com/${source.repository}/${source.revision}/${source.path}`;
const response = await fetch(url);

if (!response.ok) {
  throw new Error(
    `failed to fetch payment-channels IDL: ${response.status} ${response.statusText}`,
  );
}

const idl = await response.text();
JSON.parse(idl);
const bytes = Buffer.from(idl);
const gitBlob = createHash("sha1")
  .update(`blob ${bytes.byteLength}\0`)
  .update(bytes)
  .digest("hex");
if (gitBlob !== source.gitBlob) {
  throw new Error(
    `payment-channels IDL blob ${gitBlob} does not match ${source.gitBlob}`,
  );
}
fs.writeFileSync(idlPath, idl);
console.log(
  `Updated ${path.relative(packageDir, idlPath)} from ${source.revision}`,
);
