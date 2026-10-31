# CI integration

`agent-verify.yml` is a standalone template for a repository without CI. It:

1. checks out the full history (for gitleaks history and impact ranges);
2. installs pinned scanner versions using Go's checksum database and pip;
3. runs `eng verify --profile full --ci`;
4. uploads `.agents/evidence/` even on failure.

## Existing CI

Do not replace working CI. Add one step after the existing toolchain setup:

```yaml
      - name: Engineering verification
        run: ./.agents/bin/eng verify --profile full --ci
```

Add the scanner installation step from the template (or use equivalent pinned actions), and upload
the evidence directory.

## Requirements

- The commands in `.agents/engineering.json` must be runnable on the runner.
- Required scanners (`security.required`) must be installed, or the gate correctly reports
  `blocked`.
- The checkout must include `.agents/` and the repository's toolchain.
- Do not grant `contents: write` or secrets to this job unless a specific step needs it.

## Pinning

The template pins `actions/checkout`, `actions/setup-python` and `actions/upload-artifact` to commit
SHAs with the release tag in a comment. Scanner versions are pinned in the `run:` block. When
updating, verify the checksum/source, change the version and re-run the fixture; do not use `@master`
or a floating `@vN` tag.
