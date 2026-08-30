# Go Builder-Code Attribution Hardening Plan

## Working state

- Branch: `feature/go-builder-code-attribution-hardening`
- Base: `e398a9e5724542e5b2da37c953156159fb7171d2` (`main` and `origin/main` matched on 2026-08-30)
- Primary issue: https://github.com/x402-foundation/x402/issues/3299
- Related design issue: https://github.com/x402-foundation/x402/issues/3280
- Existing user change: `.gitignore` is modified and must not be edited, staged, or committed as part of this work.

This is a working handoff document. Do not include it in the upstream PR unless the maintainer explicitly asks for it.

## Goal

Prevent an untrusted client-provided builder-code app attribution (`a`) from becoming an onchain ERC-8021 suffix unless it matches a trusted resource-server declaration.

Preserve all legitimate behavior:

- client, server, and facilitator service codes (`s`) continue to compose within their reservations;
- the facilitator's own wallet code (`w`) continues to be appended;
- valid declared app attribution continues to work if the chosen design supplies the declaration to the facilitator;
- exact EIP-3009, exact Permit2, upto, and batch-settlement use the same protection;
- legacy/v1 code is not changed.

## Verified state on current main

No relevant file changed between the issue's tested pin (`b703a0e`) and the branch base (`e398a9e5`). No open PR was found that fixes #3299, threads trusted extension declarations into `DataSuffixContext`, or performs the facilitator-side builder-code echo validation.

Historical PRs found by search:

- #2050 added the builder-code specification.
- #2575 added the original Go builder-code implementation.

Neither addresses this issue.

### Confirmed Go behavior

1. `go/server.go:923-927`

   `ValidateExtensions` accepts non-v2 payloads and accepts any payload when the server declared no extensions. It also intentionally permits client-only extension keys.

2. `go/extensions/buildercode/facilitator.go:42-52`

   `BuildDataSuffix` reads `a` from `PaymentPayload.Extensions`, checks only its syntax, and places it in the ERC-8021 suffix.

3. `go/mechanisms/evm/datasuffix.go:17-20`

   `DataSuffixContext` contains only the payment payload and selected payment requirements. It has no independent resource-server declaration.

4. `go/http/facilitator_client.go:414-418` and `:486-490`

   Remote verify/settle requests send only `x402Version`, `paymentPayload`, and `paymentRequirements`. The trusted declaration is lost at the resource-server/facilitator boundary.

5. `go/server.go:1212`, `:1317`, and `:1321`

   The resource server calls the facilitator with only serialized payload and requirements, despite `SettlePaymentWithExtensions` already holding `declaredExtensions`.

### Important scope correction

Do not copy the TypeScript v1 bypass claim into the Go PR.

The official Go HTTP resource server detects the payload version and rejects anything other than v2 at `go/http/server.go:1229-1238`. The Go v1 EVM facilitator path also builds the data suffix from an empty context. Therefore:

- reproduce and fix the v2 undeclared/mismatched `a` path;
- do not modify `go/legacy`;
- do not claim that the official Go HTTP server accepts the issue's TypeScript B1 v1 payload.

## Protocol invariants

Use these as the implementation oracle rather than copying current code behavior.

1. A client may attach `s` whether or not the resource server declared builder-code.
2. A client must not set `a` when the resource server did not declare builder-code.
3. When the resource server declared `builder-code.info.a`, the payload's `a` must match it exactly.
4. A client must not author the facilitator-owned `w` field.
5. A facilitator must not mint `a` from the payload based only on syntactic validity.
6. Facilitator-owned `w` and optional facilitator `s` remain valid without a server declaration.
7. A context field does not authenticate a resource server by itself. Any remote trust claim still depends on the deployment's authenticated resource-server-to-facilitator relationship.

## Non-goals

- Do not redesign ERC-8021 or builder-code reservations.
- Do not sign the entire extensions bag as part of EIP-3009/Permit2 in this PR.
- Do not change Bazaar or unrelated extension semantics.
- Do not reject all client-only extensions; builder-code `s` is explicitly valid without a server declaration.
- Do not touch TypeScript, Python, Java, or legacy/v1 unless maintainers explicitly request a cross-SDK solution.
- Do not add dependencies.

## Development plan

### 1. Independently reproduce with failing tests

Add the smallest tests that demonstrate the Go-specific problem before changing production code.

Candidate locations:

- `go/server_test.go`
- `go/extensions/buildercode/facilitator_test.go`
- `go/mechanisms/evm/datasuffix_test.go` only if common-path wiring requires direct coverage

Required cases:

- [ ] Undeclared builder-code + payload `info.a = attacker_app` is rejected by the resource-server validation path.
- [ ] Undeclared builder-code + payload containing only valid `info.s` remains accepted.
- [ ] Declared `a = honest_app` + echoed `a = attacker_app` is rejected.
- [ ] Declared `a = honest_app` + echoed `a = honest_app` is accepted.
- [ ] Client-authored `w` is rejected or ignored according to the maintainer-approved behavior.
- [ ] Facilitator cannot encode `a` without a trusted declaration.
- [ ] Facilitator encodes `a` only when it exactly matches the trusted declaration.
- [ ] Facilitator `w` and facilitator service code still encode normally.
- [ ] Existing `s` merge, deduplication, validation, and reservation tests continue to pass.

