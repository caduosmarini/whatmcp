# CI bootstrap

`ci.yml` installs locked npm dependencies and runs the existing backend tests on
Ubuntu for pull requests, pushes to `main`, and manual runs. Node is pinned to
22.23.2. Tests use temporary fixture data; no production archive or API key is
needed.

`desktop-bootstrap.yml` is manual only. In GitHub Actions, select **Desktop
bootstrap → Run workflow**. It runs the backend tests on macOS ARM64 and Windows
x64, checks Node/SQLite and the runner architecture, and uploads a small JSON
manifest retained for seven days.

The manifest explicitly has `appBuilt: false`. There is no React/Tauri project
in this repository yet, so this workflow does not generate an app, installer,
or release. Add the desktop packaging commands before the manifest/upload steps
when the app is ready; then replace the manifest artifact with the actual bundle.
Signing and release publication should use a separate, explicitly invoked
workflow. The current workflows have read-only repository permissions and use
no signing credentials.

CI runs when this change opens or updates a pull request. Merge the workflows
into `main` before using the manual workflow's **Run workflow** button: GitHub
requires a dispatchable workflow to exist on the repository's default branch.
No secrets or self-hosted runners need to be configured for this bootstrap.
