# Security

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting feature on this repository instead.

Include the affected command, reproduction steps, expected impact, and any suggested mitigation. Reports will be acknowledged as soon as practical.

## Trust model

Muxtra executes commands declared by the repository's `.muxtra/project.yaml` contract. Review that file before running `muxtra bootstrap --apply` or `muxtra dev` in an untrusted repository.

The CLI does not store provider credentials. Provider authentication and environment retrieval remain delegated to the provider's own command-line tools.
