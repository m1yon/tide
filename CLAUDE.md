Default to using Bun instead of Node.js.

## Testing

- Test behavior through public interfaces, not implementation details. Refactoring internals shouldn't break tests.
- Avoid mocks and stubs. Prefer real dependencies, in-memory fakes, or thin hand-written test doubles at module boundaries.
- Each test should fail for one reason. Name tests by the behavior they assert, not the function they call.
- Let tests drive design: if something is hard to test, the production code likely needs restructuring — don't paper over it with mocking frameworks.

## Agent skills

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
