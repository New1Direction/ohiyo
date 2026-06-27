## Summary

<!-- What changed and why? -->

## Testing

- [ ] Client lint/typecheck/unit/build (`cd client && npm run lint && npm run typecheck && npm run test:unit && npm run build`)
- [ ] Server fmt/clippy/tests (`cd server && cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked`)
- [ ] E2E coverage added/updated or not needed
- [ ] Manual smoke tested if user-facing

## Security / privacy checklist

- [ ] No plaintext secrets/tokens logged or committed
- [ ] Authz/access boundary considered
- [ ] E2E-encrypted content remains ciphertext server-side where applicable
- [ ] User-provided URLs/files are validated/sandboxed where applicable

## Screenshots / recordings

<!-- For UI changes, attach before/after screenshots. -->
