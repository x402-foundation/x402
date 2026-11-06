import { describe, expect, it } from "vitest";
import {
  bindingsEqual,
  httpRequestBinding,
  mcpToolCallBinding,
  parseBindingExtra,
  type HttpRequestInput,
  type McpToolCallInput,
} from "../../src/binding";
import { canonicalize } from "../../src/jcs";
import { HTTP_A_HASH, MCP_A_HASH, httpArticle, mcpArticle } from "./helpers";

// The http:1 and mcp:1 specification cases run from the shared vectors
// (shared-vectors.test.ts). This file covers JCS conformance, parameter parsing,
// URI syntax, and JavaScript input shapes.

const BINDING_ERROR = "invalid_exact_lnbtc_request_binding";

const http = (overrides: Partial<HttpRequestInput> = {}) =>
  httpRequestBinding({
    method: "GET",
    url: "https://api.example.com/article/A",
    boundHeaders: [],
    getHeader: () => undefined,
    ...overrides,
  });

const mcp = (overrides: Partial<McpToolCallInput> = {}) =>
  mcpToolCallBinding({
    server: "https://api.example.com/mcp",
    name: "get_article",
    arguments: { article: "A" },
    boundMetadata: [],
    ...overrides,
  });

describe("canonicalize (RFC 8785)", () => {
  it("sorts members by UTF-16 code units and omits whitespace", () => {
    expect(canonicalize({ b: [1, true, null], a: { d: "x", c: 1.5 } })).toBe(
      '{"a":{"c":1.5,"d":"x"},"b":[1,true,null]}',
    );
    expect(canonicalize({ "€": 1, "\r": 2, "😀": 3 })).toBe('{"\\r":2,"€":1,"😀":3}');
  });

  it("uses ECMAScript string and number serialization", () => {
    expect(canonicalize('a\n"\\\u0001')).toBe('"a\\n\\"\\\\\\u0001"');
    expect(canonicalize(1e21)).toBe("1e+21");
    expect(canonicalize(-0)).toBe("0");
    expect(canonicalize(0.000001)).toBe("0.000001");
  });

  it("rejects values outside the data model", () => {
    expect(() => canonicalize(Number.NaN)).toThrow();
    expect(() => canonicalize(Infinity)).toThrow();
    expect(() => canonicalize("\ud800")).toThrow();
    expect(() => canonicalize({ ["\udc00"]: 1 })).toThrow();
    expect(() => canonicalize(undefined)).toThrow();
    expect(() => canonicalize(1n)).toThrow();
    expect(() => canonicalize(new Date(0))).toThrow();
    expect(canonicalize(Object.create(null))).toBe("{}");
  });
});

describe("parseBindingExtra and bindingsEqual", () => {
  it("accepts valid extras and compares parameters by JCS", () => {
    const a = parseBindingExtra({ ...httpArticle(), extraField: 1 } as Record<string, unknown>);
    expect(a.requestHash).toBe(HTTP_A_HASH);
    const m1 = parseBindingExtra({ ...mcpArticle() });
    const m2 = parseBindingExtra({
      ...mcpArticle(),
      requestBindingParams: { metadata: [], server: "https://api.example.com/mcp" },
    });
    expect(bindingsEqual(m1, m2)).toBe(true);
    expect(bindingsEqual(a, m1)).toBe(false);
  });

  it("rejects missing, unknown, or malformed binding fields", () => {
    const base = httpArticle();
    const bad = [
      undefined,
      { ...base, requestHash: undefined },
      { ...base, requestHash: base.requestHash.toUpperCase() },
      { ...base, requestBindingProfile: "http:2" },
      { ...base, requestBindingProfile: undefined },
      { ...base, requestBindingParams: undefined },
      { ...base, requestBindingParams: [] },
      { ...base, requestBindingParams: {} },
      { ...base, requestBindingParams: { headers: [], extra: 1 } },
      { ...mcpArticle(), requestBindingParams: { server: "https://a.example/mcp" } },
      { ...mcpArticle(), requestBindingParams: { server: 1, metadata: [] } },
      {
        ...mcpArticle(),
        requestBindingParams: { server: "https://a.example/mcp", metadata: [], other: 1 },
      },
      {
        ...mcpArticle(),
        requestBindingParams: { server: "https://a.example/mcp", metadata: ["\ud800"] },
      },
      {
        ...mcpArticle(),
        requestBindingParams: { server: "https://a.example/mcp#x", metadata: [] },
      },
      { ...httpArticle(), requestBindingParams: { headers: ["payment-signature"] } },
      { ...httpArticle(), requestBindingParams: { headers: "accept" } },
      { ...mcpArticle(), requestBindingParams: { server: "https://a.example/mcp", metadata: "" } },
    ];
    for (const extra of bad) {
      expect(() => parseBindingExtra(extra as Record<string, unknown>)).toThrow(BINDING_ERROR);
    }
  });
});

