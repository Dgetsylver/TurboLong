# Evidence — gitleaks blocks a planted secret (SCF T1 D5)

Proof that the repo's secret-scanning gate (`.gitleaks.toml` custom rule
`stellar-secret-key`, enforced by `secret-scan.yml` in CI and the
`pre-commit` hook locally) detects a hardcoded Stellar secret key.

The planted key below is **fake** (prefix `SDEMOGITLEAKS…`, random base32 tail,
never funded) and is **redacted** here so this evidence file does not itself
trip the scanner.

## Command

```
# planted fake key in a throwaway file (NOT committed to the repo):
#   DEPLOY_SECRET_KEY=SDEMOGITLEAKS<43 random base32 chars>   (56 chars, matches S[A-Z2-7]{55})
gitleaks detect --no-git --source /tmp/gldemo -c .gitleaks.toml -v
```

## Result (gitleaks v8.30.1)

```
Finding:     DEPLOY_SECRET_KEY=SDEMOGITLEAKS<redacted>
Secret:      SDEMOGITLEAKS<redacted>
RuleID:      stellar-secret-key
Entropy:     4.624057
Tags:        [stellar key secret]
File:        /tmp/gldemo/leaked.env
Line:        1
Fingerprint: /tmp/gldemo/leaked.env:stellar-secret-key:1

INF scanned ~75 bytes (75 bytes) in 21.3ms
WRN leaks found: 1
```

**Exit code: 1** — a non-zero exit fails the `secret-scan.yml` job, blocking the
PR. The same rule runs in the local `pre-commit` hook (`pre-commit run gitleaks`)
before a commit can be created.

> Method: local block proof — relies on the security control, does not bypass
> it (no `--no-verify`, nothing pushed). The planted file lived only in `/tmp`
> and was deleted after the scan.
