import { Address, beginCell, Cell } from "@ton/core";

export function normalizeAddress(address: string | Address): string {
  if (Address.isAddress(address)) {
    return address.toRawString();
  }
  return Address.parse(address).toRawString();
}

export function addressToStackItem(address: string): { type: "slice"; value: string } {
  const cell = beginCell().storeAddress(Address.parse(address)).endCell();
  return { type: "slice", value: cell.toBoc().toString("base64") };
}

export function decodeBase64Boc(value: unknown): Cell {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Expected a base64-encoded BoC string");
  }
  const cells = Cell.fromBoc(Buffer.from(value, "base64"));
  if (cells.length !== 1) {
    throw new Error("Expected a single-cell BoC");
  }
  return cells[0];
}

export function encodeBase64Boc(cell: Cell): string {
  return cell.toBoc().toString("base64");
}

export function makeZeroBitCell(): Cell {
  return beginCell().storeBit(0).endCell();
}

export function getNetworkGlobalId(network: string): number {
  if (!network.startsWith("tvm:")) {
    throw new Error(`Unsupported TVM network: ${network}`);
  }
  return Number.parseInt(network.slice(4), 10);
}
