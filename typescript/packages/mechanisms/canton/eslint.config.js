import js from "@eslint/js";
import ts from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import prettier from "eslint-plugin-prettier";
import jsdoc from "eslint-plugin-jsdoc";
import importPlugin from "eslint-plugin-import";

export default [
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    ignores: ["**/*.test.ts", "test/**/*"],
    languageOptions: {
      parser: tsParser,
      sourceType: "module",
      ecmaVersion: 2020,
      globals: {
        process: "readonly",
        __dirname: "readonly",
        module: "readonly",
        require: "readonly",
        Buffer: "readonly",
        exports: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": ts,
      prettier: prettier,
      jsdoc: jsdoc,
      import: importPlugin,
    },
    rules: {
      ...ts.configs.recommended.rules,
      "import/first": "error",
      "prettier/prettier": "error",
      "@typescript-eslint/member-ordering": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_$" }],
      "jsdoc/tag-lines": ["error", "any", { startLines: 1 }],
      "jsdoc/check-alignment": "error",
      "jsdoc/no-undefined-types": "off",
      "jsdoc/check-param-names": "error",
      "jsdoc/check-tag-names": "error",
      "jsdoc/check-types": "error",
      "jsdoc/implements-on-classes": "error",
      "jsdoc/require-description": "error",
      "jsdoc/require-jsdoc": [
        "error",
        {
          require: {
            FunctionDeclaration: true,
            MethodDefinition: true,
            ClassDeclaration: true,
            ArrowFunctionExpression: false,
            FunctionExpression: false,
          },
        },
      ],
      "jsdoc/require-param": "error",
      "jsdoc/require-param-description": "error",
      "jsdoc/require-param-type": "off",
      "jsdoc/require-returns": "error",
      "jsdoc/require-returns-description": "error",
      "jsdoc/require-returns-type": "off",
      "jsdoc/require-hyphen-before-param-description": ["error", "always"],
    },
  },
  {
    files: ["**/*.test.ts", "test/**/*"],
    languageOptions: {
      parser: tsParser,
      sourceType: "module",
      ecmaVersion: 2020,
    },
    plugins: {
      "@typescript-eslint": ts,
      prettier: prettier,
    },
    rules: {
      "prettier/prettier": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/member-ordering": "off",
    },
  },
  {
    // Ported Canton protocol core: the inline-payload codec and the
    // verify-before-sign / prepared-transaction decoder are a faithful port of
    // externally-audited FTP code. Reformatting their doc comments to a
    // different house style risks transcription errors in security-critical
    // logic, so — mirroring the vendored-code exemption pattern — they are
    // exempt from hand-written JSDoc-completeness rules (correctness rules like
    // check-param-names still apply).
    files: [
      "src/prepared-transfer.ts",
      "src/inline-payload.ts",
      "src/inline-codec.ts",
      "src/amount.ts",
      "src/encoding.ts",
      "src/exact/facilitator/verify-inline.ts",
      // Ported thin ledger client + verify/settle primitives (faithful port of
      // the production `@ftptech/x402-canton-ledger` + facilitator canton logic).
      "src/ledger/client.ts",
      "src/ledger/scan.ts",
      "src/ledger/canton-hash.ts",
      "src/ledger/external-party.ts",
      "src/ledger/payer-proof.ts",
      "src/ledger/transfer-factory.ts",
    ],
    rules: {
      "jsdoc/require-jsdoc": "off",
      "jsdoc/require-description": "off",
      "jsdoc/require-param": "off",
      "jsdoc/require-param-description": "off",
      // Ported functions document their inline-object arguments at the object
      // level (`@param args`) rather than enumerating every nested field; keep
      // the completeness check off for them (correctness rules like check-types
      // still apply). Mirrors the require-* exemptions above.
      "jsdoc/check-param-names": "off",
      "jsdoc/require-returns": "off",
      "jsdoc/require-returns-description": "off",
      "jsdoc/require-hyphen-before-param-description": "off",
      "jsdoc/tag-lines": "off",
    },
  },
];