describe("RFC 8785 conformance", () => {
  it("serializes the RFC 8785 number and string examples", () => {
    // RFC 8785 section 3.2.2 example values.
    expect(canonicalize([333333333.33333329, 1e30, 4.5, 2e-3, 0.000000000000000000000000001])).toBe(
      "[333333333.3333333,1e+30,4.5,0.002,1e-27]",
    );
    expect(canonicalize('€$\u000f\nA\'B"\\\\"/')).toBe('"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"');
    expect(canonicalize([5e-324, Number.MAX_SAFE_INTEGER + 2, -1.5e-7, 1e21, 1e20])).toBe(
      "[5e-324,9007199254740992,-1.5e-7,1e+21,100000000000000000000]",
    );
  });

  it("sorts members by UTF-16 code units (RFC 8785 section 3.2.3)", () => {
    const input = {
      "€": "Euro Sign",
      "\r": "Carriage Return",
      דּ: "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "😀": "Emoji: Grinning Face",
      "\u0080": "Control",
      ö: "Latin Small Letter O With Diaeresis",
    };
    expect(canonicalize(input)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  it("keeps an own __proto__ member and rejects sparse arrays", () => {
    expect(canonicalize(JSON.parse('{"__proto__":{"a":1},"b":2}'))).toBe(
      '{"__proto__":{"a":1},"b":2}',
    );
    expect(() => canonicalize([1, , 3])).toThrow("sparse array");
    expect(canonicalize([[], {}, [null, false, true]])).toBe("[[],{},[null,false,true]]");
  });

  it("rejects cyclic and absurdly deep values instead of crashing the caller", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => mcp({ arguments: cyclic })).toThrow(BINDING_ERROR);
    let deep: unknown = 1;
    for (let i = 0; i < 100_000; i++) deep = [deep];
    expect(() => mcp({ arguments: { deep } })).toThrow(BINDING_ERROR);
  });
});

describe("URI syntax", () => {
  it.each([
    "https://api.example.com:8443/a",
    "http://[::1]:8443/a?x[]=1&y=%41",
    "https://api.example.com/a?q=a/b?c&d=;,:@!$'()*+",
    "HTTPS://API.EXAMPLE.COM/A",
  ])("accepts %s and preserves its spelling", url => {
    expect(http({ url }).resourceUrl).toBe(url);
  });

  it("distinguishes spellings that a URL parser would normalize", () => {
    const hashes = [
      "https://api.example.com/article/A",
      "https://api.example.com:443/article/A",
      "HTTPS://api.example.com/article/A",
      "https://api.example.com/article/./A",
      "https://api.example.com/article/%41",
      "https://api.example.com/article/%4a",
      "https://api.example.com/article/%4A",
    ].map(url => http({ url }).requestHash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it.each([
    "https:api.example.com/a",
    "http:///a",
    "https://?a",
    "https://api.example.com/a b",
    "https://api.example.com/<a>",
    'https://api.example.com/"a"',
    "https://api.example.com/{a}",
    "https://api.example.com/a|b",
    "https://api.example.com\\a",
    "https://api.example.com/a^b",
    "https://api.example.com/`a`",
    "https://api.example.com/%zz",
    "https://api.example.com/%4",
    "https://api.example.com/é",
    "https://api.example.com/a\n",
    "https://:pw@api.example.com/a",
    "https://@api.example.com/a",
    "mailto:a@example.com",
    "",
  ])("rejects the http:1 URL %j", url => {
    expect(() => http({ url })).toThrow(BINDING_ERROR);
  });

  it("accepts non-HTTP MCP server URIs but applies the same syntax rules", () => {
    expect(mcp({ server: "urn:example:mcp-server" }).requestBindingParams.server).toBe(
      "urn:example:mcp-server",
    );
    for (const server of ["https:api.example.com/mcp", "urn:a b", "urn:%zz", "x"]) {
      expect(() => mcp({ server }), server).toThrow(BINDING_ERROR);
    }
  });
});

describe("binding input shapes", () => {
  it("treats an empty list of field lines as absent and joins empty lines", () => {
    const withHeader = (value: string | string[] | undefined) =>
      http({ boundHeaders: ["accept"], getHeader: () => value }).requestHash;
    expect(withHeader([])).toBe(withHeader(undefined));
    expect(withHeader(["", ""])).not.toBe(withHeader(""));
    expect(withHeader([" a ", "b\t"])).toBe(withHeader("a, b"));
    expect(withHeader(["a", ""])).not.toBe(withHeader("a"));
  });

  it("rejects header values outside visible ASCII and tab", () => {
    for (const value of ["a\r\nb", "a\u007f", "a\u0000", ["ok", "café"]]) {
      expect(
        () => http({ boundHeaders: ["accept"], getHeader: () => value }),
        JSON.stringify(value),
      ).toThrow(BINDING_ERROR);
    }
  });

  it("requires byte bodies", () => {
    expect(() => http({ body: "x" as unknown as Uint8Array })).toThrow(BINDING_ERROR);
    expect(http({ body: Buffer.from("x") }).requestHash).toBe(
      http({ body: Uint8Array.of(0x78) }).requestHash,
    );
  });

  it("orders metadata names by UTF-16 code units and rejects lone surrogates", () => {
    expect(
      mcp({ boundMetadata: ["A", "a", "é", "😀", "דּ"] }).requestBindingParams.metadata,
    ).toEqual(["A", "a", "é", "😀", "דּ"]);
    expect(() => mcp({ boundMetadata: ["דּ", "😀"] })).toThrow(BINDING_ERROR);
    expect(() => mcp({ boundMetadata: ["\ud800"] })).toThrow(BINDING_ERROR);
  });

  it("reads only own metadata members", () => {
    const absent = mcp({ boundMetadata: ["__proto__", "toString"], meta: {} }).requestHash;
    const own = mcp({
      boundMetadata: ["__proto__", "toString"],
      meta: JSON.parse('{"__proto__":1}'),
    }).requestHash;
    expect(own).not.toBe(absent);
    // An inherited member such as Object.prototype.toString is absent.
    expect(mcp({ boundMetadata: ["toString"], meta: {} }).requestHash).toBe(
      mcp({ boundMetadata: ["toString"] }).requestHash,
    );
  });

  it("rejects non-plain arguments and metadata objects", () => {
    expect(() => mcp({ arguments: new Map() })).toThrow(BINDING_ERROR);
    expect(() => mcp({ meta: new Date() })).toThrow(BINDING_ERROR);
    expect(
      mcp({ arguments: Object.assign(Object.create(null), { article: "A" }) }).requestHash,
    ).toBe(MCP_A_HASH);
  });

  it("rejects parameter objects carrying an extra own __proto__ member", () => {
    const params = JSON.parse('{"headers":[],"__proto__":{}}');
    expect(() => parseBindingExtra({ ...httpArticle(), requestBindingParams: params })).toThrow(
      BINDING_ERROR,
    );
  });
});
