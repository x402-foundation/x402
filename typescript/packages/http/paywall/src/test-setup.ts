import { vi } from "vitest";

const MOCK_EVM_TEMPLATE = `<!DOCTYPE html>
<html>
<head>
  <title>EVM Paywall</title>
</head>
<body>
  <div id="root"></div>
</body>
</html>`;

const MOCK_SVM_TEMPLATE = `<!DOCTYPE html>
<html>
<head>
  <title>SVM Paywall</title>
</head>
<body>
  <div id="root"></div>
</body>
</html>`;

const MOCK_AVM_TEMPLATE = `<!DOCTYPE html>
<html>
<head>
  <title>AVM Paywall</title>
</head>
<body>
  <div id="root"></div>
</body>
</html>`;

vi.mock("./evm/template-loader", () => ({
  getEvmTemplate: vi.fn(() => MOCK_EVM_TEMPLATE),
}));

vi.mock("./svm/template-loader", () => ({
  getSvmTemplate: vi.fn(() => MOCK_SVM_TEMPLATE),
}));

vi.mock("./avm/template-loader", () => ({
  getAvmTemplate: vi.fn(() => MOCK_AVM_TEMPLATE),
}));
