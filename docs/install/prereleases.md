# Prereleases

> [!WARNING]
> Prereleases are for testing. They are built from every change merged to `dev`, before it is released as stable, so features may be unfinished and there may be bugs, including ones that lose metric history or settings. The data format can change between prereleases, so going back to stable may mean waiting for the next stable release.

To try the newest prerelease (`vX.Y.Z-dev.N`), use the prerelease installer. It works like the [one-liner](dashboard.md), with the same options, but shows this disclaimer and asks before installing:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/SplendidChip758/llama-paddock/dev/install/dashboard-dev.sh)"
```

`update-llama-paddock` then stays on prereleases. To go back to stable, re-run the normal one-liner. With Docker, use the `:dev` image tag instead.