For each bug test, confirm it fails on the branch base for the expected reason before implementing the fix.

### 2. Post the Go scope analysis on #3299

Before making a public API or wire-format change, comment on #3299 with:

- the current-main commit tested;
- the Go files and behavior above;
- the correction that the official Go HTTP server rejects v1 payloads;
- a minimal deterministic Go reproduction;
- the design question below;
- an explicit note that no other contributor appears to be implementing the Go slice.

### 3. Design decision gate — STOP before widening interfaces

The resource-server mitigation is locally decidable, but the complete facilitator fix is not. Obtain maintainer direction before adding fields to public interfaces or HTTP envelopes.

Discuss these options:

#### Option A — trusted context propagation (complete, larger)

Propagate an optional, JSON-serializable server-owned context through verify and settle, then expose it to `DataSuffixContext`. Builder-code accepts `a` only when it matches the propagated declaration.

Questions that must be answered:

- Is the context the full `PaymentRequired` or a normative subset containing declared extensions?
- How is it represented in the HTTP facilitator request?
- How do in-process and remote facilitator paths remain equivalent?
- How is backward compatibility handled for facilitators that do not understand the context?
- Does builder-code fail closed or omit `a` when context is absent?
- How is context detached/copied so hooks or lifecycle stages cannot mutate shared state?

This aligns with #3280 but may require cross-SDK/spec agreement. Do not invent a Go-only wire contract without maintainer approval.

#### Option B — fail-closed omission (smallest secure facilitator change)

When no trusted declaration is available, omit payload-provided `a` from the suffix. Continue emitting facilitator-owned `w` and permitted `s` values.

Tradeoff: existing Go app attribution would disappear until trusted context propagation lands. This is secure but behaviorally significant and must be explicitly approved.

#### Option C — resource-server-only mitigation (partial)

Reject undeclared/mismatched `a` in the official resource server while leaving direct facilitator calls unchanged.

This protects the normal SDK path but does not satisfy the specification's facilitator MUST and must not be presented as a complete fix for #3299. Use only as a separately scoped mitigation if maintainers request it.

### 4. Implement the approved minimal design

Implementation constraints:

- [ ] Keep the diff scoped to #3299.
- [ ] Reuse existing `ValidateExtensions`, `DataSuffixContext`, facilitator context, and HTTP codec paths.
- [ ] Prefer guard clauses and explicit typed fields.
- [ ] Avoid a generic extension-policy framework unless at least one existing abstraction naturally supports it.
- [ ] Preserve the intentional client-only extension behavior outside server-owned builder-code fields.
- [ ] Do not silently accept malformed or mismatched attribution.
- [ ] Apply the rule once in the shared suffix resolution path rather than duplicating it across exact/upto/batch mechanisms.
- [ ] Add or update comments only where they explain the trust boundary.

Likely files, depending on the approved option:

- `go/server.go`
- `go/server_test.go`
- `go/interfaces.go` and/or `go/types.go`
- `go/http/facilitator_client.go`
- `go/http/facilitator_client_test.go`
- facilitator HTTP server/request decoding files
- `go/mechanisms/evm/datasuffix.go`
- `go/mechanisms/evm/datasuffix_test.go`
- `go/extensions/buildercode/facilitator.go`
- `go/extensions/buildercode/facilitator_test.go`

Do not edit every EVM mechanism merely to pass the same context if the shared abstraction can carry it once.

### 5. Verification

Run targeted tests first, then the complete Go checks from `go/`:

```bash
go test ./extensions/buildercode ./mechanisms/evm/...
make fmt
make lint
make build
make test
```

Also verify:

- [ ] exact EIP-3009 suffix path
- [ ] exact Permit2 suffix path
- [ ] upto Permit2 suffix path
- [ ] batch-settlement suffix path
- [ ] in-process facilitator path
- [ ] remote HTTP facilitator request/response round trip if context propagation is selected
- [ ] race-sensitive tests if any shared context or map ownership changes
- [ ] no unrelated `.gitignore` change is staged

Create the Go changelog fragment before the PR:

```bash
make changelog-new
```

### 6. Commit and PR requirements

- [ ] Review all generated code manually, especially payment/settlement trust boundaries.
- [ ] Remove verbose or implementation-narrating comments.
- [ ] Use `onchain` spelling.
- [ ] Sign every commit; unsigned commits will not be reviewed.
- [ ] Keep commits atomic.
- [ ] PR title should be concise, for example: `fix(go): validate builder-code app attribution`.
- [ ] PR body should use `Refs #3299` unless the change fully fixes all issue scope accepted by maintainers.
- [ ] State the root cause with file and line references.
- [ ] Explain why the selected design was chosen over the alternatives above.
- [ ] Disclose significant AI assistance.

