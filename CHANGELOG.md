## [0.6.0-dev.3](https://github.com/SplendidChip758/llama-paddock/compare/v0.6.0-dev.2...v0.6.0-dev.3) (2026-10-29)

### Bug Fixes

* harden the login lockout and restrict the agent environment editor ([#80](https://github.com/SplendidChip758/llama-paddock/issues/80)) ([177ac81](https://github.com/SplendidChip758/llama-paddock/commit/177ac81cbf596246d11fcb5846bbb70bc74b18ce))

## [0.6.0-dev.2](https://github.com/SplendidChip758/llama-paddock/compare/v0.6.0-dev.1...v0.6.0-dev.2) (2026-10-29)

### Features

* **dashboard:** show the dashboard and agent versions ([#70](https://github.com/SplendidChip758/llama-paddock/issues/70)) ([fcb7ed7](https://github.com/SplendidChip758/llama-paddock/commit/fcb7ed76448ce0e0faa2e3fe3bad81984a19779e)), closes [#4](https://github.com/SplendidChip758/llama-paddock/issues/4) [#47](https://github.com/SplendidChip758/llama-paddock/issues/47)

## [0.6.0-dev.1](https://github.com/SplendidChip758/llama-paddock/compare/v0.5.0...v0.6.0-dev.1) (2026-10-29)

### Features

* **dashboard:** add long-range history charts to the Monitor tab ([#63](https://github.com/SplendidChip758/llama-paddock/issues/63)) ([37a20b7](https://github.com/SplendidChip758/llama-paddock/commit/37a20b777a8cea81566624dad3145483c7da0e83)), closes [#4](https://github.com/SplendidChip758/llama-paddock/issues/4) [#4](https://github.com/SplendidChip758/llama-paddock/issues/4)

### Bug Fixes

* **install:** quiet the distro's login text only in a new CT ([#61](https://github.com/SplendidChip758/llama-paddock/issues/61)) ([14fef21](https://github.com/SplendidChip758/llama-paddock/commit/14fef2196f2d243e5e786872c56c53eda09c113a))
* **install:** refresh the login banner on updates ([#58](https://github.com/SplendidChip758/llama-paddock/issues/58)) ([e944987](https://github.com/SplendidChip758/llama-paddock/commit/e944987e1b8f3484cbd16cfba63c269026b05f63))

## [0.5.0](https://github.com/SplendidChip758/llama-paddock/compare/v0.4.0...v0.5.0) (2026-10-29)

### Features

* **dashboard:** persist metric history and jobs in SQLite ([182d025](https://github.com/SplendidChip758/llama-paddock/commit/182d0256eb8a0258adb8586e38b5edb2e4bc18df)), closes [#3](https://github.com/SplendidChip758/llama-paddock/issues/3)
* **install:** add a login banner and Proxmox notes to the dashboard CT ([2d6451d](https://github.com/SplendidChip758/llama-paddock/commit/2d6451d37be8658d841d46586ddc7c2595509064))
* **install:** add a prerelease installer with a disclaimer ([9bf2cde](https://github.com/SplendidChip758/llama-paddock/commit/9bf2cde0c5e802739c5dc177998353349eee7a3d))
* **install:** offer to let the dashboard reach Ollama ([#57](https://github.com/SplendidChip758/llama-paddock/issues/57)) ([186f09d](https://github.com/SplendidChip758/llama-paddock/commit/186f09d9e7f98f797c3a0dd6377d46185a0cc5cf))

### Bug Fixes

* **agent-linux:** find nvidia-smi on WSL ([#56](https://github.com/SplendidChip758/llama-paddock/issues/56)) ([b4af67a](https://github.com/SplendidChip758/llama-paddock/commit/b4af67a6881fced01181064f0d9ae160d77c0aa2))
* **agent-windows:** start when agent.json has a UTF-8 BOM ([#55](https://github.com/SplendidChip758/llama-paddock/issues/55)) ([84fb0a3](https://github.com/SplendidChip758/llama-paddock/commit/84fb0a3a95091092ed58d9adb5457835b0990b4c))
* **install:** align the login banner and skip Ubuntu's legal notice ([#53](https://github.com/SplendidChip758/llama-paddock/issues/53)) ([be20e9c](https://github.com/SplendidChip758/llama-paddock/commit/be20e9cc907d0176e5a5b5ad166c2321432bcfba))
* **install:** describe bridges by their ports, not the host's IP ([21f7e9a](https://github.com/SplendidChip758/llama-paddock/commit/21f7e9ae0b5bf4d59f44e887b61fd71aa29651ca))
* **install:** size the CT notes logo and use the console login mode ([f64df57](https://github.com/SplendidChip758/llama-paddock/commit/f64df578df03fc55dfd5a7af0b9bfa89e8b7df76))

## [0.5.0-dev.4](https://github.com/SplendidChip758/llama-paddock/compare/v0.5.0-dev.3...v0.5.0-dev.4) (2026-10-28)

### Bug Fixes

* **agent-linux:** find nvidia-smi on WSL ([#56](https://github.com/SplendidChip758/llama-paddock/issues/56)) ([b4af67a](https://github.com/SplendidChip758/llama-paddock/commit/b4af67a6881fced01181064f0d9ae160d77c0aa2))

## [0.5.0-dev.3](https://github.com/SplendidChip758/llama-paddock/compare/v0.5.0-dev.2...v0.5.0-dev.3) (2026-10-28)

### Bug Fixes

* **agent-windows:** start when agent.json has a UTF-8 BOM ([#55](https://github.com/SplendidChip758/llama-paddock/issues/55)) ([84fb0a3](https://github.com/SplendidChip758/llama-paddock/commit/84fb0a3a95091092ed58d9adb5457835b0990b4c))
* **install:** align the login banner and skip Ubuntu's legal notice ([#53](https://github.com/SplendidChip758/llama-paddock/issues/53)) ([be20e9c](https://github.com/SplendidChip758/llama-paddock/commit/be20e9cc907d0176e5a5b5ad166c2321432bcfba))

## [0.5.0-dev.2](https://github.com/SplendidChip758/llama-paddock/compare/v0.5.0-dev.1...v0.5.0-dev.2) (2026-10-28)

### Features

* **install:** add a login banner and Proxmox notes to the dashboard CT ([2d6451d](https://github.com/SplendidChip758/llama-paddock/commit/2d6451d37be8658d841d46586ddc7c2595509064))
* **install:** add a prerelease installer with a disclaimer ([9bf2cde](https://github.com/SplendidChip758/llama-paddock/commit/9bf2cde0c5e802739c5dc177998353349eee7a3d))

### Bug Fixes

* **install:** describe bridges by their ports, not the host's IP ([21f7e9a](https://github.com/SplendidChip758/llama-paddock/commit/21f7e9ae0b5bf4d59f44e887b61fd71aa29651ca))
* **install:** size the CT notes logo and use the console login mode ([f64df57](https://github.com/SplendidChip758/llama-paddock/commit/f64df578df03fc55dfd5a7af0b9bfa89e8b7df76))

## [0.5.0-dev.1](https://github.com/SplendidChip758/llama-paddock/compare/v0.4.0...v0.5.0-dev.1) (2026-10-28)

### Features

* **dashboard:** persist metric history and jobs in SQLite ([182d025](https://github.com/SplendidChip758/llama-paddock/commit/182d0256eb8a0258adb8586e38b5edb2e4bc18df)), closes [#3](https://github.com/SplendidChip758/llama-paddock/issues/3)

## [0.4.0](https://github.com/SplendidChip758/llama-paddock/compare/v0.3.0...v0.4.0) (2026-10-27)

### Features

* **install:** add uninstallers for the agent and dashboard ([d81a60a](https://github.com/SplendidChip758/llama-paddock/commit/d81a60a17b5e023031142270f1f48f81e7422cd2))

### Bug Fixes

* improve URL validation and user feedback in HostEditor component ([5af2060](https://github.com/SplendidChip758/llama-paddock/commit/5af2060be7875c81d807a9bff22f6b2a60b6e552))

## [0.3.0](https://github.com/SplendidChip758/llama-paddock/compare/v0.2.0...v0.3.0) (2026-10-27)

### Features

* add dev branch for prereleases and update release workflow ([37ac732](https://github.com/SplendidChip758/llama-paddock/commit/37ac7328ac88ca1c26ddc12eef9b689372a0203d))

## [0.2.0](https://github.com/SplendidChip758/llama-paddock/compare/v0.1.1...v0.2.0) (2026-10-27)

### Features

* add hosts from the UI and a sign-in page ([39d42f6](https://github.com/SplendidChip758/llama-paddock/commit/39d42f6b401f24e0d1f0c825ce6369e024712d5c))
* **install:** choose Ubuntu LTS (default) or Debian for the Proxmox LXC ([6b9e6a7](https://github.com/SplendidChip758/llama-paddock/commit/6b9e6a7bc90c95efb252bca16e5469d3566a1f97))

### Bug Fixes

* **install:** silence locale and NodeSource noise in Proxmox installs ([e01907e](https://github.com/SplendidChip758/llama-paddock/commit/e01907ebb2285243d16b4d454fedfe3cf5dfcefb))

## [0.1.1](https://github.com/SplendidChip758/llama-paddock/compare/v0.1.0...v0.1.1) (2026-10-27)

### Bug Fixes

* **dashboard:** report the real version from /api/healthz ([a40dfc3](https://github.com/SplendidChip758/llama-paddock/commit/a40dfc3516035d76826d4844d5a5ded3de26c78e))

## [0.1.0](https://github.com/SplendidChip758/llama-paddock/compare/v0.0.0...v0.1.0) (2026-10-27)

### Features

* add initial implementation of llama-paddock agent and dashboard installers ([d65a584](https://github.com/SplendidChip758/llama-paddock/commit/d65a5841b7b9879a609a5ae3e9963802bcc635a5))
