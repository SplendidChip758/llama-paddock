// The simulator's control API, for tests that make a host fail on purpose.
export async function scenario(id, patch) {
  const r = await fetch(`${process.env.PADDOCK_E2E_SIM}/hosts/${id}/scenario`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`sim scenario ${id}: ${r.status} ${await r.text()}`);
  return r.json();
}
