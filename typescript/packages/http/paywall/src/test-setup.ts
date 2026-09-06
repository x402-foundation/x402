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

vi.mock("./evm/template-loader", () => ({
  getEvmTemplate: () => MOCK_EVM_TEMPLATE,
}));

vi.mock("./svm/template-loader", () => ({
  getSvmTemplate: () => MOCK_SVM_TEMPLATE,
}));
