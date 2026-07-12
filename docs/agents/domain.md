# Domain Docs

How engineering skills should consume this repository's domain documentation.

## Before exploring

- Read `CONTEXT.md` at the repository root when it exists.
- Read ADRs under `docs/adr/` that touch the area being changed.
- If these files do not exist, proceed silently. The producer workflow creates them only when useful decisions or terminology emerge.

## Layout

This is a single-context repository:

```text
/
|-- CONTEXT.md
|-- docs/
|   `-- adr/
`-- src/
```

## Use domain vocabulary

Use terms as defined in `CONTEXT.md` in issue titles, proposals, hypotheses, and test names. If a needed concept is absent, reconsider whether new language is necessary or record the gap for a future domain-documentation session.

## Flag ADR conflicts

If proposed work contradicts an existing ADR, surface the conflict explicitly instead of silently overriding the decision.
