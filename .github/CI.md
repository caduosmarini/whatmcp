# Continuous integration

`ci.yml` runs offline backend/desktop fixture tests on Ubuntu for PRs/main/manual
runs. No production database, provider credentials or self-hosted runner is needed.

`desktop-build.yml` builds actual macOS ARM64 `.dmg` and Windows x64 NSIS `.exe`
installers on hosted runners for PRs/main/manual runs. It bundles Node, backend
dependencies and native macOS helpers, tests synthetic fixtures, checks the packaged
macOS runtime/staged Windows runtime, and uploads installers with commit-specific
artifact names plus a build manifest. It publishes no release and performs no merge.

`desktop-update-packages.yml` is manual and skips without the repository's approved
updater public key. It requires a separately approved protected private-key secret
to produce signed updater artifacts. It creates no credentials and publishes nothing.
See [desktop build and update setup](../desktop/README.md).

No manual configuration is required for default unsigned installer builds. Before
publishing updates, configure the approved signing variables/secrets and release feed.
Live FDA, Windows collection, provider transcription, installer UX and update lifecycle
validation use disposable VMs and remain separate from fixture CI.
