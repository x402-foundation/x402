# Proposal: x402 Design Principles and XPs

> Status: Draft for TSC discussion. A response to [x402-foundation/tsc#9](https://github.com/x402-foundation/tsc/issues/9).

## Summary

x402 should govern its evolution with two pieces, modeled on how the Model Context Protocol does it:

1. **Design Principles.** A short set of north stars owned by the TSC. Each one takes a clear stance on a tradeoff. They describe a philosophy rather than define mechanical constraints.
2. **XPs (x402 Proposals).** The process for proposing changes to the protocol. Authors check XPs against the Design Principles. Reviewers weigh the principles; they don't apply them as a checklist.

Working groups produce XPs, implementations and code. A working group can adopt stricter internal rules for its own requirements when that's useful, such as traceability from each requirement to a parent principle. The TSC doesn't impose that structure on every group.

### Why not a fixed principles-to-requirements hierarchy

Tying every requirement to a parent principle is appealing in theory. But x402 is working at the leading edge, where needs change faster than a fixed rulebook can. Principles hold up best when they state a stance and leave room for judgment. Requirements are most useful when they sit close to the working group and the implementations that need them.

References:
- MCP Design Principles: https://modelcontextprotocol.io/community/design-principles
- MCP SEP Guidelines: https://modelcontextprotocol.io/community/sep-guidelines

---

## Part 1: Design Principles

These principles guide how the TSC and working groups evaluate proposals, weigh tradeoffs and evolve x402. They are guidance for and by the community when writing XPs, extensions and schemes. They don't replace review judgment.

### Simplicity over completeness

When a design can be made smaller, it should be. Generality is not free: the cost of covering every case is paid by everyone who only needed the common one.

We accept that some legitimate cases will fall outside the core. Extensions and profiles exist for exactly that, and a pattern that proves itself there can graduate later. Complexity that enters the core almost never leaves.

### Demonstrated need over anticipated need

A normative requirement should trace to a use case someone is actually trying to serve. Not a plausible one, and not one we expect to emerge, but a real implementation, deployed or committed, that cannot work without it.

Speculative requirements are cheap to add and expensive to carry. Left unchecked, they lead to unnecessary complexity.

### Present law over predicted law

x402 aims to let every party meet the obligations that actually apply to them. It exposes the facts an obligation depends on. It does not decide what those facts mean or whose rules apply.

A requirement justified by a rule that may arrive is a guess. Guessing wrong leads to bloat.

### Adding principles

This is an initial set, not a complete one. New principles are added through a Process XP (see below). A good principle:
- states a stance as "X over Y", where Y is something reasonable people would otherwise choose;
- explains the cost it is willing to accept;
- is short enough that people actually cite it in review.

---

## Part 2: XPs (x402 Proposals)

### What is an XP?

An XP is a design document that proposes a change to x402 or its processes. It gives a concise technical specification and the reasoning behind it. XPs are the main way to propose substantial changes, gather community input and record the design decisions behind x402.

The XP author is responsible for building consensus and for recording dissenting opinions. Authors should review the Design Principles before drafting.

### When to write an XP

**Write an XP for:**
- a change to the core specification (`specs/x402-specification-v*.md`): new or modified types, fields or facilitator interfaces;
- a new scheme, transport or extension;
- any change that breaks backward compatibility;
- a governance or process change, including changes to the Design Principles;
- a complex or contested topic with several valid solutions.

**Don't write an XP for:**
- bug fixes and typos;
- documentation clarifications;
- examples for existing features;
- a new network implementation of an existing scheme that follows the scheme's template without changing behavior. A normal PR is enough.

### XP types

| Type | Purpose |
|------|---------|
| **Standards Track** | A change to the core protocol: types, facilitator interface, or required behavior. |
| **Extensions Track** | A new or changed scheme, transport or extension. Same review process, but it lands outside the core. |
| **Process** | A change to how x402 is governed, including the Design Principles and this XP process. |
| **Informational** | Design guidance or context for the community. Proposes no new feature. |

Extensions Track is the default home for new ideas. In line with *Simplicity over completeness*, a pattern can graduate from an extension to Standards Track once it has proven itself across implementations.

### Workflow

```
Idea ──discuss in WG / issue──▶ PR with XP file ──▶ Awaiting Sponsor (up to 6 months)
                                                     │
                       ┌─────────────────────────────┼───────────────┐
                       ▼                             ▼               ▼
                     Draft                        Dormant        Withdrawn
                       │ sponsor review
                       ▼
                   In-Review ──TSC decides──▶ Accepted ──impl + tests──▶ Final
                                         └──▶ Rejected
```

1. **Discuss first.** Bring the idea to the relevant working group or open an issue. The XP PR must link to that discussion.
2. **Draft** the XP as `specs/xps/0000-short-title.md` in `x402-foundation/x402`, using the format below.
3. **Open a PR**, then rename the file to use the PR number.
4. **Find a sponsor.** A sponsor agrees to champion the XP and sets the status to `draft`. Sponsors can be TSC members, maintainers, or people the TSC assigns.
5. **Informal review** happens in PR comments with the sponsor and the working group.
6. **Formal review.** The sponsor sets the status to `in-review` and brings the XP to a TSC meeting. The TSC reviews XPs every two weeks in its regular meetings.
7. **Resolution.** The TSC accepts the XP, rejects it or sends it back for revision.
8. **Finalization.** The reference implementation lands, the conformance tests are merged (required for Standards Track XPs, see below), the spec changes are merged, and the sponsor sets the status to `final`.

### Statuses

| Status | Meaning |
|--------|---------|
| `draft` | Has a sponsor and is in informal review. |
| `in-review` | Ready for formal TSC review. |
| `accepted` | Approved, awaiting implementation and tests. |
| `rejected` | Declined by the TSC. |
| `withdrawn` | Withdrawn by the author. |
| `final` | Implemented, tested and merged into the spec. |
| `superseded` | Replaced by a newer XP. |
| `dormant` | No sponsor within 6 months. Can be revived; this is not a rejection. |

The sponsor owns status changes. The status field in the XP file is the canonical record, and PR labels mirror it.

### XP format

1. **Preamble.** Title, authors, status, type, PR number and a link to the prior discussion.
2. **Abstract.** About 200 words on the problem and the proposed change.
3. **Motivation.** Why x402 today is inadequate. This must name the *demonstrated need*: who is trying to ship what, and why they can't. An XP without real motivation can be rejected outright.
4. **Specification.** Syntax and semantics, detailed enough that independent implementations can interoperate. Use MUST/SHOULD/MAY.
5. **Rationale.** Design choices, alternatives considered, related work, objections raised and how they were resolved. Name the Design Principles in tension and explain the tradeoff.
6. **Backward compatibility.** Any breakage, how severe it is and the migration path.
7. **Reference implementation.** Required before `final`, not before `accepted`.
8. **Security considerations.** Payment, custody, replay, privacy and facilitator trust implications.

### Prototype requirement

An XP needs a runnable prototype before it can be accepted. Any of these counts: a branch of an x402 SDK, a standalone proof of concept, integration or e2e tests, or a reference client, server or facilitator. Pseudocode, design documents alone and "trust me, it works" don't count. The prototype doesn't need to be production-ready; it exists to prove feasibility and surface edge cases early.

This puts *Demonstrated need over anticipated need* into practice.

### Conformance tests

A Standards Track XP that adds or changes observable protocol behavior can't reach `final` until conformance tests for it are merged. The tests must:
- cover every MUST/MUST NOT and SHOULD/SHOULD NOT in the XP's Specification section, or record why one is excluded;
- pass against the XP's reference implementation.

Process and Informational XPs are exempt, as are Standards Track XPs with no observable behavior change. The sponsor makes sure the tests exist and cover the spec. Anyone can write them. Writing them while drafting is encouraged, because it surfaces vague normative language early.

### Review and acceptance

The TSC reviews XPs that are `in-review` every two weeks in its regular meetings. To be accepted, an XP needs:
- a working prototype;
- a clear benefit to the x402 ecosystem;
- community support, including from the relevant working group;
- consistency with the Design Principles, or an explicit, argued case for the tradeoff.

### After rejection

Rejection isn't permanent. An author can address the feedback and resubmit, submit a competing XP, or wait for circumstances to change.

---

## Part 3: Working groups

Working groups (identity, discovery, tax, card, …) are where most XPs come from. Each working group:
- produces XPs, implementations and code;
- may keep its own requirements tracker, and may require that tracker's requirements to cite a Design Principle if the group finds that useful;
- brings XPs to the TSC through a sponsor rather than ratifying protocol changes itself.

---

## Location

XPs live in `specs/xps/` in `x402-foundation/x402`, next to the specs they change.

## Transition

Proposals already in flight when this process is adopted are handled by how far along they are:
- **Early-stage proposals** (an idea, an issue, or an early draft spec) move into the XP process. They're rewritten in the XP format and need a sponsor.
- **Proposals close to the line** (near merge or near a TSC decision) are grandfathered and finish under the existing process in `specs/CONTRIBUTING.md`.

The TSC decides which group a borderline proposal falls into.

## Roadmap (future)

Eventually the TSC will publish a roadmap of priority areas, like MCP's, so authors can see what the TSC is focused on and check their proposals against it. It isn't part of this initial proposal.