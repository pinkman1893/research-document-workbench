# Security policy

## Reporting

Please report suspected vulnerabilities privately through the repository's GitHub Security Advisories. Do not open a public issue containing an exploit, API Key, private paper, note, chat transcript, or browser database.

Include the affected browser and operating system, reproduction steps, expected/actual behavior, and a minimal non-sensitive fixture when possible.

## Data model

The application has no backend. Papers and workspace data live in IndexedDB; model profiles, including an optional API Key, live in localStorage for `http://localhost:8642`. Requests go directly from the browser to the configured model endpoint.

Do not publish browser profiles, `.rdwb` backups, real API responses, or screenshots containing private paper content. Manual backups exclude API Keys by default; an export created with “include API Key” enabled contains credentials and must be handled as sensitive data. Automatic browser snapshots never include API Keys. Use a dedicated low-privilege key for local testing and configure only trusted HTTPS endpoints.

## Supported version

Security fixes currently target the latest commit on the default branch. Vendored dependencies are reviewed and updated as part of releases.
