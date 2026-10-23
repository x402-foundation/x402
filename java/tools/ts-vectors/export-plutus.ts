/**
 * Exports Plutus data encodings and parameterised script hashes, as the TypeScript SDK produces
 * them with Evolution, to java/x402-mechanism-cardano/src/test/resources/vectors/plutus-encoding.json.
 *
 * Each data vector carries a neutral description (int / bytes / constr / list / map) that the
 * Java test rebuilds, plus the CBOR hex Evolution writes for it. The forms cover what the Java
 * code encodes on chain: big integers past 64 bits, long byte strings, every constructor tag
 * range, empty and non-empty lists and maps, and the shapes of the Masumi lock datum.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cardanoDir = join(here, "../../../typescript/packages/mechanisms/cardano");
const require = createRequire(join(cardanoDir, "package.json"));
const src = (path: string) => require(join(cardanoDir, "src", path));
const helper = (path: string) => require(join(cardanoDir, "test/helpers", path));

const { Data } = require("@evolution-sdk/evolution");
const { deriveScriptHashHex } = src("exact/facilitator/scriptAddress.ts");

type Desc =
  | { int: string }
  | { bytes: string }
  | { constr: string; fields: Desc[] }
  | { list: Desc[] }
  | { map: [Desc, Desc][] };

function toData(d: Desc): unknown {
  if ("int" in d) return Data.int(BigInt(d.int));
  if ("bytes" in d) return Data.bytearray(d.bytes);
  if ("constr" in d) return Data.constr(BigInt(d.constr), d.fields.map(toData));
  if ("list" in d) return Data.list(d.list.map(toData));
  return Data.map(d.map.map(([k, v]) => [toData(k), toData(v)]));
}

const two64 = 1n << 64n;
const int = (v: bigint): Desc => ({ int: v.toString() });
const bytes = (hex: string): Desc => ({ bytes: hex });
const constr = (i: number | bigint, ...fields: Desc[]): Desc => ({ constr: BigInt(i).toString(), fields });

const sixtyFiveByteMagnitude = (1n << 520n) - 1n;

const data: Record<string, Desc> = {
  intZero: int(0n),
  intMaxUint64: int(two64 - 1n),
  intTwo64: int(two64),
  intNegTwo64: int(-two64),
  intNegTwo64Minus1: int(-two64 - 1n),
  int2pow70: int(1n << 70n),
  intNeg2pow70: int(-(1n << 70n)),
  int65ByteMagnitude: int(sixtyFiveByteMagnitude),
  intNeg65ByteMagnitude: int(-sixtyFiveByteMagnitude - 1n),
  bytesEmpty: bytes(""),
  bytes64: bytes("ab".repeat(64)),
  bytes65: bytes("ab".repeat(65)),
  bytes200: bytes("cd".repeat(200)),
  constr0Empty: constr(0),
  constr1Empty: constr(1),
  constr6: constr(6, int(1n)),
  constr7: constr(7, int(1n)),
  constr127: constr(127, bytes("00")),
  constr128: constr(128, int(2n)),
  constr2pow40: constr(1n << 40n),
  listEmpty: { list: [] },
  listInts: { list: [int(1n), int(-1n), int(two64)] },
  mapEmpty: { map: [] },
  mapIntBytes: { map: [[int(1n), bytes("aa")], [int(0n), bytes("bb")]] },
  mapNested: { map: [[bytes("01"), { list: [int(5n)] }], [constr(0), { map: [] }]] },
  // The Masumi lock-datum shapes: address with a stake credential, with a pointer, without
  // stake, an Option none, long and 64-byte byte strings, POSIX times.
  masumiShaped: constr(
    0,
    constr(0, constr(0, bytes("11".repeat(28))), constr(0, constr(0, constr(0, bytes("22".repeat(28)))))),
    constr(0, constr(1, bytes("33".repeat(28))), constr(0, constr(1, int(123456789n), int(2n), int(0n)))),
    constr(0, constr(0, constr(0, bytes("44".repeat(28))), constr(1))),
    constr(1),
    bytes("55".repeat(32)),
    bytes("66".repeat(64)),
    bytes("77".repeat(90)),
    int(1785756000000n),
    int(0n),
  ),
};

const vectors = Object.entries(data).map(([name, desc]) => ({
  name,
  data: desc,
  cborHex: Data.toCBORHex(toData(desc) as never),
}));

const MINIMAL = helper("stubs.ts").MINIMAL_PLUTUS_V3;
const scriptHashes = [
  { name: "bigintPositive2pow64", parameters: { p: { type: "bigint", value: two64.toString() } } },
  { name: "bigintPositive2pow70", parameters: { p: { type: "bigint", value: (1n << 70n).toString() } } },
  { name: "bigint65Bytes", parameters: { p: { type: "bigint", value: sixtyFiveByteMagnitude.toString() } } },
  { name: "bigintNegative65Bytes", parameters: { p: { type: "bigint", value: (-sixtyFiveByteMagnitude - 1n).toString() } } },
  { name: "bytes65", parameters: { p: { type: "bytes", value: "ab".repeat(65) } } },
].map(v => {
  const extra = { script: { type: "plutusV3", code: MINIMAL }, parameters: v.parameters };
  try {
    return { name: v.name, extra, scriptHash: deriveScriptHashHex(extra) };
  } catch (error) {
    return { name: v.name, extra, error: (error as Error).message };
  }
});

const outDir = join(here, "../../x402-mechanism-cardano/src/test/resources/vectors");
mkdirSync(outDir, { recursive: true });
const tsCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: here }).toString().trim();
writeFileSync(
  join(outDir, "plutus-encoding.json"),
  JSON.stringify({ tsCommit, data: vectors, scriptHashes }, null, 2) + "\n",
);
console.log(`wrote plutus-encoding.json (${vectors.length} data, ${scriptHashes.length} script hashes)`);