## Blind cross-verification plan

Run this only after the implementation and tests are committed. The cross-verification workers must read committed files from independent worktrees and must not modify code.

### Preconditions

- Orca runtime is active: `orca status --json`.
- Orca orchestration experimental feature is enabled.
- All implementation files under review are committed on `feature/go-builder-code-attribution-hardening`.
- The user reviews and approves the final brief before fan-out.

### Draft self-contained verification brief

```markdown
# 검증 과제: Go builder-code app attribution hardening

## 대상
- 레포: /Users/xonxoon/Workspace/x402
- 기준 브랜치: feature/go-builder-code-attribution-hardening
- 기준 커밋: 실행 시 브랜치 HEAD를 기록할 것
- 검증 범위:
  - specs/extensions/builder_code.md
  - go/server.go 및 관련 테스트
  - go/http facilitator verify/settle codec 및 관련 테스트
  - go/mechanisms/evm/datasuffix.go 및 관련 테스트
  - go/extensions/buildercode/facilitator.go 및 관련 테스트
  - exact EIP-3009, exact Permit2, upto, batch-settlement의 suffix 호출 지점

## 배경
builder-code의 `a`는 resource server가 선언하는 app attribution이며, client는 서버가 선언하지 않은 `a`를 설정하면 안 된다. Facilitator는 client가 echo한 `a`가 resource server 선언과 정확히 일치하는지 확인한 뒤에만 ERC-8021 suffix에 포함해야 한다. 기존 Go 구현은 payload의 `a`를 형식만 검사하고 suffix에 포함했으며 facilitator context에는 독립적인 서버 선언이 없었다. 공식 Go HTTP resource server는 v1 payload를 거부하므로 TypeScript 이슈의 v1 우회는 Go 검증 범위가 아니다.

## 판정 기준 (oracle)
1. `a`는 신뢰할 resource-server 선언과 정확히 일치할 때만 onchain suffix에 포함된다.
2. 서버 미선언, 선언 불일치, 신뢰할 context 부재 시 client가 지정한 `a`가 suffix에 포함되지 않는다.
3. client는 미선언 상태에서도 허용된 `s`를 보낼 수 있다.
4. client가 facilitator 소유의 `w`를 권위 있게 설정할 수 없다.
5. facilitator 자체 `w`와 선택적 facilitator `s`는 정상 동작한다.
6. exact EIP-3009, exact Permit2, upto, batch-settlement가 동일한 보호를 받는다.
7. in-process와 remote facilitator 경로의 보안 의미가 일치한다.
8. 기존 정상 builder-code 병합, dedup, 예약 한도, CBOR 인코딩 동작이 유지된다.
9. legacy/v1 코드는 변경되지 않는다.
10. 새 context가 있다면 별도 인증을 제공한다고 과장하지 않으며, shared mutable state를 만들지 않는다.

## 산출물 규격 (MUST)
검증 결과를 워킹 디렉토리 루트의 `findings.md`에 저장한다.

| # | 파일:라인 | 문제 요약 | 근거 | 심각도(high/med/low) |
|---|---|---|---|---|

- 발견 항목이 없으면 `발견 항목 없음`과 확인한 범위를 적는다.
- 마지막 `검증 완료 선언` 섹션에 확인한 파일과 확인하지 못한 부분을 적는다.
- 코드를 수정하지 않는다.
- `worker_done` payload에 `reportPath`로 `findings.md` 절대경로를 포함한다.
```

### Cross-verification execution

1. Create two identical orchestration tasks from the approved brief.
2. Create independent `--no-parent` worktrees from this branch, one for Claude Code and one for Codex.
3. Dispatch the same brief with `--inject`; do not reveal the other worker.
4. Wait until both `worker_done` messages arrive before reading either report.
5. Compare findings:
   - both agree: accept as confirmed;
   - one-sided or conflicting: inspect the cited code and spec directly;
   - record accepted and rejected findings with reasons.
6. Fix only findings approved by the user, then rerun affected tests and, if material, repeat verification on the new committed HEAD.

## Handoff checklist for the next session

- [ ] Confirm branch and base commit.
- [ ] Re-check #3299, #3280, and open PRs for new activity before coding.
- [ ] Preserve the user's `.gitignore` modification.
- [ ] Read `.agents/skills/contributing/SKILL.md` before edits.
- [ ] Run failing reproductions before production changes.
- [ ] Post the Go-specific scope and design question to #3299.
- [ ] Stop at the public API/wire-format decision gate unless maintainer direction exists.
- [ ] Implement the approved minimal design.
- [ ] Run targeted and full Go verification.
- [ ] Add a Go changelog fragment.
- [ ] Commit with signature.
- [ ] Obtain user approval for the cross-verification brief.
- [ ] Run blind Claude/Codex cross-verification and adjudicate differences.

