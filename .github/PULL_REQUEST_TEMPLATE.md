## Checklist

- [ ] `pnpm verify` is green (format + typecheck + tests + build)
- [ ] Documentation touched by this change is updated **in the same commit/PR**
      (see CONTRIBUTING.md — docs and code land together)
- [ ] New behavior is covered by tests; existing tests are not weakened
- [ ] No tokens, credentials, message bodies, or real `conversationKey` values added
      (tests use synthetic fixtures only)
- [ ] If the change touches the protocol (envelope, types, reason codes, constants):
      the corresponding spec in `docs/protocol/` is updated and the PR is marked
      `protocol-change` for double review

## What and why

<!-- One paragraph: what changes and why it is needed -->

## Verification

<!-- Exact commands you ran and their results -->
