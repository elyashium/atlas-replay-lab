import { genericManifest } from "./generic.manifest.js";
import { hashManifest } from "./atlas-orbital.manifest.js";

/** The generic measurement contract with the target journey as its declared end path. */
export function createTargetManifest() {
  const { contentHash, ...base } = genericManifest;
  const transitions = base.invariants.interaction.allowedTransitions.map((pair) => [...pair]);
  transitions.push(["interactive", "session-complete"]);
  return hashManifest({
    ...base,
    id: "atlas-owned-target",
    version: "1.0.0",
    title: "Owned staging target",
    description: "Generic browser measurements with a versioned customer-declared staging journey.",
    invariants: {
      ...base.invariants,
      interaction: { ...base.invariants.interaction, allowedTransitions: transitions },
    },
  });
}
