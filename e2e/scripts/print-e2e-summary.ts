/**
 * Render e2e-results.json as a GitHub job summary (and stdout).
 *
 * Usage:
 *   pnpm results:summary
 *   pnpm results:summary e2e-results.json
 *
 * When GITHUB_STEP_SUMMARY is set (Actions), appends Markdown there so the
 * breakdown is visible at the top of the job page without scrolling the log.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

interface BreakdownStats {
  passed: number;
  failed: number;
}

interface E2eTestResult {
  testNumber: number;
  client: string;
  server: string;
  endpoint: string;
  facilitator: string;
  protocolFamily: string;
  scheme?: string;
  assetTransferMethod?: string;
  paymentFlow?: string;
  transport?: string;
  version?: string;
  passed: boolean;
  error?: string;
  network?: string;
}

interface E2eResultsJson {
  summary: {
    total: number;
    passed: number;
    failed: number;
    networkMode: string;
    durationMinutes?: number;
  };
  results: E2eTestResult[];
  breakdowns: {
    byFacilitator: Record<string, BreakdownStats>;
    byServer: Record<string, BreakdownStats>;
    byClient: Record<string, BreakdownStats>;
    byScheme?: Record<string, BreakdownStats>;
    byAssetTransferMethod?: Record<string, BreakdownStats>;
    byTransport?: Record<string, BreakdownStats>;
    byVersion?: Record<string, BreakdownStats>;
    byPaymentFlow?: Record<string, BreakdownStats>;
    byProtocolFamily: Record<string, BreakdownStats>;
  };
}

function mdCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function truncate(value: string, max = 160): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1)}…`;
}

function passRate(stats: BreakdownStats): string {
  const total = stats.passed + stats.failed;
  if (total === 0) {
    return "—";
  }
  return `${Math.round((stats.passed / total) * 100)}%`;
}

function sortBreakdown(entries: [string, BreakdownStats][]): [string, BreakdownStats][] {
  return [...entries].sort((a, b) => {
    if (a[1].failed !== b[1].failed) {
      return b[1].failed - a[1].failed;
    }
    return a[0].localeCompare(b[0]);
  });
}

function breakdownTable(title: string, breakdown: Record<string, BreakdownStats>, label: string): string[] {
  const entries = sortBreakdown(Object.entries(breakdown));
  if (entries.length === 0) {
    return [];
  }

  const lines = [
    `### ${title}`,
    "",
    `| ${label} | Passed | Failed | Rate |`,
    "| --- | ---: | ---: | ---: |",
  ];
  for (const [name, stats] of entries) {
    const mark = stats.failed > 0 ? "❌" : "✅";
    lines.push(`| ${mark} \`${mdCell(name)}\` | ${stats.passed} | ${stats.failed} | ${passRate(stats)} |`);
  }
  lines.push("");
  return lines;
}

function formatMarkdown(data: E2eResultsJson): string {
  const { summary, results, breakdowns } = data;
  const headline = summary.failed > 0 ? "❌ e2e results" : "✅ e2e results";
  const duration =
    summary.durationMinutes !== undefined ? ` · ⏱️ ${summary.durationMinutes.toFixed(2)} min` : "";

  const lines = [
    `## ${headline}`,
    "",
    `**${summary.total}** total · ✅ **${summary.passed}** passed · ❌ **${summary.failed}** failed · ${summary.networkMode}${duration}`,
    "",
  ];

  const failed = results.filter(r => !r.passed).sort((a, b) => a.testNumber - b.testNumber);
  if (failed.length === 0) {
    lines.push("✅ All combinations passed", "");
  } else {
    lines.push("### Failed combinations", "");
    lines.push("| # | Client | Server | Endpoint | Facilitator | Network | Error |");
    lines.push("| ---: | --- | --- | --- | --- | --- | --- |");
    for (const test of failed) {
      const error = truncate(test.error || "Unknown error");
      lines.push(
        `| ${test.testNumber} | \`${mdCell(test.client)}\` | \`${mdCell(test.server)}\` | \`${mdCell(test.endpoint)}\` | \`${mdCell(test.facilitator)}\` | ${mdCell(test.network || "—")} | ${mdCell(error)} |`,
      );
    }
    lines.push("");
  }

  lines.push(...breakdownTable("Breakdown by Facilitator", breakdowns.byFacilitator, "Facilitator"));
  lines.push(...breakdownTable("Breakdown by Server", breakdowns.byServer, "Server"));
  lines.push(...breakdownTable("Breakdown by Client", breakdowns.byClient, "Client"));

  if (breakdowns.byScheme) {
    lines.push(...breakdownTable("Breakdown by Scheme", breakdowns.byScheme, "Scheme"));
  }
  if (breakdowns.byAssetTransferMethod) {
    lines.push(...breakdownTable("Breakdown by Asset Transfer Method", breakdowns.byAssetTransferMethod, "ATM"));
  }
  if (breakdowns.byTransport) {
    lines.push(...breakdownTable("Breakdown by Transport", breakdowns.byTransport, "Transport"));
  }
  if (breakdowns.byVersion) {
    lines.push(...breakdownTable("Breakdown by Version", breakdowns.byVersion, "x402 version"));
  }
  if (breakdowns.byPaymentFlow && Object.keys(breakdowns.byPaymentFlow).length > 1) {
    lines.push(...breakdownTable("Breakdown by Payment Flow", breakdowns.byPaymentFlow, "Payment flow"));
  }

  const familyEntries = Object.entries(breakdowns.byProtocolFamily);
  if (familyEntries.length > 0) {
    lines.push("### Protocol Family Breakdown", "");
    lines.push("| Family | Passed | Failed | Total | Rate |");
    lines.push("| --- | ---: | ---: | ---: | ---: |");
    for (const [family, stats] of sortBreakdown(familyEntries)) {
      const total = stats.passed + stats.failed;
      const mark = stats.failed > 0 ? "❌" : "✅";
      lines.push(
        `| ${mark} ${mdCell(family.toUpperCase())} | ${stats.passed} | ${stats.failed} | ${total} | ${passRate(stats)} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

function main(): void {
  const inputPath = resolve(process.argv[2] || "e2e-results.json");
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;

  if (!existsSync(inputPath)) {
    const missing = `## e2e results\n\nNo results file at \`${inputPath}\`.\n`;
    console.error(`No e2e results JSON at ${inputPath}`);
    if (summaryPath) {
      appendFileSync(summaryPath, missing);
    }
    process.exit(1);
  }

  const data = JSON.parse(readFileSync(inputPath, "utf8")) as E2eResultsJson;
  const markdown = formatMarkdown(data);
  console.log(markdown);

  if (summaryPath) {
    appendFileSync(summaryPath, `${markdown}\n`);
  }
}

main();
