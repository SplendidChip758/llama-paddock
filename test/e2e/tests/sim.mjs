// The simulator's control API, for tests that make a host fail on purpose.
export async function scenario(id, patch) {
  const r = await fetch(`${process.env.PADDOCK_E2E_SIM}/hosts/${id}/scenario`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`sim scenario ${id}: ${r.status} ${await r.text()}`);
  return r.json();
}

/** Replace the simulated agent releases (GitHub's), e.g. to make the hosts' agents outdated. */
export async function agentReleases(linux) {
  const r = await fetch(`${process.env.PADDOCK_E2E_SIM}/github/releases`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ linux }),
  });
  if (!r.ok) throw new Error(`sim releases: ${r.status} ${await r.text()}`);
}

/** Replace the simulated dashboard releases (GitHub's), e.g. to offer a dashboard update. */
export async function dashboardReleases(dashboard) {
  const r = await fetch(`${process.env.PADDOCK_E2E_SIM}/github/releases`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dashboard }),
  });
  if (!r.ok) throw new Error(`sim releases: ${r.status} ${await r.text()}`);
}

export async function hostState(id) {
  const r = await fetch(`${process.env.PADDOCK_E2E_SIM}/hosts/${id}`);
  if (!r.ok) throw new Error(`sim host ${id}: ${r.status} ${await r.text()}`);
  return r.json();
}
